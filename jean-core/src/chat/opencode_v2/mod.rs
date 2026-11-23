//! OpenCode 2.x chat turns. 2.x replaced the 1.x HTTP API: prompts go to a
//! session inbox and return at once, and the turn ends with a
//! `session.execution.*` event on `/api/event`.

mod client;
mod forms;
mod steer;
mod stream;
mod turn;

pub use client::V2Client;
pub use forms::answer_question;
pub use steer::steer;

use super::opencode::{
    agent_for_execution_mode, emit_backend_retry, emit_chat_chunk, emit_chat_done, emit_chat_error,
    emit_chat_thinking, emit_chat_tool_result, emit_chat_tool_use, emit_permission_replied,
    normalize_opencode_tool, parse_provider_model, permission_rules,
    should_auto_approve_opencode_permissions, structured_output_text_prompt, variant_for_effort,
    OpenCodeResponse,
};
use super::types::OpenCodePermissionRequestEvent;
use super::types::OpenCodeTurnRef;
use crate::http_server::EmitExt;
use crate::opencode_server::OpenCodeServer;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};
use stream::StreamMsg;
use tauri::AppHandle;
use turn::{Outcome, TurnEmit, TurnResult, TurnState};

const INSTRUCTIONS_KEY: &str = "jean";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Give up when the event stream stays down this long.
const DISCONNECT_LIMIT: Duration = Duration::from_secs(30);
/// Same limit as the blocking 1.x `/message` request.
const TURN_TIMEOUT: Duration = Duration::from_secs(1800);
const INTERRUPT_SETTLE: Duration = Duration::from_secs(3);
/// Same limit as the 1.x one-shot request.
const ONE_SHOT_TIMEOUT: Duration = Duration::from_secs(600);

pub struct TurnRequest<'a> {
    pub session_id: &'a str,
    pub worktree_id: &'a str,
    pub run_id: &'a str,
    pub working_dir: &'a Path,
    pub existing_opencode_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub reasoning_effort: Option<&'a str>,
    pub prompt: &'a str,
    pub system_prompt: Option<&'a str>,
}

/// Jean's 1.x permission rules (`permission`/`pattern`/`action`) in the 2.x
/// shape (`action`/`resource`/`effect`). Action names are the same in both.
fn v2_permission_rules(mode: &str, read_only_code: bool) -> Option<Value> {
    let rules = permission_rules(mode, read_only_code)?;
    Some(Value::Array(
        rules
            .as_array()?
            .iter()
            .map(|rule| {
                json!({
                    "action": rule["permission"],
                    "resource": rule["pattern"],
                    "effect": rule["action"],
                })
            })
            .collect(),
    ))
}

fn v2_model(model: Option<&str>, reasoning_effort: Option<&str>) -> Option<Value> {
    let (provider, model_id) = parse_provider_model(model)?;
    let mut value = json!({ "id": model_id, "providerID": provider });
    if let Some(variant) = variant_for_effort(reasoning_effort) {
        value["variant"] = json!(variant);
    }
    Some(value)
}

fn cancelled_response(session_id: String, state: TurnState) -> OpenCodeResponse {
    let result = state.finish();
    OpenCodeResponse {
        content: result.content,
        session_id,
        tool_calls: result.tool_calls,
        content_blocks: result.content_blocks,
        cancelled: true,
        usage: None,
    }
}

/// Reuse the resumed session when the server still has it; otherwise
/// create one. Returns the session id.
fn prepare_session(client: &V2Client, req: &TurnRequest<'_>) -> Result<String, String> {
    let mode = req.execution_mode.unwrap_or("build");
    let agent = agent_for_execution_mode(req.execution_mode);
    let model = v2_model(req.model, req.reasoning_effort);
    let rules = v2_permission_rules(mode, crate::agents::code_is_read_only(req.worktree_id));

    if let Some(existing) = req.existing_opencode_session_id {
        let configured = client.set_agent(existing, agent).and_then(|()| {
            if let Some(model) = &model {
                client.set_model(existing, model.clone())?;
            }
            if let Some(rules) = &rules {
                client.set_permissions(existing, rules.clone())?;
            }
            Ok(())
        });
        match configured {
            Ok(()) => return Ok(existing.to_string()),
            // A 1.x session id, or a session deleted on the server.
            Err(e) if e.contains("SessionNotFoundError") => {
                log::info!("OpenCode: session {existing} not found on 2.x server, creating one");
            }
            Err(e) => return Err(e),
        }
    }

    let mut body = json!({
        "location": { "directory": req.working_dir.to_string_lossy() },
        "agent": agent,
    });
    if let Some(model) = model {
        body["model"] = model;
    }
    if let Some(rules) = rules {
        body["permissions"] = rules;
    }
    client.create_session(body)
}

pub fn execute_turn(
    app: &AppHandle,
    server: &OpenCodeServer,
    req: TurnRequest<'_>,
    cancelled: &Arc<AtomicBool>,
) -> Result<OpenCodeResponse, String> {
    let client = V2Client::new(server, Duration::from_secs(60))?;
    let opencode_session_id = prepare_session(&client, &req)?;
    let working_dir = req.working_dir.to_string_lossy().to_string();
    super::registry::update_cancel_flag_context(
        req.session_id,
        opencode_session_id.clone(),
        working_dir.clone(),
    );

    let mut text = req.prompt.to_string();
    if let Some(system) = req.system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        if let Err(e) = client.set_instructions(&opencode_session_id, INSTRUCTIONS_KEY, system) {
            log::warn!("OpenCode: instructions entry failed ({e}); sending system prompt inline");
            text = format!("{system}\n\n{text}");
        }
    }

    let mut state = TurnState::new(&opencode_session_id);
    let events = stream::open(server);
    if !wait_connected(&events, cancelled)? {
        return Ok(cancelled_response(opencode_session_id, state));
    }

    let inbox_id = client.prompt(&opencode_session_id, &text, "steer")?;
    record_turn(app, &req, &opencode_session_id, &inbox_id);
    state.expect_delivery(inbox_id);
    let _active_turn = steer::ActiveTurn::register(&opencode_session_id);
    log::info!(
        "OpenCode 2.x: prompt queued jean_session={} opencode_session={opencode_session_id}",
        req.session_id
    );
    super::commands::trigger_opencode_queue_steer(
        app.clone(),
        req.worktree_id.to_string(),
        working_dir.clone(),
        req.session_id.to_string(),
    );

    let outcome = wait_for_outcome(
        &client,
        &events,
        &mut state,
        &opencode_session_id,
        cancelled,
        TURN_TIMEOUT,
        |emit| handle_emit(app, &client, &req, emit),
    )?;
    finish_turn(
        app,
        &req,
        opencode_session_id,
        outcome,
        state.finish(),
        cancelled,
        true,
    )
}

/// The response for a turn that ended with `outcome` (`None`: Jean
/// cancelled it). With `notify`, emits `chat:done` or `chat:error`.
fn finish_turn(
    app: &AppHandle,
    req: &TurnRequest<'_>,
    opencode_session_id: String,
    outcome: Option<Outcome>,
    result: TurnResult,
    cancelled: &AtomicBool,
    notify: bool,
) -> Result<OpenCodeResponse, String> {
    let response = |cancelled: bool, result: TurnResult| OpenCodeResponse {
        content: result.content,
        session_id: opencode_session_id.clone(),
        tool_calls: result.tool_calls,
        content_blocks: result.content_blocks,
        cancelled,
        usage: if cancelled { None } else { result.usage },
    };
    match outcome {
        None => Ok(response(true, result)),
        Some(Outcome::Failed(error)) => {
            if notify {
                emit_chat_error(app, req.session_id, req.worktree_id, &error);
            }
            Err(error)
        }
        // 2.x also interrupts the execution when the user rejects a
        // permission. As on 1.x, that ends the turn; only a Jean cancel
        // makes it a cancelled turn.
        Some(_) if cancelled.load(Ordering::SeqCst) => Ok(response(true, result)),
        Some(_) => {
            if notify {
                emit_chat_done(
                    app,
                    req.session_id,
                    req.worktree_id,
                    req.execution_mode == Some("plan") && !result.content.is_empty(),
                );
            }
            Ok(response(false, result))
        }
    }
}

/// Store the turn on its run, so a restarted Jean can re-attach to it. Only
/// a recorded turn may survive Jean quitting.
fn record_turn(app: &AppHandle, req: &TurnRequest<'_>, opencode_session_id: &str, prompt_id: &str) {
    let turn = OpenCodeTurnRef {
        session_id: opencode_session_id.to_string(),
        prompt_id: prompt_id.to_string(),
    };
    let recorded = super::run_log::RunLogWriter::resume(app, req.session_id, req.run_id)
        .and_then(|mut writer| writer.set_opencode_turn(turn));
    match recorded {
        Ok(()) if cfg!(unix) => super::registry::mark_cancel_flag_survivable(req.session_id),
        Ok(()) => {}
        Err(e) => log::warn!("OpenCode: could not record the turn for recovery: {e}"),
    }
}

/// History items read to rebuild a turn after a restart (the 2.x maximum
/// page). An older part of a longer turn is not rebuilt.
const RESUME_HISTORY_LIMIT: u32 = 200;
/// A busy session keeps the wait call open; an idle one answers at once.
const IDLE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Re-attach to a turn that ran on the server while Jean was closed: show
/// requests that wait for the user, stream the rest of the turn, then
/// rebuild the whole reply from the session history. Does not emit
/// `chat:done`/`chat:error`: the caller does, after it saved the reply.
pub fn resume_turn(
    app: &AppHandle,
    server: &OpenCodeServer,
    req: TurnRequest<'_>,
    turn: &OpenCodeTurnRef,
    cancelled: &Arc<AtomicBool>,
) -> Result<OpenCodeResponse, String> {
    let client = V2Client::new(server, Duration::from_secs(60))?;
    let opencode_session_id = turn.session_id.clone();
    let working_dir = req.working_dir.to_string_lossy().to_string();
    super::registry::update_cancel_flag_context(
        req.session_id,
        opencode_session_id.clone(),
        working_dir.clone(),
    );
    if cfg!(unix) {
        super::registry::mark_cancel_flag_survivable(req.session_id);
    }

    let mut state = TurnState::new(&opencode_session_id);
    let events = stream::open(server);
    if !wait_connected(&events, cancelled)? {
        return Ok(cancelled_response(opencode_session_id, state));
    }
    state.expect_delivery(turn.prompt_id.clone());
    let history = client.history(&opencode_session_id, RESUME_HISTORY_LIMIT)?;
    state.resync(&history);

    let outcome = if state.outcome().is_some() {
        state.outcome().cloned()
    } else if execution_was_lost(server, &client, &opencode_session_id)? {
        // The server that ran the turn stopped (for example a reboot).
        log::warn!("OpenCode: turn {} was lost with its server", turn.prompt_id);
        Some(Outcome::Interrupted)
    } else {
        resurface_pending_requests(app, &client, &req, &history);
        let _active_turn = steer::ActiveTurn::register(&opencode_session_id);
        wait_for_outcome(
            &client,
            &events,
            &mut state,
            &opencode_session_id,
            cancelled,
            TURN_TIMEOUT,
            |emit| handle_emit(app, &client, &req, emit),
        )?
    };

    // Events cover only the time since the restart; history has it all.
    let result = client
        .history(&opencode_session_id, RESUME_HISTORY_LIMIT)
        .ok()
        .and_then(|history| turn::turn_from_history(&history, &turn.prompt_id))
        .map(|(_, result)| result)
        .unwrap_or_else(|| state.finish());
    finish_turn(
        app,
        &req,
        opencode_session_id,
        outcome,
        result,
        cancelled,
        false,
    )
}

/// True when the session runs no execution, has nothing queued, and still
/// shows no end of the turn: the execution died with an earlier server.
fn execution_was_lost(
    server: &OpenCodeServer,
    client: &V2Client,
    opencode_session_id: &str,
) -> Result<bool, String> {
    if !client.inbox(opencode_session_id)?.is_empty() {
        return Ok(false);
    }
    if !V2Client::new(server, IDLE_PROBE_TIMEOUT)?.is_idle(opencode_session_id)? {
        return Ok(false);
    }
    // The turn can have ended between the history read and the probe.
    let history = client.history(opencode_session_id, 1)?;
    Ok(history
        .first()
        .is_none_or(|latest| latest["type"] != "idle"))
}

/// Requests asked while Jean was closed have no event any more: show the
/// pending permissions, and the question tool calls whose forms wait.
fn resurface_pending_requests(
    app: &AppHandle,
    client: &V2Client,
    req: &TurnRequest<'_>,
    history: &[Value],
) {
    let session = req.existing_opencode_session_id.unwrap_or_default();
    let working_dir = Some(req.working_dir.to_string_lossy().to_string());
    for request in client.pending_permissions(session).unwrap_or_default() {
        let request = turn::permission_request(&request, working_dir.clone());
        handle_emit(app, client, req, TurnEmit::PermissionAsked(request));
    }
    for form in client.session_forms(session).unwrap_or_default() {
        let form_id = form["id"].as_str().unwrap_or_default();
        if form["metadata"]["kind"] != "question" {
            cancel_form(client, session, form_id);
            continue;
        }
        let tool_id = form["metadata"]["tool"]["id"].as_str().unwrap_or_default();
        let tool = history
            .iter()
            .filter_map(|message| message["content"].as_array())
            .flatten()
            .find(|item| item["type"] == "tool" && item["id"] == tool_id);
        match tool {
            Some(tool) => {
                let mut input = tool["state"]["input"].clone();
                let name = normalize_opencode_tool(
                    tool["name"].as_str().unwrap_or("question"),
                    &mut input,
                );
                let id = tool_id.to_string();
                handle_emit(app, client, req, TurnEmit::ToolUse { id, name, input });
            }
            None => cancel_form(client, session, form_id),
        }
    }
}

/// Wait for the event stream so no event of the coming prompt is missed.
/// `false` when Jean cancelled first.
fn wait_connected(events: &stream::EventStream, cancelled: &AtomicBool) -> Result<bool, String> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        match events.rx.recv_timeout(Duration::from_millis(100)) {
            Ok(StreamMsg::Connected) => return Ok(true),
            Ok(StreamMsg::Disconnected(reason)) => {
                log::warn!("OpenCode: event stream connect failed: {reason}");
            }
            Ok(StreamMsg::Event(_)) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("OpenCode event stream stopped".to_string())
            }
        }
        if Instant::now() > deadline {
            return Err("Could not connect to the OpenCode 2.x event stream".to_string());
        }
    }
}

/// Feed stream events into `state` until the turn ends. `None` when Jean
/// cancelled the turn (the server is asked to interrupt it).
fn wait_for_outcome(
    client: &V2Client,
    events: &stream::EventStream,
    state: &mut TurnState,
    opencode_session_id: &str,
    cancelled: &AtomicBool,
    timeout: Duration,
    mut on_emit: impl FnMut(TurnEmit),
) -> Result<Option<Outcome>, String> {
    let deadline = Instant::now() + timeout;
    let mut disconnected_since: Option<Instant> = None;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            interrupt_and_settle(client, events, state, opencode_session_id);
            return Ok(None);
        }
        if Instant::now() > deadline {
            interrupt_and_settle(client, events, state, opencode_session_id);
            return Err(format!(
                "OpenCode 2.x turn did not finish within {} minutes",
                timeout.as_secs() / 60
            ));
        }
        match events.rx.recv_timeout(Duration::from_millis(100)) {
            Ok(StreamMsg::Event(event)) => state.apply(&event).into_iter().for_each(&mut on_emit),
            Ok(StreamMsg::Connected) => {
                if disconnected_since.take().is_some() {
                    // End events may have fallen in the gap.
                    match client.messages(opencode_session_id) {
                        Ok(messages) => state.resync(&messages),
                        Err(e) => log::warn!("OpenCode: resync after reconnect failed: {e}"),
                    }
                }
            }
            Ok(StreamMsg::Disconnected(reason)) => {
                log::warn!("OpenCode: event stream lost ({reason}), reconnecting");
                let since = *disconnected_since.get_or_insert_with(Instant::now);
                if since.elapsed() > DISCONNECT_LIMIT {
                    return Err(format!("Lost the OpenCode 2.x event stream: {reason}"));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("OpenCode event stream stopped".to_string())
            }
        }
        for steer_id in steer::take_steers(opencode_session_id) {
            state.expect_delivery(steer_id);
        }
        if let Some(outcome) = state.outcome().cloned() {
            let late = steer::close_unless_steered(opencode_session_id);
            if late.is_empty() {
                return Ok(Some(outcome));
            }
            late.into_iter().for_each(|id| state.expect_delivery(id));
        }
    }
}

/// Interrupt the turn and wait briefly for its end event, so a message the
/// user sends right after a stop does not join the execution being stopped.
/// Events still update `state` (for the partial reply) but are not emitted.
fn interrupt_and_settle(
    client: &V2Client,
    events: &stream::EventStream,
    state: &mut TurnState,
    opencode_session_id: &str,
) {
    if let Err(e) = client.interrupt(opencode_session_id) {
        log::warn!("OpenCode: interrupt failed: {e}");
        return;
    }
    let deadline = Instant::now() + INTERRUPT_SETTLE;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(StreamMsg::Event(event)) = events.rx.recv_timeout(left) else {
            continue;
        };
        state.apply(&event);
        let ended = event["data"]["sessionID"] == opencode_session_id
            && event["type"].as_str().is_some_and(|kind| {
                kind.starts_with("session.execution.") && kind != "session.execution.started"
            });
        if ended {
            return;
        }
    }
}

fn handle_emit(app: &AppHandle, client: &V2Client, req: &TurnRequest<'_>, emit: TurnEmit) {
    let (session_id, worktree_id) = (req.session_id, req.worktree_id);
    match emit {
        TurnEmit::Chunk(text) => {
            emit_chat_chunk(app, session_id, worktree_id, Some(req.run_id), &text)
        }
        TurnEmit::Thinking(text) => emit_chat_thinking(app, session_id, worktree_id, &text),
        TurnEmit::ToolUse { id, name, input } => {
            emit_chat_tool_use(app, session_id, worktree_id, &id, &name, input)
        }
        TurnEmit::ToolResult { id, output } => {
            emit_chat_tool_result(app, session_id, worktree_id, &id, &output)
        }
        TurnEmit::Retry {
            attempt,
            at_ms,
            reason,
        } => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            emit_backend_retry(
                app,
                session_id,
                worktree_id,
                attempt,
                at_ms.saturating_sub(now_ms),
                reason,
            );
        }
        TurnEmit::PermissionAsked(mut request) => {
            if request.working_dir.is_none() {
                request.working_dir = Some(req.working_dir.to_string_lossy().to_string());
            }
            if should_auto_approve_opencode_permissions(app, session_id, req.execution_mode) {
                match client.reply_permission(
                    &request.opencode_session_id,
                    &request.request_id,
                    "always",
                    None,
                ) {
                    Ok(()) => return,
                    Err(e) => log::error!("OpenCode: yolo auto-approve failed: {e}"),
                }
            }
            let _ = app.emit_all(
                "chat:opencode_permission_request",
                &OpenCodePermissionRequestEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    request,
                },
            );
        }
        TurnEmit::PermissionReplied { request_id, reply } => emit_permission_replied(
            app,
            session_id.to_string(),
            worktree_id.to_string(),
            &request_id,
            reply,
        ),
        // The question tool call already reached the question UI as a tool
        // use; its answer replies to this form (`answer_question`).
        TurnEmit::FormCreated { question: true, .. } => {}
        TurnEmit::FormCreated {
            session_id: form_session,
            form_id,
            question: false,
        } => cancel_form(client, &form_session, &form_id),
    }
}

/// Jean has no UI for non-question 2.x forms. Cancel so the turn does not stall.
fn cancel_form(client: &V2Client, session_id: &str, form_id: &str) {
    log::warn!("OpenCode: cancelling unsupported 2.x form {form_id}");
    if let Err(e) = client.cancel_form(session_id, form_id) {
        log::warn!("OpenCode: form cancel failed: {e}");
    }
}

/// One prompt in a temporary read-only (`plan`) session, for magic prompts
/// and naming. Returns the reply text. 2.x has no structured output, so a
/// JSON schema becomes a strict-JSON instruction in the prompt; callers
/// extract the JSON from the text.
pub fn run_one_shot(
    server: &OpenCodeServer,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: &Path,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    let client = V2Client::new(server, Duration::from_secs(60))?;
    let mut body = json!({
        "location": { "directory": working_dir.to_string_lossy() },
        "agent": "plan",
    });
    if let Some(model) = v2_model(Some(model), reasoning_effort) {
        body["model"] = model;
    }
    let session_id = client.create_session(body)?;
    let result = one_shot_in_session(&client, server, &session_id, prompt, json_schema);
    if let Err(e) = client.delete_session(&session_id) {
        log::warn!("OpenCode: could not delete one-shot session {session_id}: {e}");
    }
    result
}

fn one_shot_in_session(
    client: &V2Client,
    server: &OpenCodeServer,
    session_id: &str,
    prompt: &str,
    json_schema: Option<&str>,
) -> Result<String, String> {
    let text = match json_schema {
        Some(schema) => structured_output_text_prompt(prompt, schema),
        None => prompt.to_string(),
    };
    let not_cancelled = AtomicBool::new(false);
    let mut state = TurnState::new(session_id);
    let events = stream::open(server);
    wait_connected(&events, &not_cancelled)?;
    state.expect_delivery(client.prompt(session_id, &text, "steer")?);
    let outcome = wait_for_outcome(
        client,
        &events,
        &mut state,
        session_id,
        &not_cancelled,
        ONE_SHOT_TIMEOUT,
        |emit| match emit {
            // Nobody can answer: a one-shot has no UI.
            TurnEmit::PermissionAsked(request) => {
                if let Err(e) = client.reply_permission(
                    &request.opencode_session_id,
                    &request.request_id,
                    "reject",
                    Some("Not available in a one-shot request"),
                ) {
                    log::warn!("OpenCode: one-shot permission reject failed: {e}");
                }
            }
            TurnEmit::FormCreated {
                session_id,
                form_id,
                ..
            } => cancel_form(client, &session_id, &form_id),
            _ => {}
        },
    )?;
    match outcome {
        Some(Outcome::Succeeded) => {}
        Some(Outcome::Failed(error)) => return Err(error),
        Some(Outcome::Interrupted) | None => {
            return Err("OpenCode one-shot was interrupted".to_string())
        }
    }
    let content = state.finish().content;
    if content.trim().is_empty() {
        return Err("Empty response from OpenCode".to_string());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Model for the live tests: `OPENCODE_V2_MODEL` (`provider/model`),
    /// or the free `opencode/big-pickle`.
    fn live_model() -> String {
        std::env::var("OPENCODE_V2_MODEL").unwrap_or_else(|_| "opencode/big-pickle".to_string())
    }

    /// Runs real turns against a live 2.x server, through the same session,
    /// stream, prompt and wait code as `execute_turn`. Needs network access
    /// for the free `opencode/big-pickle` model:
    /// `OPENCODE_V2_URL=http://127.0.0.1:4096 OPENCODE_V2_PASSWORD=... OPENCODE_V2_DIR=/tmp/x \
    ///  cargo test --lib live_v2_turn -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_v2_turn() {
        let server = OpenCodeServer {
            url: std::env::var("OPENCODE_V2_URL").unwrap(),
            api: crate::opencode_server::OpenCodeApi::V2,
            password: std::env::var("OPENCODE_V2_PASSWORD").ok(),
        };
        let dir = std::path::PathBuf::from(std::env::var("OPENCODE_V2_DIR").unwrap());
        std::fs::write(dir.join("live.txt"), "pineapple\n").unwrap();
        let client = V2Client::new(&server, Duration::from_secs(60)).unwrap();
        let model = live_model();
        let request = |existing, prompt, mode| TurnRequest {
            session_id: "jean",
            worktree_id: "wt",
            run_id: "run",
            working_dir: &dir,
            existing_opencode_session_id: existing,
            model: Some(model.as_str()),
            execution_mode: Some(mode),
            reasoning_effort: None,
            prompt,
            system_prompt: None,
        };
        let run = |req: &TurnRequest<'_>, cancel_after: Option<Duration>| {
            let session = prepare_session(&client, req).unwrap();
            let mut state = TurnState::new(&session);
            let events = stream::open(&server);
            let cancelled = Arc::new(AtomicBool::new(false));
            assert!(
                wait_connected(&events, &cancelled).unwrap(),
                "stream connected"
            );
            state.expect_delivery(client.prompt(&session, req.prompt, "steer").unwrap());
            if let Some(delay) = cancel_after {
                let flag = cancelled.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    flag.store(true, Ordering::SeqCst);
                });
            }
            let mut emits = Vec::new();
            let outcome = wait_for_outcome(
                &client,
                &events,
                &mut state,
                &session,
                &cancelled,
                TURN_TIMEOUT,
                |e| emits.push(e),
            )
            .unwrap();
            (session, outcome, emits, state.finish())
        };

        let first = request(
            None,
            "Read the file live.txt with your read tool, then reply with its content only.",
            "build",
        );
        let (session, outcome, emits, result) = run(&first, None);
        println!("emits: {emits:?}");
        assert_eq!(outcome, Some(Outcome::Succeeded));
        assert!(result
            .tool_calls
            .iter()
            .any(|t| t.name == "Read" && t.output.as_deref().unwrap_or("").contains("pineapple")));
        assert!(
            result.content.to_lowercase().contains("pineapple"),
            "{}",
            result.content
        );
        assert!(result.usage.is_some(), "usage from step.ended");

        let history = client.messages(&session).unwrap();
        let prompt_id = history
            .iter()
            .find(|m| m["type"] == "user")
            .and_then(|m| m["id"].as_str())
            .unwrap()
            .to_string();
        let mut missed = TurnState::new(&session);
        missed.expect_delivery(prompt_id);
        missed.resync(&history);
        assert_eq!(
            missed.outcome(),
            Some(&Outcome::Succeeded),
            "resync from history"
        );

        let resumed = request(
            Some(&session),
            "What word did the file contain? Reply with the word only.",
            "plan",
        );
        let (resumed_session, outcome, _, result) = run(&resumed, None);
        assert_eq!(resumed_session, session, "resume keeps the session");
        assert_eq!(outcome, Some(Outcome::Succeeded));
        assert!(
            result.content.to_lowercase().contains("pineapple"),
            "{}",
            result.content
        );

        let stale = request(Some("ses_doesnotexist"), "Reply OK.", "build");
        let (fresh, outcome, _, _) = run(&stale, None);
        assert_ne!(
            fresh, "ses_doesnotexist",
            "unknown resume id gets a new session"
        );
        assert_eq!(outcome, Some(Outcome::Succeeded));

        let long = request(None, "Write a 1500 word essay about rivers.", "build");
        let (_, outcome, _, _) = run(&long, Some(Duration::from_secs(4)));
        assert_eq!(outcome, None, "Jean cancel returns before the turn ends");
    }

    /// The calls Jean uses to re-attach after a restart, on an idle session.
    /// Needs no inference. Same environment as `live_v2_turn`.
    #[test]
    #[ignore]
    fn live_v2_resume_probes() {
        let server = OpenCodeServer {
            url: std::env::var("OPENCODE_V2_URL").unwrap(),
            api: crate::opencode_server::OpenCodeApi::V2,
            password: std::env::var("OPENCODE_V2_PASSWORD").ok(),
        };
        let dir = std::env::var("OPENCODE_V2_DIR").unwrap();
        let client = V2Client::new(&server, Duration::from_secs(30)).unwrap();
        let session = client
            .create_session(json!({ "location": { "directory": dir }, "agent": "build" }))
            .unwrap();
        assert!(client.inbox(&session).unwrap().is_empty());
        assert!(client.pending_permissions(&session).unwrap().is_empty());
        assert!(client.session_forms(&session).unwrap().is_empty());
        assert!(client
            .history(&session, RESUME_HISTORY_LIMIT)
            .unwrap()
            .is_empty());
        let probe = V2Client::new(&server, IDLE_PROBE_TIMEOUT).unwrap();
        assert!(probe.is_idle(&session).unwrap());
        // A turn whose prompt never ran, on an idle session: lost.
        assert!(execution_was_lost(&server, &client, &session).unwrap());
        client.delete_session(&session).unwrap();
    }

    /// Jean quits during a turn and re-attaches with `resume_turn`: while
    /// the turn still runs, after it ended, and while a permission waits.
    /// Same environment as `live_v2_turn`.
    #[test]
    #[ignore]
    fn live_v2_restart() {
        let server = OpenCodeServer {
            url: std::env::var("OPENCODE_V2_URL").unwrap(),
            api: crate::opencode_server::OpenCodeApi::V2,
            password: std::env::var("OPENCODE_V2_PASSWORD").ok(),
        };
        let dir = std::path::PathBuf::from(std::env::var("OPENCODE_V2_DIR").unwrap());
        let data = tempfile::tempdir().unwrap();
        let app = AppHandle::new(data.path().to_path_buf(), data.path().to_path_buf()).unwrap();
        let client = V2Client::new(&server, Duration::from_secs(60)).unwrap();
        let probe = V2Client::new(&server, IDLE_PROBE_TIMEOUT).unwrap();
        let model = live_model();
        let request = |existing, prompt, mode| TurnRequest {
            session_id: "jean",
            worktree_id: "wt",
            run_id: "run",
            working_dir: &dir,
            existing_opencode_session_id: existing,
            model: Some(model.as_str()),
            execution_mode: Some(mode),
            reasoning_effort: None,
            prompt,
            system_prompt: None,
        };
        // Start the turn as Jean does, then "quit": no stream, no waiting.
        let start = |prompt, mode| {
            let session = prepare_session(&client, &request(None, prompt, mode)).unwrap();
            let prompt_id = client.prompt(&session, prompt, "steer").unwrap();
            OpenCodeTurnRef {
                session_id: session,
                prompt_id,
            }
        };
        let wait_until = |what: &str, check: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(90);
            while !check() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(500));
            }
        };
        let resume = |turn: &OpenCodeTurnRef, mode| {
            let req = TurnRequest {
                existing_opencode_session_id: Some(&turn.session_id),
                ..request(None, "", mode)
            };
            resume_turn(&app, &server, req, turn, &Arc::new(AtomicBool::new(false))).unwrap()
        };

        // 1. The turn still runs when Jean comes back.
        let turn = start(
            "Run the shell command `sleep 15; echo SLEPT-OK` with your shell tool, then reply with its output only.",
            "yolo",
        );
        wait_until("the shell tool to start", &|| {
            client
                .history(&turn.session_id, 50)
                .unwrap()
                .iter()
                .any(|m| {
                    m["content"]
                        .as_array()
                        .is_some_and(|c| c.iter().any(|i| i["type"] == "tool"))
                })
        });
        assert!(
            !probe.is_idle(&turn.session_id).unwrap(),
            "wait blocks while the session is busy"
        );
        let response = resume(&turn, "yolo");
        assert!(!response.cancelled);
        assert!(
            response.content.contains("SLEPT-OK"),
            "{}",
            response.content
        );
        assert!(
            response.tool_calls.iter().any(|t| t.name == "Bash"
                && t.output.as_deref().unwrap_or("").contains("SLEPT-OK")),
            "{:?}",
            response.tool_calls
        );

        // 2. The turn ended while Jean was closed.
        let turn = start("Reply with the word KIWI only.", "yolo");
        wait_until("the turn to end", &|| {
            probe.is_idle(&turn.session_id).unwrap()
        });
        let response = resume(&turn, "yolo");
        assert!(!response.cancelled);
        assert!(response.content.contains("KIWI"), "{}", response.content);
        assert!(response.usage.is_some(), "usage rebuilt from history");

        // 3. A permission asked while Jean was closed still gets its reply.
        let turn = start(
            "Run the shell command `echo PERM-OK` with your shell tool, then reply with its output only.",
            "build",
        );
        wait_until("the permission request", &|| {
            !client
                .pending_permissions(&turn.session_id)
                .unwrap()
                .is_empty()
        });
        let replier = {
            let (server, session) = (server.clone(), turn.session_id.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let client = V2Client::new(&server, Duration::from_secs(30)).unwrap();
                let pending = client.pending_permissions(&session).unwrap();
                let id = pending[0]["id"].as_str().unwrap();
                client.reply_permission(&session, id, "once", None).unwrap();
            })
        };
        let response = resume(&turn, "build");
        replier.join().unwrap();
        assert!(!response.cancelled);
        assert!(response.content.contains("PERM-OK"), "{}", response.content);
    }

    /// Steering, question forms and one-shots against a live 2.x server.
    /// Same environment as `live_v2_turn`.
    #[test]
    #[ignore]
    fn live_v2_interactions() {
        let server = OpenCodeServer {
            url: std::env::var("OPENCODE_V2_URL").unwrap(),
            api: crate::opencode_server::OpenCodeApi::V2,
            password: std::env::var("OPENCODE_V2_PASSWORD").ok(),
        };
        let dir = std::path::PathBuf::from(std::env::var("OPENCODE_V2_DIR").unwrap());
        let client = V2Client::new(&server, Duration::from_secs(60)).unwrap();
        let model = live_model();
        let new_session = || {
            client
                .create_session(json!({
                    "location": { "directory": dir.to_string_lossy() },
                    "agent": "build",
                    "model": v2_model(Some(&model), None),
                }))
                .unwrap()
        };
        let not_cancelled = AtomicBool::new(false);

        // A steer sent while the turn runs becomes part of it.
        let session = new_session();
        let mut state = TurnState::new(&session);
        let events = stream::open(&server);
        assert!(wait_connected(&events, &not_cancelled).unwrap());
        state.expect_delivery(
            client
                .prompt(
                    &session,
                    "Count slowly from 1 to 30, one number per line.",
                    "steer",
                )
                .unwrap(),
        );
        let _active = steer::ActiveTurn::register(&session);
        std::thread::sleep(Duration::from_secs(2));
        steer::steer(
            &server,
            &session,
            "When you are done counting, write the word MANGO.",
        )
        .unwrap();
        let outcome = wait_for_outcome(
            &client,
            &events,
            &mut state,
            &session,
            &not_cancelled,
            TURN_TIMEOUT,
            |_| {},
        )
        .unwrap();
        assert_eq!(outcome, Some(Outcome::Succeeded));
        let content = state.finish().content;
        assert!(
            content.contains("MANGO"),
            "steer output is in the turn: {content}"
        );
        assert!(
            steer::steer(&server, &session, "late").is_err(),
            "no steer after the turn closed"
        );

        // A question form is answered through answer_question.
        let session = new_session();
        let mut state = TurnState::new(&session);
        let events = stream::open(&server);
        assert!(wait_connected(&events, &not_cancelled).unwrap());
        state.expect_delivery(client.prompt(&session, "Use your question tool to ask me which color I prefer, with the options Red and Blue. Then reply with my answer only.", "steer").unwrap());
        let mut asked = None;
        let outcome = wait_for_outcome(
            &client,
            &events,
            &mut state,
            &session,
            &not_cancelled,
            TURN_TIMEOUT,
            |emit| {
                if let TurnEmit::ToolUse { id, name, .. } = &emit {
                    if name == "question" {
                        asked = Some(id.clone());
                    }
                }
                if let TurnEmit::FormCreated { question: true, .. } = emit {
                    let id = asked.clone().expect("question tool use before its form");
                    answer_question(
                        &server,
                        &dir.to_string_lossy(),
                        &id,
                        &[vec!["Blue".to_string()]],
                    )
                    .unwrap();
                }
            },
        )
        .unwrap();
        assert_eq!(outcome, Some(Outcome::Succeeded));
        let content = state.finish().content;
        assert!(
            content.contains("Blue"),
            "answer reached the model: {content}"
        );

        // Jean's image annotation becomes a file attachment.
        let image = dir.join("jean-live-test.png");
        std::fs::write(&image, b"not really a png").unwrap();
        let session = new_session();
        client
            .prompt(
                &session,
                &format!(
                    "Say OK. [Image attached: {} - Use the Read tool to view this image]",
                    image.display()
                ),
                "queue",
            )
            .unwrap();
        let messages = client.messages(&session).unwrap();
        let user = messages.iter().find(|m| m["type"] == "user").unwrap();
        assert_eq!(user["text"], "Say OK.");
        // 2.x detects the type from the bytes, so only the data is checked.
        assert_eq!(
            user["files"][0]["data"], "bm90IHJlYWxseSBhIHBuZw==",
            "{user}"
        );
        assert_eq!(user["files"][0]["name"], "jean-live-test.png");
        client.interrupt(&session).ok();
        std::fs::remove_file(&image).ok();

        // One-shot with and without a JSON schema.
        let text = run_one_shot(
            &server,
            "Reply with the word OK only.",
            &model,
            None,
            &dir,
            None,
        )
        .unwrap();
        assert!(text.contains("OK"), "{text}");
        let schema =
            r#"{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}"#;
        let text = run_one_shot(
            &server,
            "Give a short title for a commit that fixes a typo.",
            &model,
            Some(schema),
            &dir,
            None,
        )
        .unwrap();
        let parsed: Value =
            serde_json::from_str(&crate::chat::muse::extract_json_object(&text).unwrap()).unwrap();
        assert!(parsed["title"].is_string(), "{text}");
    }

    #[test]
    fn permission_rules_use_the_v2_shape() {
        let rules = v2_permission_rules("yolo", false).unwrap();
        assert_eq!(
            rules,
            json!([
                { "action": "*", "resource": "*", "effect": "allow" },
                { "action": "external_directory", "resource": "*", "effect": "allow" }
            ])
        );
        let plan = v2_permission_rules("plan", false).unwrap();
        assert_eq!(
            plan[0],
            json!({ "action": "*", "resource": "*", "effect": "deny" })
        );
        // A coordinator chat cannot edit files, even with full access
        assert_eq!(
            v2_permission_rules("yolo", true).unwrap(),
            json!([
                { "action": "*", "resource": "*", "effect": "allow" },
                { "action": "external_directory", "resource": "*", "effect": "allow" },
                { "action": "edit", "resource": "*", "effect": "deny" }
            ])
        );
    }

    #[test]
    fn model_carries_provider_and_variant() {
        assert_eq!(
            v2_model(Some("opencode/big-pickle"), Some("high")),
            Some(json!({ "id": "big-pickle", "providerID": "opencode", "variant": "high" }))
        );
        assert_eq!(v2_model(None, None), None);
    }
}

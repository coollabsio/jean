//! OpenCode 2.x chat turns. 2.x replaced the 1.x HTTP API: prompts go to a
//! session inbox and return at once, and the turn ends with a
//! `session.execution.*` event on `/api/event`.

mod client;
mod stream;
mod turn;

pub use client::V2Client;

use super::opencode::{
    agent_for_execution_mode, emit_backend_retry, emit_chat_chunk, emit_chat_done, emit_chat_error,
    emit_chat_thinking, emit_chat_tool_result, emit_chat_tool_use, emit_permission_replied,
    parse_provider_model, permission_rules_for_mode, should_auto_approve_opencode_permissions,
    variant_for_effort, OpenCodeResponse,
};
use super::types::OpenCodePermissionRequestEvent;
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
use turn::{Outcome, TurnEmit, TurnState};

const INSTRUCTIONS_KEY: &str = "jean";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Give up when the event stream stays down this long.
const DISCONNECT_LIMIT: Duration = Duration::from_secs(30);
/// Same limit as the blocking 1.x `/message` request.
const TURN_TIMEOUT: Duration = Duration::from_secs(1800);
const INTERRUPT_SETTLE: Duration = Duration::from_secs(3);

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
fn v2_permission_rules(mode: &str) -> Option<Value> {
    let rules = permission_rules_for_mode(mode)?;
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
    let rules = v2_permission_rules(mode);

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
    state.expect_prompt(inbox_id);
    log::info!(
        "OpenCode 2.x: prompt queued jean_session={} opencode_session={opencode_session_id}",
        req.session_id
    );

    let outcome = match wait_for_outcome(
        &client,
        &events,
        &mut state,
        &opencode_session_id,
        cancelled,
        |emit| handle_emit(app, &client, &req, emit),
    )? {
        Some(outcome) => outcome,
        None => return Ok(cancelled_response(opencode_session_id, state)),
    };

    match outcome {
        Outcome::Interrupted => Ok(cancelled_response(opencode_session_id, state)),
        Outcome::Failed(error) => {
            emit_chat_error(app, req.session_id, req.worktree_id, &error);
            Err(error)
        }
        Outcome::Succeeded => {
            if cancelled.load(Ordering::SeqCst) {
                return Ok(cancelled_response(opencode_session_id, state));
            }
            let result = state.finish();
            emit_chat_done(
                app,
                req.session_id,
                req.worktree_id,
                req.execution_mode == Some("plan") && !result.content.is_empty(),
            );
            Ok(OpenCodeResponse {
                content: result.content,
                session_id: opencode_session_id,
                tool_calls: result.tool_calls,
                content_blocks: result.content_blocks,
                cancelled: false,
                usage: result.usage,
            })
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
    mut on_emit: impl FnMut(TurnEmit),
) -> Result<Option<Outcome>, String> {
    let deadline = Instant::now() + TURN_TIMEOUT;
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
                TURN_TIMEOUT.as_secs() / 60
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
        if let Some(outcome) = state.outcome() {
            return Ok(Some(outcome.clone()));
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
        TurnEmit::FormCreated {
            session_id: form_session,
            form_id,
        } => {
            // Jean has no UI for 2.x forms yet. Cancel so the turn does not stall.
            log::warn!("OpenCode: cancelling unsupported 2.x form {form_id}");
            if let Err(e) = client.cancel_form(&form_session, &form_id) {
                log::warn!("OpenCode: form cancel failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let request = |existing, prompt, mode| TurnRequest {
            session_id: "jean",
            worktree_id: "wt",
            run_id: "run",
            working_dir: &dir,
            existing_opencode_session_id: existing,
            model: Some("opencode/big-pickle"),
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
            state.expect_prompt(client.prompt(&session, req.prompt, "steer").unwrap());
            if let Some(delay) = cancel_after {
                let flag = cancelled.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    flag.store(true, Ordering::SeqCst);
                });
            }
            let mut emits = Vec::new();
            let outcome =
                wait_for_outcome(&client, &events, &mut state, &session, &cancelled, |e| {
                    emits.push(e)
                })
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
        missed.expect_prompt(prompt_id);
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

    #[test]
    fn permission_rules_use_the_v2_shape() {
        let rules = v2_permission_rules("yolo").unwrap();
        assert_eq!(
            rules,
            json!([
                { "action": "*", "resource": "*", "effect": "allow" },
                { "action": "external_directory", "resource": "*", "effect": "allow" }
            ])
        );
        let plan = v2_permission_rules("plan").unwrap();
        assert_eq!(
            plan[0],
            json!({ "action": "*", "resource": "*", "effect": "deny" })
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

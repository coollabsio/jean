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
    parse_provider_model, permission_rules_for_mode, should_auto_approve_opencode_permissions,
    structured_output_text_prompt, variant_for_effort, OpenCodeResponse,
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

    let outcome = match wait_for_outcome(
        &client,
        &events,
        &mut state,
        &opencode_session_id,
        cancelled,
        TURN_TIMEOUT,
        |emit| handle_emit(app, &client, &req, emit),
    )? {
        Some(outcome) => outcome,
        None => return Ok(cancelled_response(opencode_session_id, state)),
    };

    match outcome {
        Outcome::Failed(error) => {
            emit_chat_error(app, req.session_id, req.worktree_id, &error);
            Err(error)
        }
        // 2.x also interrupts the execution when the user rejects a
        // permission. As on 1.x, that ends the turn; only a Jean cancel
        // makes it a cancelled turn.
        Outcome::Succeeded | Outcome::Interrupted => {
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
        let new_session = || {
            client
                .create_session(json!({
                    "location": { "directory": dir.to_string_lossy() },
                    "agent": "build",
                    "model": { "id": "big-pickle", "providerID": "opencode" },
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
            "opencode/big-pickle",
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
            "opencode/big-pickle",
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

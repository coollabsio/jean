//! Approval bridge for ACP agents, including detached hosts.
use super::storage::{load_metadata, with_existing_metadata_mut};
use super::types::{Backend, RunStatus};
use crate::http_server::EmitExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpPermissionRequest {
    pub request_id: String,
    pub backend: Backend,
    #[serde(default)]
    pub run_id: String,
    pub title: String,
    pub kind: String,
    pub options: Vec<Value>,
}

type Emitter = Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>;
struct Context {
    backend: Backend,
    emit: Emitter,
    is_cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
}
thread_local! { static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) }; }
struct Pending {
    sender: mpsc::Sender<String>,
    options: Vec<Value>,
}
static PENDING: Lazy<Mutex<HashMap<String, Pending>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub struct ApprovalScope;
impl Drop for ApprovalScope {
    fn drop(&mut self) {
        CONTEXT.with(|context| *context.borrow_mut() = None);
    }
}
pub fn scope(backend: Backend, emit: Emitter, cancelled: Arc<AtomicBool>) -> ApprovalScope {
    CONTEXT.with(|context| {
        *context.borrow_mut() = Some(Context {
            backend,
            emit,
            is_cancelled: Arc::new(move || cancelled.load(Ordering::SeqCst)),
        })
    });
    ApprovalScope
}

#[cfg(not(unix))]
pub fn attached_scope(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    backend: Backend,
) -> ApprovalScope {
    let app = app.clone();
    let session_id = session_id.to_string();
    let worktree_id = worktree_id.to_string();
    let run_id = super::pi::run_id_from_output_file(output_file);
    let watched_session = session_id.clone();
    CONTEXT.with(|context| {
        *context.borrow_mut() = Some(Context {
            backend,
            emit: Arc::new(move |value| {
                handle_log_event(&app, &session_id, &worktree_id, &run_id, value).map(|_| ())
            }),
            is_cancelled: Arc::new(move || !super::registry::is_process_running(&watched_session)),
        })
    });
    ApprovalScope
}

/// Unknown actions must ask. Never infer an edit from a shell command or title.
pub fn automatically_allowed(mode: Option<&str>, params: &Value) -> bool {
    match mode {
        Some("yolo") => true,
        Some("build") => matches!(
            params.pointer("/toolCall/kind").and_then(Value::as_str),
            Some("read" | "search" | "edit")
        ),
        _ => false,
    }
}
fn option_id(options: &[Value], kind: &str) -> Option<String> {
    options
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))?
        .get("optionId")?
        .as_str()
        .map(str::to_string)
}
fn allowed_reply(options: &[Value], option: &str) -> bool {
    options.iter().any(|value| {
        value.get("optionId").and_then(Value::as_str) == Some(option)
            && matches!(
                value.get("kind").and_then(Value::as_str),
                Some("allow_once" | "reject_once" | "reject_always")
            )
    })
}

pub fn reply(request_id: &str, option: &str) -> Result<(), String> {
    let pending = PENDING.lock().map_err(|_| "ACP approval lock poisoned")?;
    let request = pending
        .get(request_id)
        .ok_or("ACP approval is no longer pending")?;
    if !allowed_reply(&request.options, option) {
        return Err("Invalid ACP approval option".into());
    }
    request
        .sender
        .send(option.to_string())
        .map_err(|_| "ACP approval is no longer pending".into())
}

/// Returns only an offered allow-once option, an explicit rejection, or cancellation.
pub fn decide(mode: Option<&str>, params: &Value) -> Result<Value, String> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !options.iter().any(|option| {
        matches!(
            option.get("kind").and_then(Value::as_str),
            Some("allow_once" | "reject_once" | "reject_always")
        ) || (mode == Some("yolo")
            && option.get("kind").and_then(Value::as_str) == Some("allow_always"))
    }) {
        return Ok(json!({"outcome":{"outcome":"cancelled"}}));
    }
    let selected = if mode == Some("yolo") {
        option_id(&options, "allow_once").or_else(|| option_id(&options, "allow_always"))
    } else if automatically_allowed(mode, params) {
        option_id(&options, "allow_once")
    } else if matches!(mode, None | Some("plan")) {
        option_id(&options, "reject_once").or_else(|| option_id(&options, "reject_always"))
    } else {
        CONTEXT.with(|context| {
            let context = context.borrow();
            let Some(context) = context.as_ref() else {
                return Ok(None);
            };
            let request_id = uuid::Uuid::new_v4().to_string();
            let tool = params.get("toolCall").unwrap_or(&Value::Null);
            let request = AcpPermissionRequest {
                request_id: request_id.clone(),
                backend: context.backend.clone(),
                run_id: String::new(),
                title: tool
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Tool execution")
                    .to_string(),
                kind: tool
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("other")
                    .to_string(),
                options: options
                    .iter()
                    .filter(|value| {
                        matches!(
                            value.get("kind").and_then(Value::as_str),
                            Some("allow_once" | "reject_once" | "reject_always")
                        )
                    })
                    .cloned()
                    .collect(),
            };
            let (sender, receiver) = mpsc::channel();
            PENDING
                .lock()
                .map_err(|_| "ACP approval lock poisoned")?
                .insert(
                    request_id.clone(),
                    Pending {
                        sender,
                        options: request.options.clone(),
                    },
                );
            let result: Result<Option<String>, String> = (|| {
                (context.emit)(&json!({"type":"jean_acp_permission_request", "request":request}))?;
                let started = Instant::now();
                loop {
                    if (context.is_cancelled)() || started.elapsed() > Duration::from_secs(600) {
                        return Ok(None);
                    }
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Ok(option) => return Ok(Some(option)),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => return Ok(None),
                    }
                }
            })();
            PENDING
                .lock()
                .map_err(|_| "ACP approval lock poisoned")?
                .remove(&request_id);
            (context.emit)(
                &json!({"type":"jean_acp_permission_resolved", "request_id":request_id}),
            )?;
            result
        })?
    };
    Ok(match selected {
        Some(option) => json!({"outcome":{"outcome":"selected","optionId":option}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    })
}

pub fn handle_log_event(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    value: &Value,
) -> Result<bool, String> {
    match value.get("type").and_then(Value::as_str) {
        Some("jean_acp_permission_request") => {
            let mut request: AcpPermissionRequest =
                serde_json::from_value(value["request"].clone())
                    .map_err(|error| error.to_string())?;
            request.run_id = run_id.to_string();
            with_existing_metadata_mut(app, session_id, |metadata| {
                metadata
                    .pending_acp_permission_requests
                    .retain(|existing| existing.run_id == run_id);
                if !metadata
                    .pending_acp_permission_requests
                    .iter()
                    .any(|existing| existing.request_id == request.request_id)
                {
                    metadata.pending_acp_permission_requests.push(request);
                }
            })?;
        }
        Some("jean_acp_permission_resolved") => {
            let id = value["request_id"]
                .as_str()
                .ok_or("Missing ACP request id")?;
            with_existing_metadata_mut(app, session_id, |metadata| {
                metadata
                    .pending_acp_permission_requests
                    .retain(|request| request.request_id != id)
            })?;
        }
        _ => return Ok(false),
    }
    let _ = app.emit_all(
        "chat:acp_permissions_changed",
        &json!({"session_id":session_id,"worktree_id":worktree_id}),
    );
    Ok(true)
}

pub fn get_requests(
    app: &AppHandle,
    session_id: &str,
) -> Result<Vec<AcpPermissionRequest>, String> {
    let metadata = load_metadata(app, session_id)?.ok_or("Session not found")?;
    Ok(metadata
        .pending_acp_permission_requests
        .into_iter()
        .filter(|request| {
            metadata.runs.iter().any(|run| {
                matches!(run.status, RunStatus::Running | RunStatus::Resumable)
                    && run.run_id == request.run_id
                    && run.backend.as_ref() == Some(&request.backend)
            })
        })
        .collect())
}

pub fn respond(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    option: &str,
) -> Result<(), String> {
    let metadata = load_metadata(app, session_id)?.ok_or("Session not found")?;
    let request = metadata
        .pending_acp_permission_requests
        .iter()
        .find(|request| request.request_id == request_id)
        .ok_or("ACP approval is no longer pending")?;
    if !allowed_reply(&request.options, option) {
        return Err("Invalid ACP approval option".into());
    }
    #[cfg(unix)]
    {
        let run = metadata
            .runs
            .iter()
            .rev()
            .find(|run| {
                matches!(run.status, RunStatus::Running | RunStatus::Resumable)
                    && run.run_id == request.run_id
                    && run.backend.as_ref() == Some(&request.backend)
            })
            .ok_or("No running ACP turn")?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let line = format!(
            "{}\n",
            json!({"type":"permission_reply","request_id":request_id,"option_id":option})
        );
        match request.backend {
            Backend::Grok => super::grok::send_grok_acp_host_command(
                &super::grok::grok_acp_socket_path(&app_data, session_id, &run.run_id),
                &line,
            )?,
            Backend::Kimi => super::kimi::send_kimi_acp_host_command(
                &super::kimi::kimi_acp_socket_path(&app_data, session_id, &run.run_id),
                &line,
            )?,
            _ => return Err("Unsupported ACP backend".into()),
        }
    }
    #[cfg(not(unix))]
    reply(request_id, option)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricted_policies_never_auto_approve_shell_or_unknown_actions() {
        for mode in ["supervised", "build", "auto", "plan"] {
            for kind in ["execute", "fetch", "other", ""] {
                assert!(!automatically_allowed(
                    Some(mode),
                    &json!({"toolCall":{"kind":kind,"title":"Edit file"}})
                ));
            }
        }
        assert!(automatically_allowed(
            Some("build"),
            &json!({"toolCall":{"kind":"edit"}})
        ));
        assert!(!automatically_allowed(
            Some("supervised"),
            &json!({"toolCall":{"kind":"edit"}})
        ));
        assert!(!automatically_allowed(Some("build"), &json!({})));
    }
    #[test]
    fn only_offered_once_or_reject_options_can_be_selected() {
        let options = vec![
            json!({"kind":"allow_once","optionId":"allow"}),
            json!({"kind":"allow_always","optionId":"all"}),
            json!({"kind":"reject_once","optionId":"deny"}),
        ];
        assert!(allowed_reply(&options, "allow"));
        assert!(allowed_reply(&options, "deny"));
        assert!(!allowed_reply(&options, "all"));
        assert!(!allowed_reply(&options, "forged"));
    }
    #[test]
    fn approval_round_trip_validates_choice_and_emits_resolution() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let _scope = scope(
            Backend::Grok,
            Arc::new(move |event| {
                received.lock().unwrap().push(event.clone());
                if event["type"] == "jean_acp_permission_request" {
                    let id = event["request"]["request_id"].as_str().unwrap();
                    assert!(reply(id, "forged").is_err());
                    reply(id, "allow")?;
                }
                Ok(())
            }),
            Arc::new(AtomicBool::new(false)),
        );
        let params = json!({"toolCall":{"kind":"execute","title":"git status"},"options":[{"kind":"allow_once","optionId":"allow"},{"kind":"reject_once","optionId":"deny"}]});
        let result = decide(Some("build"), &params).unwrap();
        assert_eq!(result["outcome"]["optionId"], "allow");
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["type"], "jean_acp_permission_resolved");
        assert!(reply(
            events[0]["request"]["request_id"].as_str().unwrap(),
            "allow"
        )
        .is_err());
    }
    #[test]
    fn edit_only_and_full_access_select_only_native_offered_options() {
        let edit =
            json!({"toolCall":{"kind":"edit"},"options":[{"kind":"allow_once","optionId":"edit"}]});
        assert_eq!(
            decide(Some("build"), &edit).unwrap()["outcome"]["optionId"],
            "edit"
        );
        assert_eq!(
            decide(Some("supervised"), &edit).unwrap()["outcome"]["outcome"],
            "cancelled"
        );
        let _scope = scope(
            Backend::Grok,
            Arc::new(|_| panic!("An unusable approval request must not be emitted")),
            Arc::new(AtomicBool::new(false)),
        );
        let broad = json!({"options":[{"kind":"allow_always","optionId":"all"}]});
        assert_eq!(
            decide(Some("supervised"), &broad).unwrap()["outcome"]["outcome"],
            "cancelled"
        );
        let always = json!({"options":[{"kind":"allow_always","optionId":"all"}]});
        assert_eq!(
            decide(Some("yolo"), &always).unwrap()["outcome"]["optionId"],
            "all"
        );
        assert_eq!(
            decide(Some("build"), &always).unwrap()["outcome"]["outcome"],
            "cancelled"
        );
    }
    #[test]
    fn missing_approval_surface_and_cancellation_fail_closed() {
        let params = json!({"options":[{"kind":"allow_once","optionId":"allow"}]});
        assert_eq!(
            decide(Some("supervised"), &params).unwrap()["outcome"]["outcome"],
            "cancelled"
        );
        let request_id = Arc::new(Mutex::new(String::new()));
        let recorded = request_id.clone();
        let _scope = scope(
            Backend::Grok,
            Arc::new(move |event| {
                if event["type"] == "jean_acp_permission_request" {
                    *recorded.lock().unwrap() =
                        event["request"]["request_id"].as_str().unwrap().to_string();
                }
                Ok(())
            }),
            Arc::new(AtomicBool::new(true)),
        );
        assert_eq!(
            decide(Some("supervised"), &params).unwrap()["outcome"]["outcome"],
            "cancelled"
        );
        assert!(reply(&request_id.lock().unwrap(), "allow").is_err());
    }
}

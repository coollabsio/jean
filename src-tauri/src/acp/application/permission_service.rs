use std::collections::HashMap;

use agent_client_protocol::schema::{
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome,
};
use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, RwLock};
use tokio::time::{timeout, Duration};

use crate::acp::application::supervisor::{log_to_session, lookup_jean_session_id};
use crate::acp::infrastructure::session_log::Direction;
use crate::acp::provider::AcpProvider;

static PENDING: Lazy<RwLock<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub async fn handle(
    app: &AppHandle,
    provider: AcpProvider,
    request: RequestPermissionRequest,
) -> RequestPermissionResponse {
    let acp_id = request.session_id.0.as_ref().to_string();

    if let Ok(v) = serde_json::to_value(&request) {
        log_to_session(
            &acp_id,
            Direction::AgentToClient,
            &serde_json::json!({
                "method": "session/request_permission",
                "params": v,
            }),
        )
        .await;
    }

    let request_id = mint_request_id(&acp_id);
    let (tx, rx) = oneshot::channel::<RequestPermissionOutcome>();
    PENDING.write().await.insert(request_id.clone(), tx);

    let jean_session_id = lookup_jean_session_id(&acp_id).await;
    let payload = serde_json::json!({
        "provider": provider.to_string(),
        "session_id": &acp_id,
        "jean_session_id": jean_session_id,
        "request_id": &request_id,
        "request": serde_json::to_value(&request).unwrap_or(Value::Null),
    });
    if let Err(e) = app.emit("acp:permission", payload) {
        log::warn!("[acp:{provider}] failed to emit acp:permission: {e}");
    }

    let outcome = timeout(PERMISSION_TIMEOUT, rx)
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(RequestPermissionOutcome::Cancelled);
    PENDING.write().await.remove(&request_id);

    let response = RequestPermissionResponse::new(outcome);
    if let Ok(v) = serde_json::to_value(&response) {
        log_to_session(
            &acp_id,
            Direction::ClientToAgent,
            &serde_json::json!({
                "method": "session/request_permission",
                "result": v,
            }),
        )
        .await;
    }
    response
}

pub async fn resolve(request_id: String, option_id: Option<String>) -> Result<(), String> {
    let tx = PENDING
        .write()
        .await
        .remove(&request_id)
        .ok_or_else(|| format!("no pending permission request '{request_id}'"))?;
    let outcome = match option_id {
        Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
        None => RequestPermissionOutcome::Cancelled,
    };
    tx.send(outcome)
        .map_err(|_| "permission receiver dropped".to_string())
}

fn mint_request_id(acp_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("perm-{acp_id}-{nanos}")
}

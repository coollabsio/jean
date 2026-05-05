//! Thin ACP permission request handler at the API boundary.

use agent_client_protocol::schema::{RequestPermissionRequest, RequestPermissionResponse};
use tauri::AppHandle;

use crate::acp::application::permission_service;
use crate::acp::provider::AcpProvider;

pub async fn handle(
    app: &AppHandle,
    provider: AcpProvider,
    request: RequestPermissionRequest,
) -> RequestPermissionResponse {
    permission_service::handle(app, provider, request).await
}

pub async fn resolve(request_id: String, option_id: Option<String>) -> Result<(), String> {
    permission_service::resolve(request_id, option_id).await
}

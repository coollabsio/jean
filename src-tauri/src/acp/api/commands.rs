//! Tauri command boundary for the standalone ACP module.

use serde_json::Value;
use tauri::AppHandle;

use crate::acp::api::dto::{
    AcpImageInput, AcpLocalSessionState, AcpProcessedImage, AcpProviderInfo, AcpSessionInfo,
};
use crate::acp::application::{permission_service, prompt_service, session_service};
use crate::acp::provider::AcpProvider;

#[tauri::command]
pub fn acp_ping() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
pub fn acp_list_providers() -> Vec<AcpProviderInfo> {
    AcpProvider::ALL
        .iter()
        .map(|p| AcpProviderInfo {
            id: p.as_str().to_string(),
            name: p.name().to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn acp_create_session(
    app: AppHandle,
    jean_session_id: String,
    cwd: String,
    provider: String,
) -> Result<AcpSessionInfo, String> {
    log_err(
        "acp_create_session",
        session_service::create_session(app, jean_session_id, cwd, provider)
            .await
            .map(Into::into),
    )
}

#[tauri::command]
pub async fn acp_resume_session(
    app: AppHandle,
    jean_session_id: String,
    cwd: String,
) -> Result<AcpSessionInfo, String> {
    log_err(
        "acp_resume_session",
        session_service::resume_session(app, jean_session_id, cwd)
            .await
            .map(Into::into),
    )
}

#[tauri::command]
pub async fn acp_process_image(
    data: String,
    mime_type: String,
) -> Result<AcpProcessedImage, String> {
    log_err(
        "acp_process_image",
        prompt_service::process_image(data, mime_type)
            .await
            .map(Into::into),
    )
}

#[tauri::command]
pub async fn acp_send_message(
    app: AppHandle,
    jean_session_id: String,
    text: String,
    images: Option<Vec<AcpImageInput>>,
    mentions: Option<Vec<String>>,
    worktree_path: Option<String>,
) -> Result<Value, String> {
    let inner = prompt_service::send_message(
        app,
        jean_session_id,
        text,
        images
            .unwrap_or_default()
            .into_iter()
            .map(|i| (i.data, i.mime_type))
            .collect(),
        mentions.unwrap_or_default(),
        worktree_path,
    )
    .await;
    log_err("acp_send_message", inner)
}

#[tauri::command]
pub async fn acp_search_files(
    worktree_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    log_err(
        "acp_search_files",
        prompt_service::search_files(worktree_path, query, limit).await,
    )
}

#[tauri::command]
pub async fn acp_cancel(app: AppHandle, jean_session_id: String) -> Result<(), String> {
    log_err(
        "acp_cancel",
        prompt_service::cancel(app, jean_session_id).await,
    )
}

#[tauri::command]
pub async fn acp_set_model(
    app: AppHandle,
    jean_session_id: String,
    model_id: String,
) -> Result<Value, String> {
    log_err(
        "acp_set_model",
        prompt_service::set_model(app, jean_session_id, model_id).await,
    )
}

#[tauri::command]
pub async fn acp_set_mode(
    app: AppHandle,
    jean_session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    log_err(
        "acp_set_mode",
        prompt_service::set_mode(app, jean_session_id, mode_id).await,
    )
}

#[tauri::command]
pub async fn acp_set_config_option(
    app: AppHandle,
    jean_session_id: String,
    config_id: String,
    value_id: String,
) -> Result<Value, String> {
    log_err(
        "acp_set_config_option",
        prompt_service::set_config_option(app, jean_session_id, config_id, value_id).await,
    )
}

#[tauri::command]
pub async fn acp_resolve_permission(
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    log_err(
        "acp_resolve_permission",
        permission_service::resolve(request_id, option_id).await,
    )
}

#[tauri::command]
pub async fn acp_load_session_log(
    app: AppHandle,
    jean_session_id: String,
) -> Result<Vec<Value>, String> {
    log_err(
        "acp_load_session_log",
        session_service::load_session_log(&app, &jean_session_id).await,
    )
}

#[tauri::command]
pub async fn acp_load_local_session_state(
    app: AppHandle,
    jean_session_id: String,
) -> Result<AcpLocalSessionState, String> {
    log_err(
        "acp_load_local_session_state",
        session_service::load_local_session_state(&app, &jean_session_id)
            .await
            .map(Into::into),
    )
}

fn log_err<T>(cmd: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        log::error!("[acp] {cmd}: {e}");
    }
    result
}

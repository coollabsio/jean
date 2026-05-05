use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::application::{
    prompt_service::ProcessedImage,
    session_service::{LocalSessionState, OpenSessionResult},
};
use crate::acp::domain::session::SessionInfoState;

#[derive(Serialize)]
pub struct AcpProviderInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct AcpSessionInfo {
    pub session_id: String,
    pub provider: String,
    pub config_options: Value,
    pub available_commands: Value,
    pub log_path: String,
    pub resumed: bool,
    pub title: Option<String>,
    pub prompt_image: bool,
}

impl From<OpenSessionResult> for AcpSessionInfo {
    fn from(value: OpenSessionResult) -> Self {
        Self {
            session_id: value.session_id,
            provider: value.provider,
            config_options: value.config_options,
            available_commands: value.available_commands,
            log_path: value.log_path,
            resumed: value.resumed,
            title: value.title,
            prompt_image: value.prompt_image,
        }
    }
}

#[derive(Serialize)]
pub struct AcpSessionSnapshot {
    pub session_id: String,
    pub provider: String,
    pub config_options: Value,
    pub available_commands: Value,
    pub title: Option<String>,
    pub prompt_image: bool,
}

impl From<SessionInfoState> for AcpSessionSnapshot {
    fn from(value: SessionInfoState) -> Self {
        Self {
            session_id: value.session_id,
            provider: value.provider,
            config_options: value.config_options,
            available_commands: value.available_commands,
            title: value.title,
            prompt_image: value.prompt_image,
        }
    }
}

#[derive(Serialize)]
pub struct AcpLocalSessionState {
    pub exists: bool,
    pub snapshot: Option<AcpSessionSnapshot>,
    pub log_entries: Vec<Value>,
}

impl From<LocalSessionState> for AcpLocalSessionState {
    fn from(value: LocalSessionState) -> Self {
        Self {
            exists: value.exists,
            snapshot: value.snapshot.map(Into::into),
            log_entries: value.log_entries,
        }
    }
}

#[derive(Deserialize)]
pub struct AcpImageInput {
    pub data: String,
    pub mime_type: String,
}

#[derive(Serialize)]
pub struct AcpProcessedImage {
    pub data: String,
    pub mime_type: String,
}

impl From<ProcessedImage> for AcpProcessedImage {
    fn from(value: ProcessedImage) -> Self {
        Self {
            data: value.data,
            mime_type: value.mime_type,
        }
    }
}

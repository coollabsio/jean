use serde_json::Value;

use crate::acp::provider::AcpProvider;

#[derive(Debug, Clone)]
pub struct SessionBinding {
    pub acp_session_id: String,
    pub provider: AcpProvider,
}

#[derive(Debug, Clone)]
pub struct SessionInfoState {
    pub session_id: String,
    pub provider: String,
    pub config_options: Value,
    pub available_commands: Value,
    pub title: Option<String>,
    pub prompt_image: bool,
}

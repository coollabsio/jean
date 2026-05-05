//! Standalone ACP integration — does NOT go through the `chat/` layer.
//!
//! ⚠️ EXPERIMENTAL.
//!
//! This module is a clean-slate, ACP-only implementation of agent chat. It
//! lives entirely outside `chat/` and is gated behind the
//! `experimental_acp` preference flag. The existing `chat/acp/` adapter
//! (which speaks ACP via `Backend::Acp` inside the chat infrastructure)
//! is unrelated and stays in place until this module graduates.
//!
//! ## Layers
//!
//! - `api` — Tauri commands, DTOs, and ACP client handlers.
//! - `application` — session/prompt orchestration, supervisor, runtime state.
//! - `domain` — ACP concepts and business types.
//! - `infrastructure` — storage, logs, file search.
//! - `provider` — single home for all provider-specific code.

pub mod api;
mod application;
mod domain;
mod infrastructure;
mod provider;

pub mod commands {
    pub use super::api::commands::*;
    pub use super::api::dto::AcpImageInput;
}

pub use api::commands::{
    acp_cancel, acp_create_session, acp_list_providers, acp_load_local_session_state,
    acp_load_session_log, acp_ping, acp_resolve_permission, acp_resume_session, acp_search_files,
    acp_send_message, acp_set_config_option, acp_set_mode, acp_set_model,
};
pub use application::prewarm_all;

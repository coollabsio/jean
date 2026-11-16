//! OpenCode CLI management module
//!
//! Handles resolving, installing, and authenticating the OpenCode CLI binary.

mod commands;
mod config;
pub mod mcp;

pub use commands::*;
pub use config::{is_opencode_v2, resolve_cli_binary, should_auto_use_system};

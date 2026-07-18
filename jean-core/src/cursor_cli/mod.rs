//! Cursor CLI management module
//!
//! Handles resolving and inspecting the Cursor Agent binary.
//! Jean can bootstrap installation via Cursor's official installer, then resolves
//! the resulting binary from PATH.

mod commands;
mod config;
pub mod mcp;

pub use commands::*;
pub(crate) use config::resolve_cli_binary;

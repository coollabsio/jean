//! Claude CLI management module
//!
//! Handles downloading, installing, and managing the Claude CLI binary
//! embedded within the Jean application.

mod commands;
mod config;
pub mod mcp;

pub use commands::*;
pub use config::*;

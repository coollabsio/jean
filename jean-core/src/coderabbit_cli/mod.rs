//! CodeRabbit CLI management module.

mod commands;
mod config;

pub use commands::*;
pub use config::{resolve_coderabbit_binary, should_auto_use_system_coderabbit};

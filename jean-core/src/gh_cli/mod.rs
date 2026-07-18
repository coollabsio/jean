//! GitHub CLI management module
//!
//! Handles downloading, installing, and managing the GitHub CLI (gh) binary
//! embedded within the Jean application.

mod commands;
pub(crate) mod config;

pub use commands::*;

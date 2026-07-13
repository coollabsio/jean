//! GitLab CLI management module
//!
//! Handles downloading, installing, and managing the GitLab CLI (glab) binary
//! embedded within the Jean application. Mirrors `gh_cli` for GitHub.

mod commands;
pub(crate) mod config;

pub use commands::*;

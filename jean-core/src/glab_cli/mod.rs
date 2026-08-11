//! GitLab CLI (`glab`) management module
//!
//! Handles resolving, installing, and authenticating the GitLab CLI binary
//! for GitLab-hosted repositories (mirror of `gh_cli` for GitHub).

mod commands;
pub(crate) mod config;

pub use commands::*;

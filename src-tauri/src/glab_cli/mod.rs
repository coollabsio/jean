//! GitLab CLI management module
//!
//! Handles downloading, installing, and managing the GitLab CLI (glab) binary
//! embedded within the Jean application.

mod commands;
mod config;

pub use commands::*;

//! Claude Usage module
//!
//! Provides functionality to fetch and display Claude Code usage information:
//! - OAuth token retrieval from Keychain/file
//! - Usage limits from Anthropic API (5-hour and 7-day windows)
//! - Session usage aggregation (tokens, cost, context percentage)
//! - Context hook for accurate context window tracking

mod api;
pub mod commands;
pub mod context_hook;
mod credentials;
pub mod hook_installer;
pub mod types;

mod commands;
mod pty;
mod registry;
mod types;

// Re-export commands for registration in lib.rs
pub use commands::*;

// Re-export internal functions for app lifecycle cleanup
pub use pty::kill_all_terminals as cleanup_all_terminals;

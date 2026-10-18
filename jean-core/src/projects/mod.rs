pub mod checkpoints;
mod commands;
pub mod git;
pub mod git_log;
pub mod git_status;
pub mod github_actions;
pub mod github_issues;
pub mod linear_issues;
mod names;
pub mod pr_status;
mod release_notes;
pub mod saved_contexts;
pub mod sentry_issues;
mod servers;
pub mod storage;
pub mod types;

// Re-export commands for registration in lib.rs
pub use checkpoints::{
    analyze_ai_checkpoint_restore, apply_ai_checkpoint_restore_proposal, create_ai_checkpoint,
    delete_ai_checkpoint, finalize_ai_checkpoint, get_ai_checkpoint, get_ai_checkpoint_diff,
    list_ai_checkpoints, propose_ai_checkpoint_restore, restore_ai_checkpoint,
    restore_ai_checkpoint_file, restore_ai_checkpoint_turn,
};
pub use commands::*;
pub use github_actions::*;
pub use github_issues::*;
pub use linear_issues::*;
pub(crate) use names::is_generated_workspace_name;
pub use saved_contexts::*;
pub use sentry_issues::*;
pub(crate) use servers::{
    default_server_system_prompt, is_server_worktree, server_system_prompt, server_worktree_ids,
};
pub use servers::{
    ensure_local_server_project, list_ssh_public_keys, remove_server_project, save_server_project,
    server_user_setup_script, setup_server_user, ServerUserAccess,
};

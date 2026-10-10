//! Jean coordinator agent: a chat that is not bound to a user project.
//!
//! Its sessions are stored under a reserved worktree ID and run in a dedicated
//! app-data directory. It manages projects only through the Jean MCP server.

use std::fs;
use std::path::PathBuf;

use tauri::AppHandle;

/// Reserved worktree ID for Jean agent sessions (never a real worktree).
pub const JEAN_AGENT_WORKTREE_ID: &str = "__jean_agent__";

const JEAN_AGENT_PROMPT: &str = "# Jean Coordinator
You are Jean, the coordinator agent of the Jean app. You are the boss of all the user's projects.
- You are not working inside a project. Your working directory is only a scratch space.
- Use only the `jean` MCP server tools for all project work. Never use the `jean-dev` MCP server. Tools: list projects, worktrees and sessions; create, archive or delete worktrees; create sessions and send them tasks; start run environments; check status, diffs, commits, pull requests and issues.
- Delegate coding work to sessions inside the correct project worktree. Do not edit project files directly.
- Before destructive actions (delete, permanent delete, merge, push), confirm with the user.
- Keep answers short and report what you did with project and worktree names.";

/// Extra system prompt for Jean agent runs, `None` for normal sessions.
pub fn system_prompt_for(worktree_id: &str) -> Option<&'static str> {
    (worktree_id == JEAN_AGENT_WORKTREE_ID).then_some(JEAN_AGENT_PROMPT)
}

/// Working directory for Jean agent runs (creates it if missing).
pub fn get_jean_agent_workdir(app: &AppHandle) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let dir: PathBuf = app_data_dir.join("jean-agent");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Jean agent directory: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_only_for_jean_agent_worktree() {
        assert!(system_prompt_for(JEAN_AGENT_WORKTREE_ID).is_some());
        assert!(system_prompt_for("some-worktree").is_none());
    }
}

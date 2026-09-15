use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

use super::types::TerminalSession;

/// Global registry of active terminal sessions (terminal_id -> session)
pub static TERMINAL_SESSIONS: Lazy<Mutex<HashMap<String, TerminalSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a new terminal session
pub fn register_terminal(session: TerminalSession) {
    let mut sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions.insert(session.terminal_id.clone(), session);
}

/// Unregister a terminal session
pub fn unregister_terminal(terminal_id: &str) -> Option<TerminalSession> {
    let mut sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions.remove(terminal_id)
}

/// Check if a terminal exists
pub fn has_terminal(terminal_id: &str) -> bool {
    let sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions.contains_key(terminal_id)
}

/// Get all active terminal IDs
pub fn get_all_terminal_ids() -> Vec<String> {
    let sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions.keys().cloned().collect()
}

/// Snapshot of live PTY metadata needed to report run environments.
#[derive(Debug, Clone)]
pub struct LiveTerminalMeta {
    pub terminal_id: String,
    pub worktree_path: String,
    pub command: Option<String>,
    pub command_args: Option<Vec<String>>,
    pub session_id: Option<String>,
}

pub fn list_live_terminal_meta() -> Vec<LiveTerminalMeta> {
    let sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions
        .values()
        .map(|session| LiveTerminalMeta {
            terminal_id: session.terminal_id.clone(),
            worktree_path: session.worktree_path.clone(),
            command: session.command.clone(),
            command_args: session.command_args.clone(),
            session_id: session.session_id.clone(),
        })
        .collect()
}

/// Execute a function with mutable access to a terminal session
pub fn with_terminal<F, R>(terminal_id: &str, f: F) -> Option<R>
where
    F: FnOnce(&mut TerminalSession) -> R,
{
    let mut sessions = TERMINAL_SESSIONS.lock().unwrap();
    sessions.get_mut(terminal_id).map(f)
}

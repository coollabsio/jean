use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;

/// Event payload for terminal output
#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalOutputEvent {
    pub terminal_id: String,
    pub data: String,
}

/// Event payload for terminal started
#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalStartedEvent {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Event payload for terminal stopped
#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalStoppedEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
    /// Signal name if the process was killed by a signal (e.g. "Interrupt: 2" for SIGINT)
    pub signal: Option<String>,
}

/// A TCP port that a terminal's child process is listening on
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPortInfo {
    pub terminal_id: String,
    pub port: u16,
    pub process_name: String,
    pub local_address: String,
}

/// Active terminal session state
pub struct TerminalSession {
    pub terminal_id: String,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Box<dyn Child + Send + Sync>,
    pub cols: u16,
    pub rows: u16,
    pub worktree_path: String,
    pub command: Option<String>,
    pub command_args: Option<Vec<String>>,
    pub session_id: Option<String>,
}

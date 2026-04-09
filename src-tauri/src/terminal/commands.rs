use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

use super::pty::{
    kill_all_terminals as pty_kill_all_terminals, kill_terminal, resize_terminal, spawn_terminal,
    write_to_terminal,
};
use super::registry::{get_all_terminal_ids, has_terminal, TERMINAL_SESSIONS};
use crate::platform::silent_command;
use crate::projects::git::read_jean_config;

/// A TCP port that a terminal's child process is listening on
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPortInfo {
    pub terminal_id: String,
    pub port: u16,
    pub process_name: String,
    pub local_address: String,
}

/// Start a terminal
#[tauri::command]
pub async fn start_terminal(
    app: AppHandle,
    terminal_id: String,
    worktree_path: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    command_args: Option<Vec<String>>,
) -> Result<(), String> {
    log::trace!("start_terminal called for terminal: {terminal_id}");
    if command.is_some() || command_args.is_some() {
        log::debug!(
            "start_terminal {terminal_id}: worktree_path={worktree_path}, command={:?}, command_args={:?}",
            command,
            command_args
        );
    }

    // Check if terminal already exists
    if has_terminal(&terminal_id) {
        return Err("Terminal already exists".to_string());
    }

    spawn_terminal(
        &app,
        terminal_id,
        worktree_path,
        cols,
        rows,
        command,
        command_args,
    )
}

/// Get the run script(s) from jean.json for a worktree
#[tauri::command]
pub async fn get_run_scripts(worktree_path: String) -> Vec<String> {
    read_jean_config(&worktree_path)
        .and_then(|config| config.scripts.run)
        .map(|r| r.into_vec())
        .unwrap_or_default()
}

/// Get configured ports from jean.json for a worktree
#[tauri::command]
pub async fn get_ports(worktree_path: String) -> Vec<crate::projects::types::PortEntry> {
    read_jean_config(&worktree_path)
        .and_then(|config| config.ports)
        .unwrap_or_default()
}

/// Write data to a terminal (stdin)
#[tauri::command]
pub async fn terminal_write(terminal_id: String, data: String) -> Result<(), String> {
    write_to_terminal(&terminal_id, &data)
}

/// Resize a terminal
#[tauri::command]
pub async fn terminal_resize(terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    log::trace!("terminal_resize for {terminal_id}: {cols}x{rows}");
    resize_terminal(&terminal_id, cols, rows)
}

/// Stop a terminal
#[tauri::command]
pub async fn stop_terminal(app: AppHandle, terminal_id: String) -> Result<bool, String> {
    log::trace!("stop_terminal called for terminal: {terminal_id}");
    kill_terminal(&app, &terminal_id)
}

/// Get list of active terminal IDs
#[tauri::command]
pub async fn get_active_terminals() -> Vec<String> {
    get_all_terminal_ids()
}

/// Check if a terminal exists
#[tauri::command]
pub async fn has_active_terminal(terminal_id: String) -> bool {
    has_terminal(&terminal_id)
}

/// Kill all active terminals (used during app shutdown/refresh)
#[tauri::command]
pub fn kill_all_terminals() -> usize {
    log::trace!("kill_all_terminals command invoked");
    pty_kill_all_terminals()
}

/// Build a PID → PPID map from a single `ps -eo pid=,ppid=` call.
/// Much cheaper than spawning one `ps` per PID when walking ancestry.
#[cfg(unix)]
fn build_ppid_map() -> HashMap<u32, u32> {
    let output = match silent_command("ps")
        .args(["-eo", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return HashMap::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 2 {
            if let (Ok(pid), Ok(ppid)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                map.insert(pid, ppid);
            }
        }
    }
    map
}

/// Check if `pid` is a descendant of any PID in `ancestor_pids`.
/// Uses the pre-built ppid map instead of spawning per-PID subprocesses.
#[cfg(unix)]
fn is_descendant_of(
    pid: u32,
    ancestor_pids: &HashSet<u32>,
    ppid_map: &HashMap<u32, u32>,
    max_depth: usize,
) -> Option<u32> {
    let mut current = pid;
    let mut visited = HashSet::new();
    for _ in 0..max_depth {
        if ancestor_pids.contains(&current) {
            return Some(current);
        }
        if !visited.insert(current) {
            break;
        }
        match ppid_map.get(&current) {
            Some(&ppid) if ppid > 1 => current = ppid,
            _ => break,
        }
    }
    None
}

/// Discover TCP LISTEN ports belonging to our terminal processes.
///
/// Strategy:
/// 1. Collect PIDs of all active terminal shells from the registry
/// 2. Run `lsof -P -n -iTCP -sTCP:LISTEN -F pcn` to find all LISTEN sockets
/// 3. For each listener, walk the ppid chain to check if it descends from a terminal PID
/// 4. Return matched ports with terminal_id, port, process name, and address
#[tauri::command]
pub async fn get_terminal_listening_ports() -> Vec<TerminalPortInfo> {
    #[cfg(not(unix))]
    {
        // lsof is not available on Windows
        return Vec::new();
    }

    #[cfg(unix)]
    {
        // Step 1: Collect terminal PIDs → terminal_id mapping
        let terminal_pids: HashMap<u32, String> = {
            let sessions = TERMINAL_SESSIONS.lock().unwrap();
            sessions
                .iter()
                .filter_map(|(tid, session)| {
                    session.child.process_id().map(|pid| (pid, tid.clone()))
                })
                .collect()
        };

        if terminal_pids.is_empty() {
            return Vec::new();
        }

        let ancestor_pids: HashSet<u32> = terminal_pids.keys().copied().collect();

        // Step 2: Run lsof to find all TCP LISTEN sockets
        let output = match silent_command("lsof")
            .args(["-P", "-n", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                log::debug!("lsof failed: {e}");
                return Vec::new();
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Step 3: Parse lsof -F output
        // Format: lines starting with p=PID, c=command, n=address
        // Each process block starts with pPID, then cCOMMAND, then one or more nADDRESS
        struct LsofEntry {
            pid: u32,
            name: String,
            addresses: Vec<String>,
        }

        let mut entries: Vec<LsofEntry> = Vec::new();
        let mut current_pid: Option<u32> = None;
        let mut current_name = String::new();
        let mut current_addrs: Vec<String> = Vec::new();

        for line in stdout.lines() {
            if line.is_empty() {
                continue;
            }
            let (tag, value) = (line.as_bytes()[0], &line[1..]);
            match tag {
                b'p' => {
                    // Flush previous entry
                    if let Some(pid) = current_pid {
                        if !current_addrs.is_empty() {
                            entries.push(LsofEntry {
                                pid,
                                name: std::mem::take(&mut current_name),
                                addresses: std::mem::take(&mut current_addrs),
                            });
                        }
                    }
                    current_pid = value.parse::<u32>().ok();
                    current_name.clear();
                    current_addrs.clear();
                }
                b'c' => {
                    current_name = value.to_string();
                }
                b'n' => {
                    current_addrs.push(value.to_string());
                }
                _ => {}
            }
        }
        // Flush last entry
        if let Some(pid) = current_pid {
            if !current_addrs.is_empty() {
                entries.push(LsofEntry {
                    pid,
                    name: current_name,
                    addresses: current_addrs,
                });
            }
        }

        // Step 4: Build ppid map once, then match each listener via ancestry walk
        let ppid_map = build_ppid_map();
        let mut results: Vec<TerminalPortInfo> = Vec::new();

        for entry in &entries {
            // Check if this process descends from one of our terminal shells
            let ancestor_pid = if ancestor_pids.contains(&entry.pid) {
                Some(entry.pid)
            } else {
                is_descendant_of(entry.pid, &ancestor_pids, &ppid_map, 20)
            };

            if let Some(ancestor) = ancestor_pid {
                let terminal_id = match terminal_pids.get(&ancestor) {
                    Some(tid) => tid.clone(),
                    None => continue,
                };

                for addr in &entry.addresses {
                    // addr format: "127.0.0.1:3000" or "*:3000" or "[::1]:3000"
                    if let Some(port) = extract_port(addr) {
                        results.push(TerminalPortInfo {
                            terminal_id: terminal_id.clone(),
                            port,
                            process_name: entry.name.clone(),
                            local_address: addr.clone(),
                        });
                    }
                }
            }
        }

        // Dedup by (terminal_id, port)
        let mut seen = HashSet::new();
        results.retain(|r| seen.insert((r.terminal_id.clone(), r.port)));

        results
    }
}

/// Extract port number from an lsof address like "127.0.0.1:3000" or "*:8080" or "[::1]:3000"
fn extract_port(addr: &str) -> Option<u16> {
    addr.rsplit(':').next()?.parse::<u16>().ok()
}

//! Jean agent browser: agent-browser install + MCP config for CLI backends.
//!
//! Engine: [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
//! (Vercel Labs). The browser itself is Chromium / Chrome for Testing.
//!
//! Each Jean session gets its own agent-browser session (`AGENT_BROWSER_SESSION`
//! set per run), so parallel sessions get separate Chrome instances with
//! temporary profiles instead of waiting for one shared browser. Logins are
//! shared through one restore key: cookies and localStorage are saved when a
//! session's browser closes and are loaded when the next one starts.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::platform::{detect_cli_in_path, host_cli_command};

/// MCP server key written into CLI configs.
pub const MCP_SERVER_NAME: &str = "agent-browser";

/// npm package name for agent-browser.
pub const NPM_PACKAGE: &str = "agent-browser";

/// Explicit latest tag is required for updates. A plain `npm install
/// agent-browser` keeps the existing package.json caret range, and npm treats
/// `^0.37.1` as `<0.38.0` for a pre-1.0 package.
const NPM_INSTALL_SPEC: &str = "agent-browser@latest";

/// Jean-managed npm install directory under app data.
pub const CLI_DIR_NAME: &str = "agent-browser-cli";

/// Env var that selects the agent-browser session (one daemon + browser each).
pub const SESSION_ENV: &str = "AGENT_BROWSER_SESSION";

/// Env var + shared key for agent-browser auto-save/restore of cookies and
/// localStorage. One key for all sessions keeps logins shared between them.
const RESTORE_ENV: &str = "AGENT_BROWSER_RESTORE";
const RESTORE_KEY: &str = "jean";

/// Close an idle session's browser after 15 minutes to free memory. The
/// restore state is saved on this shutdown too.
const IDLE_TIMEOUT_ENV: &str = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const IDLE_TIMEOUT_MS: &str = "900000";

/// agent-browser session name for a Jean session.
pub fn session_name(jean_session_id: &str) -> String {
    format!("jean-{jean_session_id}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserStatus {
    /// Whether `agent-browser` was found (Jean-managed or PATH / WSL PATH).
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// Jean-managed npm install directory (may not exist yet).
    pub managed_dir: String,
    /// Whether the binary is Jean-managed under app data.
    pub managed_install: bool,
    /// Suggested MCP install command / snippet for Claude JSON.
    pub claude_snippet: String,
    pub codex_snippet: String,
    /// Operator hint when binary is missing.
    pub install_hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserInstallResult {
    pub backend: String,
    pub status: String,
    pub path: Option<String>,
    pub backup_path: Option<String>,
    pub server_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserUpdateStatus {
    pub installed: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
}

struct McpEntry {
    command: String,
}

/// Env written into every backend's MCP entry. The per-session
/// `AGENT_BROWSER_SESSION` is not here: Jean sets it on each run.
const ENTRY_ENV: [(&str, &str); 2] = [
    (RESTORE_ENV, RESTORE_KEY),
    (IDLE_TIMEOUT_ENV, IDLE_TIMEOUT_MS),
];

impl McpEntry {
    fn new(command: String) -> Self {
        Self { command }
    }

    fn env_map(&self) -> serde_json::Map<String, Value> {
        ENTRY_ENV
            .iter()
            .map(|(key, value)| (key.to_string(), Value::from(*value)))
            .collect()
    }

    fn claude_server_json(&self) -> Value {
        json!({
            "type": "stdio",
            "command": self.command,
            "args": ["mcp"],
            "env": self.env_map(),
        })
    }

    fn cursor_server_json(&self) -> Value {
        self.claude_server_json()
    }

    fn kimi_server_json(&self) -> Value {
        self.claude_server_json()
    }

    fn opencode_server_json(&self) -> Value {
        json!({
            "type": "local",
            "command": [self.command.clone(), "mcp"],
            "enabled": true,
            "environment": self.env_map(),
        })
    }

    fn claude_snippet(&self) -> String {
        let v = json!({
            "mcpServers": {
                MCP_SERVER_NAME: self.claude_server_json()
            }
        });
        serde_json::to_string_pretty(&v).unwrap_or_default()
    }

    fn codex_snippet(&self) -> String {
        let env = ENTRY_ENV
            .iter()
            .map(|(key, value)| format!("{key} = \"{value}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "[mcp_servers.{}]\ncommand = \"{}\"\nargs = [\"mcp\"]\nenv = {{ {env} }}\nenabled = true\n",
            MCP_SERVER_NAME,
            escape_toml_string(&self.command),
        )
    }

    fn codex_table_item(&self) -> toml_edit::Item {
        let mut table = toml_edit::Table::new();
        table["command"] = toml_edit::value(self.command.clone());
        table["args"] = toml_edit::value(toml_edit::Array::from_iter(["mcp"]));
        let mut env = toml_edit::InlineTable::new();
        for (key, value) in ENTRY_ENV {
            env.insert(key, value.into());
        }
        table["env"] = toml_edit::value(env);
        table["enabled"] = toml_edit::value(true);
        toml_edit::Item::Table(table)
    }
}

/// Shared persistent profile used by Jean versions before per-session browsers.
/// Only read once to import its logins (see [`import_legacy_profile`]).
fn legacy_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(app_data.join("agent-browser").join("profile"))
}

/// Jean-managed npm prefix for agent-browser.
pub fn managed_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(app_data.join(CLI_DIR_NAME))
}

fn managed_bin_path(cli_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        cli_dir
            .join("node_modules")
            .join(".bin")
            .join("agent-browser.cmd")
    }
    #[cfg(not(windows))]
    {
        cli_dir
            .join("node_modules")
            .join(".bin")
            .join("agent-browser")
    }
}

/// Path to Jean-managed `agent-browser` if the npm install is present.
pub fn find_managed_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = managed_bin_path(&managed_cli_dir(app).ok()?);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Resolve command path: Jean-managed install first, then PATH.
pub fn resolve_agent_browser_binary(app: &AppHandle) -> ResolvedBinary {
    if let Some(path) = find_managed_binary(app) {
        let version = read_binary_version(&path);
        return ResolvedBinary {
            installed: true,
            path: Some(path.to_string_lossy().to_string()),
            version,
            managed: true,
        };
    }

    let detection = detect_cli_in_path("agent-browser", None, None);
    ResolvedBinary {
        installed: detection.found,
        path: detection.path,
        version: detection.version,
        managed: false,
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub managed: bool,
}

fn read_binary_version(path: &Path) -> Option<String> {
    let output = host_cli_command(&path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn build_entry(app: &AppHandle) -> McpEntry {
    let resolved = resolve_agent_browser_binary(app);
    let command = resolved
        .path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "agent-browser".to_string());
    McpEntry::new(command)
}

/// Per-thread Codex config override that sets the agent-browser session.
///
/// Codex runs one app-server for all Jean sessions, so Jean cannot set the
/// session env per run. Codex starts MCP servers per thread, so a dotted
/// per-thread override works instead. Returns `None` when the Codex config has
/// no agent-browser server: the override alone would create a partial server
/// table without `command`, which Codex rejects.
pub fn codex_session_config_override(jean_session_id: &str) -> Option<(String, Value)> {
    let path = dirs::home_dir()?.join(".codex").join("config.toml");
    codex_session_config_override_at(&path, jean_session_id)
}

fn codex_session_config_override_at(path: &Path, jean_session_id: &str) -> Option<(String, Value)> {
    let doc = std::fs::read_to_string(path)
        .ok()?
        .parse::<toml_edit::DocumentMut>()
        .ok()?;
    doc.get("mcp_servers")?.get(MCP_SERVER_NAME)?;
    Some((
        format!("mcp_servers.{MCP_SERVER_NAME}.env.{SESSION_ENV}"),
        Value::from(session_name(jean_session_id)),
    ))
}

/// One-time import of logins from the legacy shared profile into the shared
/// restore key. Opening the profile with `--restore` and closing it saves its
/// cookies as restore state. The profile is then renamed so the import does
/// not run again. Fails (and retries on the next launch) while a legacy
/// browser still holds the profile lock.
pub(crate) fn import_legacy_profile(app: &AppHandle) -> Result<(), String> {
    let profile = legacy_profile_path(app)?;
    if !profile.is_dir() {
        return Ok(());
    }
    let Some(binary) = resolve_agent_browser_binary(app)
        .path
        .filter(|p| !p.is_empty())
    else {
        return Ok(());
    };

    const IMPORT_SESSION: &str = "jean-profile-import";
    let profile_arg = profile.to_string_lossy().to_string();
    let run = |args: &[&str]| -> Result<(), String> {
        let output = host_cli_command(&binary, None)
            .args(["--session", IMPORT_SESSION])
            .args(args)
            .output()
            .map_err(|e| format!("Failed to run agent-browser: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    };
    run(&[
        "--profile",
        &profile_arg,
        "--restore",
        RESTORE_KEY,
        "open",
        "about:blank",
    ])
    .map_err(|e| format!("Failed to open legacy agent-browser profile: {e}"))?;
    run(&["close"]).map_err(|e| format!("Failed to save legacy agent-browser logins: {e}"))?;

    let imported = profile.with_file_name("profile-imported");
    std::fs::rename(&profile, &imported).map_err(|e| {
        format!(
            "Imported legacy agent-browser logins, but failed to rename {}: {e}",
            profile.display()
        )
    })
}

/// Status for Settings UI / operators.
pub async fn get_agent_browser_status(app: AppHandle) -> Result<AgentBrowserStatus, String> {
    let managed_dir = managed_cli_dir(&app)?;
    let resolved = resolve_agent_browser_binary(&app);
    let entry = McpEntry::new(
        resolved
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "agent-browser".to_string()),
    );

    Ok(AgentBrowserStatus {
        installed: resolved.installed,
        binary_path: resolved.path,
        version: resolved.version,
        managed_dir: managed_dir.to_string_lossy().to_string(),
        managed_install: resolved.managed,
        claude_snippet: entry.claude_snippet(),
        codex_snippet: entry.codex_snippet(),
        install_hint: "Jean installs Agent Browser automatically. Manual fallback: npm install -g agent-browser@latest && agent-browser install".to_string(),
    })
}

/// Check the npm registry for a newer agent-browser release.
///
/// Performs synchronous npm/network work; WebSocket dispatch runs this on the
/// blocking pool.
pub async fn check_agent_browser_update(
    app: AppHandle,
) -> Result<AgentBrowserUpdateStatus, String> {
    let resolved = resolve_agent_browser_binary(&app);
    if !resolved.installed {
        return Ok(AgentBrowserUpdateStatus {
            installed: false,
            current_version: None,
            latest_version: None,
            update_available: false,
        });
    }

    let npm_path = crate::prerequisites::require_npm("agent-browser update check")?;
    let output = host_cli_command(&npm_path, None)
        .args(["view", NPM_PACKAGE, "version", "--json"])
        .output()
        .map_err(|error| format!("Failed to check agent-browser updates: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "Failed to check agent-browser updates: {}",
            if error.is_empty() {
                "npm returned an error"
            } else {
                &error
            }
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let latest = serde_json::from_str::<String>(raw.trim())
        .unwrap_or_else(|_| raw.trim().trim_matches('"').to_string());
    let latest_version = (!latest.is_empty()).then_some(latest);
    let update_available = resolved
        .version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(current, latest)| is_newer_version(latest, current));

    Ok(AgentBrowserUpdateStatus {
        installed: true,
        current_version: resolved.version,
        latest_version,
        update_available,
    })
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .trim()
            .trim_start_matches(|character: char| !character.is_ascii_digit())
            .split(['.', '-', '+'])
            .map_while(|part| part.parse::<u64>().ok())
            .collect()
    }

    let latest = parts(latest);
    let current = parts(current);
    !latest.is_empty() && !current.is_empty() && latest > current
}

/// Install agent-browser via npm into Jean app data, then download Chromium
/// (`agent-browser install`). Idempotent reinstall/update.
///
/// Performs synchronous npm/network work; WebSocket dispatch should run this
/// on the blocking pool (see `command_should_run_on_blocking_pool`).
pub async fn install_agent_browser(app: AppHandle) -> Result<AgentBrowserStatus, String> {
    install_agent_browser_sync(&app)
}

pub(crate) fn install_agent_browser_sync(app: &AppHandle) -> Result<AgentBrowserStatus, String> {
    let cli_dir = managed_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir).map_err(|e| {
        format!(
            "Failed to create agent-browser install dir {}: {e}",
            cli_dir.display()
        )
    })?;

    let npm_path = crate::prerequisites::require_npm("agent-browser")?;

    let npm_output = host_cli_command(&npm_path, None)
        .args(["install", "--prefix"])
        .arg(&cli_dir)
        .arg(NPM_INSTALL_SPEC)
        .output()
        .map_err(|e| {
            format!("Failed to run npm install for agent-browser (is npm on PATH?): {e}")
        })?;

    if !npm_output.status.success() {
        let stderr = String::from_utf8_lossy(&npm_output.stderr)
            .trim()
            .to_string();
        let stdout = String::from_utf8_lossy(&npm_output.stdout)
            .trim()
            .to_string();
        return Err(format!(
            "npm install agent-browser failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    let binary = managed_bin_path(&cli_dir);
    if !binary.is_file() {
        return Err(format!(
            "npm install completed but agent-browser was not found at {}",
            binary.display()
        ));
    }

    // Download Chrome for Testing into agent-browser's cache.
    // Linux servers often need OS shared libs; --with-deps helps when available.
    let mut install_cmd = host_cli_command(&binary.to_string_lossy(), None);
    install_cmd.arg("install");
    if cfg!(target_os = "linux") {
        install_cmd.arg("--with-deps");
    }
    let chromium_output = install_cmd
        .output()
        .map_err(|e| format!("Failed to run `agent-browser install` for Chromium download: {e}"))?;

    if !chromium_output.status.success() {
        // Retry without --with-deps (flag may not exist on older versions).
        let retry = host_cli_command(&binary.to_string_lossy(), None)
            .arg("install")
            .output()
            .map_err(|e| format!("Failed to run `agent-browser install`: {e}"))?;
        if !retry.status.success() {
            let stderr = String::from_utf8_lossy(&chromium_output.stderr)
                .trim()
                .to_string();
            let stdout = String::from_utf8_lossy(&chromium_output.stdout)
                .trim()
                .to_string();
            let retry_err = String::from_utf8_lossy(&retry.stderr).trim().to_string();
            return Err(format!(
                "agent-browser install (Chromium) failed: {}",
                [stderr, stdout, retry_err]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or_else(|| "unknown error".to_string())
            ));
        }
    }

    // Build status without re-entering async.
    let resolved = resolve_agent_browser_binary(app);
    if !resolved.installed {
        return Err("agent-browser install finished but binary still not detected".to_string());
    }
    let entry = McpEntry::new(
        resolved
            .path
            .clone()
            .unwrap_or_else(|| binary.to_string_lossy().to_string()),
    );

    Ok(AgentBrowserStatus {
        installed: true,
        binary_path: resolved.path,
        version: resolved.version,
        managed_dir: cli_dir.to_string_lossy().to_string(),
        managed_install: true,
        claude_snippet: entry.claude_snippet(),
        codex_snippet: entry.codex_snippet(),
        install_hint: "Jean installs Agent Browser automatically. Manual fallback: npm install -g agent-browser@latest && agent-browser install".to_string(),
    })
}

/// Install `agent-browser` MCP server into selected CLI backends.
///
/// Writes the shared restore key and idle timeout into each backend config.
/// Prefers the Jean-managed binary when present; otherwise requires
/// `agent-browser` on PATH.
pub async fn install_agent_browser_mcp(
    app: AppHandle,
    backends: Option<Vec<String>>,
) -> Result<Vec<AgentBrowserInstallResult>, String> {
    let entry = build_entry(&app);
    let backends = backends.unwrap_or_else(|| {
        vec![
            "claude".to_string(),
            "codex".to_string(),
            "opencode".to_string(),
            "cursor".to_string(),
            "grok".to_string(),
            "kimi".to_string(),
            "antigravity".to_string(),
        ]
    });

    let mut results = Vec::with_capacity(backends.len());
    for backend in backends {
        let result = match backend.as_str() {
            "claude" => install_claude(&entry),
            "codex" => install_codex(&entry),
            "opencode" => install_opencode(&entry),
            "cursor" => install_cursor(&entry),
            "grok" => install_grok(&entry),
            "kimi" => install_kimi(&entry),
            "antigravity" => install_antigravity(&entry),
            other => Err(format!("Unsupported MCP config backend: {other}")),
        };
        results.push(match result {
            Ok((path, backup_path)) => AgentBrowserInstallResult {
                backend,
                status: "installed".to_string(),
                path: Some(path.to_string_lossy().to_string()),
                backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
                server_name: MCP_SERVER_NAME.to_string(),
                message: format!("Installed {MCP_SERVER_NAME}"),
            },
            Err(error) => AgentBrowserInstallResult {
                backend,
                status: "error".to_string(),
                path: None,
                backup_path: None,
                server_name: MCP_SERVER_NAME.to_string(),
                message: error,
            },
        });
    }

    // Best-effort: enable agent-browser for installed backends in Jean prefs.
    if let Err(e) = enable_in_preferences(&app, &results) {
        log::warn!("Failed to auto-enable agent-browser MCP in preferences: {e}");
    }

    Ok(results)
}

fn enable_in_preferences(
    app: &AppHandle,
    results: &[AgentBrowserInstallResult],
) -> Result<(), String> {
    let path = crate::get_preferences_path(app)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to read preferences: {e}")),
    };
    let mut prefs: Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse preferences: {e}"))?;

    let Some(obj) = prefs.as_object_mut() else {
        return Ok(());
    };

    if !obj.contains_key("default_enabled_mcp_servers") {
        obj.insert("default_enabled_mcp_servers".into(), json!([]));
    }
    if !obj.contains_key("known_mcp_servers") {
        obj.insert("known_mcp_servers".into(), json!([]));
    }

    let keys: Vec<String> = results
        .iter()
        .filter(|r| r.status == "installed")
        .map(|r| format!("{}:{MCP_SERVER_NAME}", r.backend))
        .collect();

    for field in ["default_enabled_mcp_servers", "known_mcp_servers"] {
        let Some(arr) = obj.get_mut(field).and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for key in &keys {
            let key_val = Value::String(key.clone());
            if !arr.iter().any(|v| v == &key_val) {
                arr.push(key_val);
            }
        }
    }

    let updated = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {e}"))?;
    std::fs::write(&path, updated).map_err(|e| format!("Failed to write preferences: {e}"))?;
    Ok(())
}

fn install_claude(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_json_server(
        home.join(".claude.json"),
        "mcpServers",
        entry.claude_server_json(),
    )
}

fn install_cursor(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_json_server(
        home.join(".cursor").join("mcp.json"),
        "mcpServers",
        entry.cursor_server_json(),
    )
}

fn install_kimi(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_json_server(
        home.join(".kimi-code").join("mcp.json"),
        "mcpServers",
        entry.kimi_server_json(),
    )
}

fn install_antigravity(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_antigravity_at(
        home.join(".gemini").join("config").join("mcp_config.json"),
        entry,
    )
}

fn install_antigravity_at(
    path: PathBuf,
    entry: &McpEntry,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    install_json_server(path, "mcpServers", entry.claude_server_json())
}

fn install_opencode(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    let path = find_opencode_config_path(&home)
        .unwrap_or_else(|| home.join(".config").join("opencode").join("opencode.json"));
    install_json_server(path, "mcp", entry.opencode_server_json())
}

fn install_codex(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_toml_server(
        home.join(".codex").join("config.toml"),
        entry,
        "Codex",
        false,
    )
}

fn install_grok(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_toml_server(home.join(".grok").join("config.toml"), entry, "Grok", true)
}

fn find_opencode_config_path(home: &Path) -> Option<PathBuf> {
    for dir in [home.join(".config").join("opencode"), home.to_path_buf()] {
        for name in ["opencode.jsonc", "opencode.json", "config.json"] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod antigravity_install_tests {
    use super::*;

    #[test]
    fn installs_agent_browser_in_antigravity_global_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("mcp_config.json");
        let entry = McpEntry::new("agent-browser".to_string());

        install_antigravity_at(path.clone(), &entry).expect("install");

        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
        assert_eq!(
            value["mcpServers"][MCP_SERVER_NAME]["command"],
            "agent-browser"
        );
    }
}

fn install_json_server(
    path: PathBuf,
    container_key: &str,
    server_value: Value,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };

    let mut root: Value = if content.trim().is_empty() {
        json!({})
    } else {
        // Strip simple // and /* */ comments for JSONC configs
        let cleaned = strip_jsonc_comments_simple(&content);
        serde_json::from_str(&cleaned)
            .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;

    let container = obj
        .entry(container_key.to_string())
        .or_insert_with(|| json!({}));
    let container_obj = container
        .as_object_mut()
        .ok_or_else(|| format!("{container_key} must be an object in {}", path.display()))?;
    container_obj.insert(MCP_SERVER_NAME.to_string(), server_value);

    let updated = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    let backup = write_atomic_with_backup(&path, &updated)?;
    Ok((path, backup))
}

fn install_toml_server(
    path: PathBuf,
    entry: &McpEntry,
    label: &str,
    clear_disabled_list: bool,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };

    let mut doc = if content.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        content
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Failed to parse {label} TOML {}: {e}", path.display()))?
    };

    if !doc.as_table().contains_key("mcp_servers") {
        doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    doc["mcp_servers"][MCP_SERVER_NAME] = entry.codex_table_item();

    if clear_disabled_list {
        if let Some(item) = doc.get_mut("disabled_mcp_servers") {
            if let Some(arr) = item.as_array_mut() {
                let mut i = 0;
                while i < arr.len() {
                    let is_match = arr
                        .get(i)
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s == MCP_SERVER_NAME);
                    if is_match {
                        arr.remove(i);
                    } else {
                        i += 1;
                    }
                }
            }
        }
    }

    let updated = doc.to_string();
    updated
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Generated invalid {label} TOML: {e}"))?;
    let backup = write_atomic_with_backup(&path, &updated)?;
    Ok((path, backup))
}

fn write_atomic_with_backup(path: &Path, content: &str) -> Result<Option<PathBuf>, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let backup = if path.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let backup = path.with_extension(format!(
            "{}.bak.{ts}",
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("config")
        ));
        std::fs::copy(path, &backup)
            .map_err(|e| format!("Failed to create backup {}: {e}", backup.display()))?;
        Some(backup)
    } else {
        None
    };

    crate::platform::write_file_atomically(path, content.as_bytes())?;
    Ok(backup)
}

fn strip_jsonc_comments_simple(input: &str) -> String {
    // Minimal strip for // line comments and /* block */ — good enough for MCP JSONC.
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            out.push(b as char);
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if b == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'/' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
                continue;
            }
        }
        out.push(b as char);
        i += 1;
    }
    out
}

fn escape_toml_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn mcp_entry_uses_shared_restore_key_without_shared_profile() {
        let server = McpEntry::new("agent-browser".into()).claude_server_json();
        assert_eq!(server["args"], json!(["mcp"]));
        assert_eq!(server["env"]["AGENT_BROWSER_RESTORE"], "jean");
        assert_eq!(server["env"]["AGENT_BROWSER_IDLE_TIMEOUT_MS"], "900000");
        // A shared profile is locked by one Chrome and blocks parallel sessions.
        assert!(server["env"].get("AGENT_BROWSER_PROFILE").is_none());
        // The session is set per run, never globally.
        assert!(server["env"].get(SESSION_ENV).is_none());
    }

    #[test]
    fn mcp_entry_codex_snippet_is_valid_toml() {
        let snippet = McpEntry::new("agent-browser".into()).codex_snippet();
        let doc = snippet.parse::<toml_edit::DocumentMut>().unwrap();
        let server = &doc["mcp_servers"]["agent-browser"];
        assert_eq!(
            server["env"]["AGENT_BROWSER_RESTORE"].as_str(),
            Some("jean")
        );
        assert_eq!(server["enabled"].as_bool(), Some(true));
    }

    #[test]
    fn session_name_is_scoped_to_jean_session() {
        assert_eq!(session_name("abc-123"), "jean-abc-123");
    }

    #[test]
    fn codex_override_targets_session_env_of_installed_server() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        install_toml_server(
            path.clone(),
            &McpEntry::new("agent-browser".into()),
            "Codex",
            false,
        )
        .unwrap();

        let (key, value) = codex_session_config_override_at(&path, "s1").unwrap();
        assert_eq!(key, "mcp_servers.agent-browser.env.AGENT_BROWSER_SESSION");
        assert_eq!(value, "jean-s1");
    }

    #[test]
    fn codex_override_skipped_without_installed_server() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        // Missing file
        assert!(codex_session_config_override_at(&path, "s1").is_none());
        // Server not installed: an override would create a partial table.
        fs::write(&path, "[mcp_servers.other]\ncommand = \"x\"\n").unwrap();
        assert!(codex_session_config_override_at(&path, "s1").is_none());
    }

    #[test]
    fn install_json_server_upserts_mcp_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{ "mcpServers": { "other": { "command": "x" } } }"#,
        )
        .unwrap();

        let entry = McpEntry::new("agent-browser".into());
        install_json_server(path.clone(), "mcpServers", entry.claude_server_json()).unwrap();

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed["mcpServers"]["other"].is_object());
        assert_eq!(
            parsed["mcpServers"]["agent-browser"]["command"],
            "agent-browser"
        );
        assert_eq!(
            parsed["mcpServers"]["agent-browser"]["env"]["AGENT_BROWSER_RESTORE"],
            "jean"
        );
    }

    #[test]
    fn install_toml_server_upserts_mcp_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[mcp_servers.existing]\ncommand = \"foo\"\n").unwrap();

        let entry = McpEntry::new("/usr/bin/agent-browser".into());
        install_toml_server(path.clone(), &entry, "Codex", false).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[mcp_servers.existing]"));
        assert!(content.contains("[mcp_servers.agent-browser]"));
        assert!(content.contains("/usr/bin/agent-browser"));
        assert!(content.contains("AGENT_BROWSER_RESTORE"));
    }

    #[test]
    fn strip_jsonc_preserves_strings_with_slashes() {
        let input = r#"{ "url": "https://example.com" } // trailing"#;
        let cleaned = strip_jsonc_comments_simple(input);
        assert!(cleaned.contains("https://example.com"));
        assert!(!cleaned.contains("trailing"));
    }

    #[test]
    fn managed_bin_path_points_at_node_modules_bin() {
        let dir = TempDir::new().unwrap();
        let bin = managed_bin_path(dir.path());
        let s = bin.to_string_lossy();
        assert!(s.contains("node_modules"));
        assert!(s.contains(".bin"));
        assert!(s.contains("agent-browser"));
    }

    #[test]
    fn compares_agent_browser_versions() {
        assert!(is_newer_version("0.8.1", "agent-browser 0.8.0"));
        assert!(is_newer_version("1.0.0", "0.99.9"));
        assert!(!is_newer_version("0.8.0", "agent-browser 0.8.0"));
        assert!(!is_newer_version("0.7.9", "0.8.0"));
    }

    #[test]
    fn managed_install_explicitly_requests_latest_release() {
        assert_eq!(NPM_INSTALL_SPEC, "agent-browser@latest");
    }
}

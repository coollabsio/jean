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
use tauri::AppHandle;

use crate::platform::{detect_cli_in_path, host_cli_command};

/// MCP server key written into CLI configs.
pub const MCP_SERVER_NAME: &str = "agent-browser";

/// npm package name for agent-browser.
pub const NPM_PACKAGE: &str = "agent-browser";

/// Jean installs only releases at least this old. Most compromised npm
/// releases are found and removed within this time.
const MIN_RELEASE_AGE: chrono::TimeDelta = chrono::TimeDelta::days(3);

/// Repository whose release workflow must have built the npm package.
const SOURCE_REPOSITORY: &str = "https://github.com/vercel-labs/agent-browser";

/// Serializes installs: the native app, Web Access clients, and startup can
/// all request one, and they share one npm prefix.
static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Chrome for Testing builds to keep after `agent-browser install`. The
/// previous build stays because browsers started before the install still run
/// from it.
const KEPT_CHROME_BUILDS: usize = 2;

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

/// Default folder for screenshots taken without a path. It is under app data,
/// so chat galleries load them through the asset protocol, and Jean deletes
/// files older than [`SCREENSHOT_MAX_AGE`] on startup.
const SCREENSHOT_DIR_ENV: &str = "AGENT_BROWSER_SCREENSHOT_DIR";
const SCREENSHOT_DIR_NAME: &str = "browser-screenshots";
const SCREENSHOT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

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
    screenshot_dir: Option<String>,
}

impl McpEntry {
    fn new(command: String, screenshot_dir: Option<PathBuf>) -> Self {
        Self {
            command,
            screenshot_dir: screenshot_dir.map(|dir| dir.to_string_lossy().to_string()),
        }
    }

    /// Env written into every backend's MCP entry. The per-session
    /// `AGENT_BROWSER_SESSION` is not here: Jean sets it on each run.
    fn env(&self) -> Vec<(&'static str, &str)> {
        let mut env = vec![
            (RESTORE_ENV, RESTORE_KEY),
            (IDLE_TIMEOUT_ENV, IDLE_TIMEOUT_MS),
        ];
        if let Some(dir) = &self.screenshot_dir {
            env.push((SCREENSHOT_DIR_ENV, dir));
        }
        env
    }

    fn env_map(&self) -> serde_json::Map<String, Value> {
        self.env()
            .into_iter()
            .map(|(key, value)| (key.to_string(), Value::from(value)))
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

    fn muse_server_json(&self) -> Value {
        json!({
            "transport": "stdio",
            "command": self.command,
            "args": ["mcp"],
            "env": self.env_map(),
            "enabled": true,
        })
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
        let env = self
            .env()
            .into_iter()
            .map(|(key, value)| format!("{key} = \"{}\"", escape_toml_string(value)))
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
        for (key, value) in self.env() {
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
    McpEntry::new(command, screenshot_dir(app))
}

/// Default agent-browser screenshot folder under app data.
fn screenshot_dir(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join(SCREENSHOT_DIR_NAME))
}

/// Delete screenshots in Jean's screenshot folder older than
/// [`SCREENSHOT_MAX_AGE`]. Returns how many files were removed.
pub(crate) fn prune_old_screenshots(app: &AppHandle) -> usize {
    screenshot_dir(app).map_or(0, |dir| prune_files_older_than(&dir, SCREENSHOT_MAX_AGE))
}

fn prune_files_older_than(dir: &Path, max_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(max_age) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry.metadata().is_ok_and(|meta| {
                meta.is_file() && meta.modified().is_ok_and(|modified| modified < cutoff)
            })
        })
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
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

/// Required per-run MCP entry with the same profile as the installed server.
pub(crate) fn runtime_mcp_entry(app: &AppHandle) -> Result<Value, String> {
    Ok(build_entry(app).claude_server_json())
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
        screenshot_dir(&app),
    );

    Ok(AgentBrowserStatus {
        installed: resolved.installed,
        binary_path: resolved.path,
        version: resolved.version,
        managed_dir: managed_dir.to_string_lossy().to_string(),
        managed_install: resolved.managed,
        claude_snippet: entry.claude_snippet(),
        codex_snippet: entry.codex_snippet(),
        install_hint: "Turn on Agent Browser in Settings to install it. Manual fallback: npm install -g agent-browser@latest && agent-browser install".to_string(),
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
    let latest_version = Some(fetch_settled_release(&npm_path)?);
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

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches(|character: char| !character.is_ascii_digit())
        .split(['.', '-', '+'])
        .map_while(|part| part.parse::<u64>().ok())
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);
    !latest.is_empty() && !current.is_empty() && latest > current
}

/// Newest stable release published at least [`MIN_RELEASE_AGE`] before `now`.
/// `registry` is the output of `npm view <package> time versions --json`.
/// `time` still lists unpublished releases, so only entries also in
/// `versions` count.
fn settled_release(registry: &Value, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let published: Vec<&str> = registry["versions"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    registry["time"]
        .as_object()?
        .iter()
        .filter(|(version, _)| {
            published.contains(&version.as_str())
                && version.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
        .filter_map(|(version, time)| {
            let time = chrono::DateTime::parse_from_rfc3339(time.as_str()?).ok()?;
            (now - time.with_timezone(&chrono::Utc) >= MIN_RELEASE_AGE)
                .then(|| (version_parts(version), version))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, version)| version.clone())
}

fn run_npm(npm_path: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let output = host_cli_command(npm_path, cwd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run npm {} (is npm on PATH?): {e}", args[0]))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "npm {} failed: {}",
        args[0],
        if stderr.is_empty() { stdout } else { stderr }
    ))
}

fn fetch_settled_release(npm_path: &str) -> Result<String, String> {
    let raw = run_npm(
        npm_path,
        &["view", NPM_PACKAGE, "time", "versions", "--json"],
        None,
    )?;
    let registry: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to read agent-browser releases: {e}"))?;
    settled_release(&registry, chrono::Utc::now()).ok_or_else(|| {
        format!(
            "No agent-browser release is older than {} days",
            MIN_RELEASE_AGE.num_days()
        )
    })
}

/// Checks the output of `npm audit signatures --json --include-attestations`.
/// npm lists a package as verified only after it checks the signed SLSA
/// provenance. Anyone can publish with provenance from their own repo, so the
/// workflow repository must also be [`SOURCE_REPOSITORY`].
fn check_provenance(audit_json: &str, version: &str) -> Result<(), String> {
    use base64::Engine as _;

    let audit: Value = serde_json::from_str(audit_json)
        .map_err(|e| format!("Failed to read npm audit signatures output: {e}"))?;
    let find = |key: &str| {
        audit[key].as_array().into_iter().flatten().find(|entry| {
            entry["name"] == NPM_PACKAGE && entry["version"].as_str() == Some(version)
        })
    };
    if find("invalid").is_some() {
        return Err(format!(
            "agent-browser {version} has an invalid npm signature"
        ));
    }
    let Some(verified) = find("verified") else {
        return Err(format!(
            "agent-browser {version} has no verified provenance attestation"
        ));
    };
    let repository = verified["attestationBundles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|bundle| bundle["predicateType"] == "https://slsa.dev/provenance/v1")
        .find_map(|bundle| {
            let payload = bundle["bundle"]["dsseEnvelope"]["payload"].as_str()?;
            let payload = base64::engine::general_purpose::STANDARD
                .decode(payload)
                .ok()?;
            let statement: Value = serde_json::from_slice(&payload).ok()?;
            statement["predicate"]["buildDefinition"]["externalParameters"]["workflow"]
                ["repository"]
                .as_str()
                .map(str::to_string)
        });
    match repository.as_deref() {
        Some(SOURCE_REPOSITORY) => Ok(()),
        Some(other) => Err(format!(
            "agent-browser {version} was built from {other}, not {SOURCE_REPOSITORY}"
        )),
        None => Err(format!(
            "agent-browser {version} has no SLSA provenance with a source repository"
        )),
    }
}

fn installed_package_version(cli_dir: &Path) -> Option<String> {
    let manifest = cli_dir
        .join("node_modules")
        .join(NPM_PACKAGE)
        .join("package.json");
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
    manifest["version"].as_str().map(str::to_string)
}

/// Installs an exact version into a staging folder and moves it over
/// `cli_dir` only after the checks pass, so CLIs never start an unverified
/// binary. npm runs with scripts off until the provenance check passes; then
/// `npm rebuild` runs the postinstall script.
fn install_package(npm_path: &str, cli_dir: &Path, version: &str) -> Result<(), String> {
    let staging = cli_dir.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    let result =
        stage_package(npm_path, &staging, version).and_then(|()| replace_dir(&staging, cli_dir));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn stage_package(npm_path: &str, staging: &Path, version: &str) -> Result<(), String> {
    std::fs::create_dir_all(staging)
        .map_err(|e| format!("Failed to create {}: {e}", staging.display()))?;
    let prefix = staging.to_string_lossy();
    let spec = format!("{NPM_PACKAGE}@{version}");
    run_npm(
        npm_path,
        &[
            "install",
            "--ignore-scripts",
            "--save-exact",
            "--prefix",
            &prefix,
            &spec,
        ],
        None,
    )?;
    // npm exits non-zero for an invalid signature but still prints the JSON.
    let output = host_cli_command(npm_path, Some(staging))
        .args(["audit", "signatures", "--json", "--include-attestations"])
        .output()
        .map_err(|e| format!("Failed to run npm audit signatures: {e}"))?;
    check_provenance(&String::from_utf8_lossy(&output.stdout), version)?;
    run_npm(
        npm_path,
        &["rebuild", NPM_PACKAGE, "--prefix", &prefix],
        None,
    )?;
    if !managed_bin_path(staging).is_file() {
        return Err(format!(
            "npm did not create {}",
            managed_bin_path(staging).display()
        ));
    }
    Ok(())
}

/// Moves `from` to `to`. A running browser keeps its files, so `to` is first
/// renamed aside and restored if the second rename fails.
fn replace_dir(from: &Path, to: &Path) -> Result<(), String> {
    let old = to.with_extension("old");
    let _ = std::fs::remove_dir_all(&old);
    let had_old = to.exists();
    if had_old {
        std::fs::rename(to, &old)
            .map_err(|e| format!("Failed to move {} aside (is it in use?): {e}", to.display()))?;
    }
    if let Err(error) = std::fs::rename(from, to) {
        if had_old {
            let _ = std::fs::rename(&old, to);
        }
        return Err(format!(
            "Failed to move the new install into place: {error}"
        ));
    }
    if had_old {
        if let Err(error) = std::fs::remove_dir_all(&old) {
            log::warn!("Failed to remove {}: {error}", old.display());
        }
    }
    Ok(())
}

/// `chrome-<version>` folder names older than the newest
/// [`KEPT_CHROME_BUILDS`]. Other names are never returned.
fn stale_chrome_dirs(names: &[String]) -> Vec<String> {
    let mut builds: Vec<(Vec<u64>, &String)> = names
        .iter()
        .filter_map(|name| {
            let parts = version_parts(name.strip_prefix("chrome-")?);
            (!parts.is_empty()).then_some((parts, name))
        })
        .collect();
    builds.sort_by(|a, b| b.0.cmp(&a.0));
    builds
        .into_iter()
        .skip(KEPT_CHROME_BUILDS)
        .map(|(_, name)| name.clone())
        .collect()
}

/// Delete old Chrome builds from agent-browser's cache (`~/.agent-browser/browsers`).
/// Each `agent-browser install` adds a ~400 MB folder and never removes old ones.
fn prune_old_chrome_builds(browsers_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(browsers_dir) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    for name in stale_chrome_dirs(&names) {
        let path = browsers_dir.join(&name);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => log::info!("Removed old agent-browser Chrome {}", path.display()),
            Err(error) => log::warn!("Failed to remove {}: {error}", path.display()),
        }
    }
}

/// Install agent-browser via npm into Jean app data, then download Chromium
/// (`agent-browser install`). Idempotent reinstall/update.
///
/// Performs synchronous npm/network work; transports run it on the blocking
/// pool (see `dispatch_command_off_runtime`).
pub async fn install_agent_browser(app: AppHandle) -> Result<AgentBrowserStatus, String> {
    install_agent_browser_sync(&app)
}

pub(crate) fn install_agent_browser_sync(app: &AppHandle) -> Result<AgentBrowserStatus, String> {
    let _install = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let cli_dir = managed_cli_dir(app)?;
    let npm_path = crate::prerequisites::require_npm("agent-browser")?;
    let target = fetch_settled_release(&npm_path)?;
    // A broken install is repaired; a newer installed version is never downgraded.
    let needs_install = !managed_bin_path(&cli_dir).is_file()
        || installed_package_version(&cli_dir)
            .is_none_or(|installed| is_newer_version(&target, &installed));
    if needs_install {
        install_package(&npm_path, &cli_dir, &target)
            .map_err(|error| format!("agent-browser {target} was not installed: {error}"))?;
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

    if let Some(home) = dirs::home_dir() {
        prune_old_chrome_builds(&home.join(".agent-browser").join("browsers"));
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
        screenshot_dir(app),
    );

    Ok(AgentBrowserStatus {
        installed: true,
        binary_path: resolved.path,
        version: resolved.version,
        managed_dir: cli_dir.to_string_lossy().to_string(),
        managed_install: true,
        claude_snippet: entry.claude_snippet(),
        codex_snippet: entry.codex_snippet(),
        install_hint: "Turn on Agent Browser in Settings to install it. Manual fallback: npm install -g agent-browser@latest && agent-browser install".to_string(),
    })
}

/// CLI backends whose config files hold an agent-browser MCP entry.
const CONFIG_BACKENDS: [&str; 9] = [
    "claude",
    "codex",
    "opencode",
    "cursor",
    "grok",
    "kimi",
    "devin",
    "antigravity",
    "muse",
];

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
    let backends =
        backends.unwrap_or_else(|| CONFIG_BACKENDS.iter().map(|b| b.to_string()).collect());

    let mut results = Vec::with_capacity(backends.len());
    for backend in backends {
        let result = match backend.as_str() {
            "claude" => install_claude(&entry),
            "codex" => install_codex(&entry),
            "opencode" => install_opencode(&entry),
            "cursor" => install_cursor(&entry),
            "grok" => install_grok(&entry),
            "kimi" => install_kimi(&entry),
            "devin" => install_devin(&entry),
            "antigravity" => install_antigravity(&entry),
            "muse" => install_muse(&entry),
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

/// Remove the Jean-written `agent-browser` MCP entry from every CLI backend
/// config. Entries without Jean's restore key were added by the user and are
/// kept.
pub async fn remove_agent_browser_mcp() -> Result<Vec<AgentBrowserInstallResult>, String> {
    tauri::async_runtime::spawn_blocking(remove_agent_browser_mcp_sync)
        .await
        .map_err(|e| format!("agent-browser MCP removal task failed: {e}"))
}

pub(crate) fn remove_agent_browser_mcp_sync() -> Vec<AgentBrowserInstallResult> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    CONFIG_BACKENDS
        .iter()
        .filter_map(|backend| {
            let result = match *backend {
                "claude" => remove_json_server(&home.join(".claude.json"), "mcpServers", "env"),
                "cursor" => {
                    remove_json_server(&home.join(".cursor").join("mcp.json"), "mcpServers", "env")
                }
                "kimi" => remove_json_server(
                    &home.join(".kimi-code").join("mcp.json"),
                    "mcpServers",
                    "env",
                ),
                "antigravity" => remove_json_server(
                    &home.join(".gemini").join("config").join("mcp_config.json"),
                    "mcpServers",
                    "env",
                ),
                "muse" => match crate::muse_cli::settings_path() {
                    Some(path) => remove_json_server(&path, "mcp_servers", "env"),
                    None => Ok(None),
                },
                "opencode" => match find_opencode_config_path(&home) {
                    Some(path) => remove_json_server(&path, "mcp", "environment"),
                    None => Ok(None),
                },
                "codex" => remove_toml_server(&home.join(".codex").join("config.toml")),
                "grok" => remove_toml_server(&home.join(".grok").join("config.toml")),
                _ => Ok(None),
            };
            let (status, path, backup_path, message) = match result {
                Ok(None) => return None,
                Ok(Some((path, backup))) => (
                    "removed",
                    Some(path.to_string_lossy().to_string()),
                    backup.map(|p| p.to_string_lossy().to_string()),
                    format!("Removed {MCP_SERVER_NAME}"),
                ),
                Err(error) => ("error", None, None, error),
            };
            Some(AgentBrowserInstallResult {
                backend: backend.to_string(),
                status: status.to_string(),
                path,
                backup_path,
                server_name: MCP_SERVER_NAME.to_string(),
                message,
            })
        })
        .collect()
}

/// Whether an MCP entry env map holds Jean's restore key.
fn is_jean_env(env: Option<&Value>) -> bool {
    env.and_then(|env| env.get(RESTORE_ENV))
        .and_then(Value::as_str)
        == Some(RESTORE_KEY)
}

/// Returns `Ok(None)` when the file has no Jean-written entry.
fn remove_json_server(
    path: &Path,
    container_key: &str,
    env_key: &str,
) -> Result<Option<(PathBuf, Option<PathBuf>)>, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };
    if content.trim().is_empty() {
        return Ok(None);
    }
    let mut root: Value = serde_json::from_str(&strip_jsonc_comments_simple(&content))
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    let Some(container) = root.get_mut(container_key).and_then(Value::as_object_mut) else {
        return Ok(None);
    };
    if !container
        .get(MCP_SERVER_NAME)
        .is_some_and(|server| is_jean_env(server.get(env_key)))
    {
        return Ok(None);
    }
    container.remove(MCP_SERVER_NAME);

    let updated = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    let backup = crate::platform::write_file_atomically_with_backup(path, updated.as_bytes())?;
    Ok(Some((path.to_path_buf(), backup)))
}

/// Returns `Ok(None)` when the file has no Jean-written entry.
fn remove_toml_server(path: &Path) -> Result<Option<(PathBuf, Option<PathBuf>)>, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };
    let mut doc = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    let is_jean = doc
        .get("mcp_servers")
        .and_then(|servers| servers.get(MCP_SERVER_NAME))
        .and_then(|server| server.get("env"))
        .and_then(|env| env.get(RESTORE_ENV))
        .and_then(|value| value.as_str())
        == Some(RESTORE_KEY);
    if !is_jean {
        return Ok(None);
    }
    if let Some(servers) = doc
        .get_mut("mcp_servers")
        .and_then(|item| item.as_table_like_mut())
    {
        servers.remove(MCP_SERVER_NAME);
    }

    let backup =
        crate::platform::write_file_atomically_with_backup(path, doc.to_string().as_bytes())?;
    Ok(Some((path.to_path_buf(), backup)))
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

fn install_devin(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let dir = crate::devin_cli::mcp::user_config_dir()
        .ok_or_else(|| "Devin config directory unavailable".to_string())?;
    install_json_server(
        dir.join("mcp_config.json"),
        "mcpServers",
        entry.claude_server_json(),
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

fn install_muse(entry: &McpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let path =
        crate::muse_cli::settings_path().ok_or_else(|| "Home directory unavailable".to_string())?;
    crate::jean_mcp_config::ensure_muse_settings_file(&path)?;
    install_json_server(path, "mcp_servers", entry.muse_server_json())
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
        let entry = McpEntry::new("agent-browser".to_string(), None);

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
    let backup = crate::platform::write_file_atomically_with_backup(&path, updated.as_bytes())?;
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
    let backup = crate::platform::write_file_atomically_with_backup(&path, updated.as_bytes())?;
    Ok((path, backup))
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
        let server = McpEntry::new("agent-browser".into(), None).claude_server_json();
        assert_eq!(server["args"], json!(["mcp"]));
        assert_eq!(server["env"]["AGENT_BROWSER_RESTORE"], "jean");
        assert_eq!(server["env"]["AGENT_BROWSER_IDLE_TIMEOUT_MS"], "900000");
        // A shared profile is locked by one Chrome and blocks parallel sessions.
        assert!(server["env"].get("AGENT_BROWSER_PROFILE").is_none());
        // The session is set per run, never globally.
        assert!(server["env"].get(SESSION_ENV).is_none());
        assert!(server["env"].get(SCREENSHOT_DIR_ENV).is_none());
    }

    #[test]
    fn mcp_entry_sets_screenshot_dir_in_every_config_format() {
        let dir = PathBuf::from(r"C:\Users\me\AppData\com.jean.desktop\browser-screenshots");
        let entry = McpEntry::new("agent-browser".into(), Some(dir.clone()));
        let expected = dir.to_string_lossy().to_string();

        assert_eq!(
            entry.claude_server_json()["env"][SCREENSHOT_DIR_ENV],
            expected
        );
        assert_eq!(
            entry.opencode_server_json()["environment"][SCREENSHOT_DIR_ENV],
            expected
        );
        let doc = entry
            .codex_snippet()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert_eq!(
            doc["mcp_servers"]["agent-browser"]["env"][SCREENSHOT_DIR_ENV].as_str(),
            Some(expected.as_str())
        );
        assert_eq!(
            entry.codex_table_item()["env"][SCREENSHOT_DIR_ENV].as_str(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn prune_removes_only_files_older_than_max_age() {
        let dir = TempDir::new().unwrap();
        let old = dir.path().join("old.png");
        let fresh = dir.path().join("fresh.png");
        fs::write(&old, b"old").unwrap();
        fs::write(&fresh, b"fresh").unwrap();
        let month_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(31 * 86400);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(month_ago)
            .unwrap();

        assert_eq!(prune_files_older_than(dir.path(), SCREENSHOT_MAX_AGE), 1);
        assert!(!old.exists());
        assert!(fresh.exists());
        assert_eq!(
            prune_files_older_than(&dir.path().join("missing"), SCREENSHOT_MAX_AGE),
            0
        );
    }

    #[test]
    fn mcp_entry_codex_snippet_is_valid_toml() {
        let snippet = McpEntry::new("agent-browser".into(), None).codex_snippet();
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
            &McpEntry::new("agent-browser".into(), None),
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

        let entry = McpEntry::new("agent-browser".into(), None);
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

        let entry = McpEntry::new("/usr/bin/agent-browser".into(), None);
        install_toml_server(path.clone(), &entry, "Codex", false).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[mcp_servers.existing]"));
        assert!(content.contains("[mcp_servers.agent-browser]"));
        assert!(content.contains("/usr/bin/agent-browser"));
        assert!(content.contains("AGENT_BROWSER_RESTORE"));
    }

    #[test]
    fn remove_json_server_removes_only_jean_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{ "mcpServers": { "other": { "command": "x" } } }"#,
        )
        .unwrap();
        let entry = McpEntry::new("agent-browser".into(), None);
        install_json_server(path.clone(), "mcpServers", entry.claude_server_json()).unwrap();

        assert!(remove_json_server(&path, "mcpServers", "env")
            .unwrap()
            .is_some());
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed["mcpServers"]["other"].is_object());
        assert!(parsed["mcpServers"].get(MCP_SERVER_NAME).is_none());

        // A user-added entry without Jean's restore key is kept.
        fs::write(
            &path,
            r#"{ "mcpServers": { "agent-browser": { "command": "agent-browser" } } }"#,
        )
        .unwrap();
        assert!(remove_json_server(&path, "mcpServers", "env")
            .unwrap()
            .is_none());
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed["mcpServers"][MCP_SERVER_NAME].is_object());
    }

    #[test]
    fn remove_toml_server_removes_only_jean_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[mcp_servers.existing]\ncommand = \"foo\"\n").unwrap();
        let entry = McpEntry::new("/usr/bin/agent-browser".into(), None);
        install_toml_server(path.clone(), &entry, "Codex", false).unwrap();

        assert!(remove_toml_server(&path).unwrap().is_some());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[mcp_servers.existing]"));
        assert!(!content.contains("agent-browser"));
        assert!(codex_session_config_override_at(&path, "s").is_none());

        fs::write(&path, "[mcp_servers.agent-browser]\ncommand = \"x\"\n").unwrap();
        assert!(remove_toml_server(&path).unwrap().is_none());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("[mcp_servers.agent-browser]"));
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
    fn settled_release_picks_newest_published_stable_release_at_least_three_days_old() {
        let registry = json!({
            "versions": ["0.9.0", "0.10.0", "0.10.1-beta.1", "0.11.0"],
            "time": {
                "created": "2026-01-01T00:00:00.000Z",
                "modified": "2026-11-03T00:00:00.000Z",
                "0.9.0": "2026-10-01T00:00:00.000Z",
                "0.10.0": "2026-10-20T00:00:00.000Z",
                "0.10.1-beta.1": "2026-10-01T00:00:00.000Z",
                "0.10.5": "2026-10-25T00:00:00.000Z",
                "0.11.0": "2026-11-01T00:00:00.000Z",
            },
        });
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-03T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        // 0.10.5 was unpublished, 0.11.0 is too new.
        assert_eq!(settled_release(&registry, now).as_deref(), Some("0.10.0"));
        let early = now - chrono::TimeDelta::days(30);
        assert_eq!(settled_release(&registry, early).as_deref(), Some("0.9.0"));
        let too_early = now - chrono::TimeDelta::days(40);
        assert_eq!(settled_release(&registry, too_early), None);
    }

    fn audit_json(list: &str, repository: &str) -> String {
        use base64::Engine as _;
        let statement = json!({
            "predicate": { "buildDefinition": { "externalParameters": {
                "workflow": { "repository": repository, "path": ".github/workflows/release.yml" }
            } } }
        });
        let payload = base64::engine::general_purpose::STANDARD.encode(statement.to_string());
        let entry = json!({
            "name": "agent-browser",
            "version": "0.41.0",
            "attestationBundles": [
                { "predicateType": "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
                  "bundle": { "dsseEnvelope": { "payload": "" } } },
                { "predicateType": "https://slsa.dev/provenance/v1",
                  "bundle": { "dsseEnvelope": { "payload": payload } } },
            ],
        });
        let mut audit = json!({ "invalid": [], "missing": [], "verified": [] });
        audit[list] = json!([entry]);
        audit.to_string()
    }

    #[test]
    fn check_provenance_requires_slsa_provenance_from_the_source_repository() {
        let verified = audit_json("verified", SOURCE_REPOSITORY);
        assert_eq!(check_provenance(&verified, "0.41.0"), Ok(()));
        assert_eq!(
            check_provenance(&verified, "0.41.1"),
            Err("agent-browser 0.41.1 has no verified provenance attestation".to_string())
        );
        assert_eq!(
            check_provenance(&audit_json("verified", "https://github.com/evil/fork"), "0.41.0"),
            Err("agent-browser 0.41.0 was built from https://github.com/evil/fork, not https://github.com/vercel-labs/agent-browser".to_string())
        );
        assert_eq!(
            check_provenance(&audit_json("invalid", SOURCE_REPOSITORY), "0.41.0"),
            Err("agent-browser 0.41.0 has an invalid npm signature".to_string())
        );
        assert!(check_provenance("npm ERR!", "0.41.0").is_err());
    }

    #[test]
    fn replace_dir_swaps_in_the_new_install_and_removes_the_old_one() {
        let dir = TempDir::new().unwrap();
        let live = dir.path().join("agent-browser-cli");
        let staging = dir.path().join("agent-browser-cli.staging");
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("version"), "old").unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("version"), "new").unwrap();

        replace_dir(&staging, &live).unwrap();

        assert_eq!(fs::read_to_string(live.join("version")).unwrap(), "new");
        assert!(!staging.exists());
        assert!(!dir.path().join("agent-browser-cli.old").exists());
    }

    #[test]
    fn prune_old_chrome_builds_keeps_two_newest_and_other_folders() {
        let dir = TempDir::new().unwrap();
        for name in [
            "chrome-153.0.8010.36",
            "chrome-156.0.8078.9",
            "chrome-156.0.8078.80",
            "chrome-156.0.8078.73",
            "chrome-latest",
            "firefox-1538",
        ] {
            fs::create_dir(dir.path().join(name)).unwrap();
        }
        fs::write(dir.path().join("chrome-1.0.0"), "file, not a build").unwrap();

        prune_old_chrome_builds(dir.path());

        let mut left: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "chrome-1.0.0",
                "chrome-156.0.8078.73",
                "chrome-156.0.8078.80",
                "chrome-latest",
                "firefox-1538",
            ]
        );
    }
}

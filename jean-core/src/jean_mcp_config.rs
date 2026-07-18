//! Safe installers for Jean's own MCP server in third-party CLI configs.
//!
//! The writers are intentionally narrow:
//! - Codex TOML uses `toml_edit` so comments/order outside our table survive.
//! - JSON/JSONC configs are patched by source spans so unrelated comments survive.
//! - Every write is backed up, validated, and committed via same-directory rename.

use crate::jean_mcp_core::{
    JEAN_MCP_DEPTH_ENV, JEAN_MCP_SESSION_ENV, JEAN_MCP_SOCKET_ENV, JEAN_MCP_STDIO_ARG,
    JEAN_MCP_TOKEN_ENV,
};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

pub const JEAN_MCP_MODE_ENV: &str = "JEAN_MCP_MODE";

static CONFIG_FILE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JeanMcpInstallMode {
    Dev,
    Prod,
}

impl JeanMcpInstallMode {
    pub fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Dev
        } else {
            Self::Prod
        }
    }

    fn from_option(value: Option<String>) -> Result<Self, String> {
        match value.as_deref() {
            None | Some("current") => Ok(Self::current()),
            Some("dev") => Ok(Self::Dev),
            Some("prod") => Ok(Self::Prod),
            Some(other) => Err(format!("Unsupported Jean MCP install mode: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Prod => "prod",
        }
    }

    pub fn server_name(self) -> &'static str {
        match self {
            Self::Dev => "jean-dev",
            Self::Prod => "jean",
        }
    }

    fn session_label(self) -> &'static str {
        match self {
            Self::Dev => "manual-dev",
            Self::Prod => "manual-prod",
        }
    }
}

#[derive(Clone, Debug)]
pub struct JeanMcpEntry {
    pub mode: JeanMcpInstallMode,
    pub server_name: String,
    pub command: String,
    pub socket: String,
    pub token: String,
}

impl JeanMcpEntry {
    pub fn env(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut env = serde_json::Map::new();
        env.insert(JEAN_MCP_SOCKET_ENV.into(), self.socket.clone().into());
        env.insert(JEAN_MCP_TOKEN_ENV.into(), self.token.clone().into());
        env.insert(
            JEAN_MCP_SESSION_ENV.into(),
            self.mode.session_label().into(),
        );
        env.insert(JEAN_MCP_DEPTH_ENV.into(), "0".into());
        env.insert(JEAN_MCP_MODE_ENV.into(), self.mode.as_str().into());
        env
    }

    pub fn claude_server_json(&self) -> serde_json::Value {
        json!({
            "type": "stdio",
            "command": self.command,
            "args": [JEAN_MCP_STDIO_ARG],
            "env": self.env(),
        })
    }

    pub fn cursor_server_json(&self) -> serde_json::Value {
        self.claude_server_json()
    }

    pub fn claude_snippet(&self) -> String {
        let v = json!({
            "mcpServers": {
                self.server_name.clone(): self.claude_server_json()
            }
        });
        serde_json::to_string_pretty(&v).unwrap_or_default()
    }

    pub fn cursor_snippet(&self) -> String {
        let v = json!({
            "mcpServers": {
                self.server_name.clone(): self.cursor_server_json()
            }
        });
        serde_json::to_string_pretty(&v).unwrap_or_default()
    }

    pub fn opencode_server_json(&self) -> serde_json::Value {
        json!({
            "type": "local",
            "command": [self.command, JEAN_MCP_STDIO_ARG],
            "enabled": true,
            "environment": self.env(),
        })
    }

    pub fn opencode_snippet(&self) -> String {
        let v = json!({
            "mcp": {
                self.server_name.clone(): self.opencode_server_json()
            }
        });
        serde_json::to_string_pretty(&v).unwrap_or_default()
    }

    pub fn codex_table_item(&self) -> toml_edit::Item {
        let mut table = toml_edit::Table::new();
        table["command"] = toml_edit::value(self.command.clone());
        table["args"] = toml_edit::value(toml_edit::Array::from_iter([JEAN_MCP_STDIO_ARG]));

        let mut env = toml_edit::InlineTable::new();
        env.insert(JEAN_MCP_SOCKET_ENV, self.socket.clone().into());
        env.insert(JEAN_MCP_TOKEN_ENV, self.token.clone().into());
        env.insert(JEAN_MCP_SESSION_ENV, self.mode.session_label().into());
        env.insert(JEAN_MCP_DEPTH_ENV, "0".into());
        env.insert(JEAN_MCP_MODE_ENV, self.mode.as_str().into());
        table["env"] = toml_edit::value(env);
        table["enabled"] = toml_edit::value(true);
        toml_edit::Item::Table(table)
    }

    pub fn codex_snippet(&self) -> String {
        format!(
            "[mcp_servers.{}]\ncommand = \"{}\"\nargs = [\"{}\"]\nenv = {{ {} = \"{}\", {} = \"{}\", {} = \"{}\", {} = \"0\", {} = \"{}\" }}\nenabled = true\n",
            self.server_name,
            escape_toml_string(&self.command),
            JEAN_MCP_STDIO_ARG,
            JEAN_MCP_SOCKET_ENV,
            escape_toml_string(&self.socket),
            JEAN_MCP_TOKEN_ENV,
            escape_toml_string(&self.token),
            JEAN_MCP_SESSION_ENV,
            self.mode.session_label(),
            JEAN_MCP_DEPTH_ENV,
            JEAN_MCP_MODE_ENV,
            self.mode.as_str(),
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JeanMcpInstallResult {
    pub backend: String,
    pub status: String,
    pub path: Option<String>,
    pub backup_path: Option<String>,
    pub server_name: String,
    pub mode: JeanMcpInstallMode,
    pub message: String,
}

pub fn current_mode() -> JeanMcpInstallMode {
    JeanMcpInstallMode::current()
}

pub fn get_stable_launcher_command() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "jean".to_string();
    };
    if launcher_path_is_unstable(&exe) {
        return "jean".to_string();
    }
    exe.to_string_lossy().to_string()
}

fn launcher_path_is_unstable(path: &Path) -> bool {
    launcher_path_is_unstable_with_container_env(path, has_container_launcher_env())
}

fn launcher_path_is_unstable_with_container_env(path: &Path, has_container_env: bool) -> bool {
    if has_container_env {
        return true;
    }

    let path_str = path.to_string_lossy();
    path_str.contains("/.mount_")
}

fn has_container_launcher_env() -> bool {
    std::env::var_os("APPIMAGE").is_some()
        || std::env::var_os("SNAP").is_some()
        || std::env::var_os("FLATPAK_ID").is_some()
        || std::env::var_os("FLATPAK_SANDBOX_DIR").is_some()
}

pub async fn build_current_entry(
    app: AppHandle,
    mode: JeanMcpInstallMode,
) -> Result<JeanMcpEntry, String> {
    let (running, socket_path, token) = crate::jean_mcp_socket::get_socket_status(app).await;
    if !running {
        return Err("Jean MCP socket is not running".to_string());
    }
    let socket = socket_path.ok_or_else(|| "Jean MCP socket path is unavailable".to_string())?;
    let token = token.ok_or_else(|| "Jean MCP token is unavailable".to_string())?;
    let command = get_stable_launcher_command();

    Ok(JeanMcpEntry {
        mode,
        server_name: mode.server_name().to_string(),
        command,
        socket,
        token,
    })
}

pub async fn install_jean_mcp_config_impl(
    app: AppHandle,
    backends: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<Vec<JeanMcpInstallResult>, String> {
    let mode = JeanMcpInstallMode::from_option(mode)?;
    let entry = build_current_entry(app, mode).await?;
    let backends = backends.unwrap_or_else(|| {
        vec![
            "claude".to_string(),
            "codex".to_string(),
            "opencode".to_string(),
            "cursor".to_string(),
        ]
    });

    let mut results = Vec::with_capacity(backends.len());
    for backend in backends {
        let result = match backend.as_str() {
            "claude" => install_claude(&entry),
            "codex" => install_codex(&entry),
            "opencode" => install_opencode(&entry),
            "cursor" => install_cursor(&entry),
            other => Err(format!("Unsupported MCP config backend: {other}")),
        };
        results.push(match result {
            Ok((path, backup_path)) => JeanMcpInstallResult {
                backend,
                status: "installed".to_string(),
                path: Some(path.to_string_lossy().to_string()),
                backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
                server_name: entry.server_name.clone(),
                mode,
                message: format!("Installed {}", entry.server_name),
            },
            Err(error) => JeanMcpInstallResult {
                backend,
                status: "error".to_string(),
                path: None,
                backup_path: None,
                server_name: entry.server_name.clone(),
                mode,
                message: error,
            },
        });
    }

    Ok(results)
}

fn install_claude(entry: &JeanMcpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_jsonc_server(
        home.join(".claude.json"),
        "mcpServers",
        entry,
        JeanMcpEntry::claude_server_json,
    )
}

fn install_opencode(entry: &JeanMcpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    let path = find_opencode_config_path(&home)
        .unwrap_or_else(|| home.join(".config").join("opencode").join("opencode.json"));
    install_jsonc_server(path, "mcp", entry, JeanMcpEntry::opencode_server_json)
}

fn install_cursor(entry: &JeanMcpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    install_jsonc_server(
        home.join(".cursor").join("mcp.json"),
        "mcpServers",
        entry,
        JeanMcpEntry::cursor_server_json,
    )
}

fn install_jsonc_server(
    path: PathBuf,
    container_key: &str,
    entry: &JeanMcpEntry,
    server_json: fn(&JeanMcpEntry) -> serde_json::Value,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    with_config_lock(&path, || {
        let content = read_optional(&path)?;
        let value = server_json(entry);
        let updated = if content.trim().is_empty() {
            serde_json::to_string_pretty(&json!({
                container_key: {
                    entry.server_name.clone(): value
                }
            }))
            .unwrap_or_default()
        } else {
            patch_jsonc_object_property(&content, container_key, &entry.server_name, &value)?
        };
        validate_jsonc(&updated, &path)?;
        let backup = write_atomic_with_backup(&path, &updated)?;
        Ok((path.clone(), backup))
    })
}

fn install_codex(entry: &JeanMcpEntry) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
    let path = home.join(".codex").join("config.toml");
    with_config_lock(&path, || {
        let content = read_optional(&path)?;
        let mut doc = if content.trim().is_empty() {
            toml_edit::DocumentMut::new()
        } else {
            content
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("Failed to parse Codex TOML {}: {e}", path.display()))?
        };

        if !doc.as_table().contains_key("mcp_servers") {
            doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        doc["mcp_servers"][&entry.server_name] = entry.codex_table_item();

        let updated = doc.to_string();
        updated
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Generated invalid Codex TOML: {e}"))?;
        let backup = write_atomic_with_backup(&path, &updated)?;
        Ok((path.clone(), backup))
    })
}

fn find_opencode_config_path(home: &Path) -> Option<PathBuf> {
    // OpenCode's current user config lives under ~/.config/opencode.
    // Prefer that over repo/local ~/opencode.json files so automatic install
    // updates the same path advertised in the UI and read by OpenCode.
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

fn with_config_lock<T>(path: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let key = path.to_string_lossy().to_string();
    let lock = CONFIG_FILE_LOCKS
        .lock()
        .map_err(|_| "Failed to acquire config lock registry".to_string())?
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let _guard = lock
        .lock()
        .map_err(|_| "Failed to acquire config file lock".to_string())?;
    f()
}

fn read_optional(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    }
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

    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("config")
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        format!(
            "Failed to replace {} with {}: {e}",
            path.display(),
            tmp.display()
        )
    })?;
    Ok(backup)
}

fn validate_jsonc(content: &str, path: &Path) -> Result<(), String> {
    let cleaned = strip_jsonc_comments(content);
    let cleaned = strip_trailing_commas(&cleaned);
    serde_json::from_str::<serde_json::Value>(&cleaned)
        .map(|_| ())
        .map_err(|e| format!("Invalid JSONC for {}: {e}", path.display()))
}

fn patch_jsonc_object_property(
    input: &str,
    container_key: &str,
    server_key: &str,
    value: &serde_json::Value,
) -> Result<String, String> {
    validate_jsonc(input, Path::new("input config"))?;
    let root =
        find_root_object(input).ok_or_else(|| "Config root must be an object".to_string())?;
    let value_pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());

    if let Some(container) = find_property(input, root.open + 1, root.close, container_key) {
        let container_value = find_value_span(input, container.value_start)
            .ok_or_else(|| format!("Could not locate {container_key} value"))?;
        if !matches!(byte_at(input, container_value.start), Some(b'{')) {
            return Err(format!("{container_key} must be an object"));
        }
        let container_object = ObjectSpan {
            open: container_value.start,
            close: container_value.end - 1,
        };
        return patch_property_inside_object(input, container_object, server_key, &value_pretty);
    }

    let container_value = serde_json::to_string_pretty(&json!({ server_key: value }))
        .unwrap_or_else(|_| "{}".to_string());
    let property = format!("\"{container_key}\": {container_value}");
    insert_property_inside_object(input, root, &property)
}

fn patch_property_inside_object(
    input: &str,
    object: ObjectSpan,
    key: &str,
    value_pretty: &str,
) -> Result<String, String> {
    let child_indent = object_child_indent(input, object);
    let property_value = indent_multiline(value_pretty, &child_indent);
    let replacement = format!("\"{key}\": {property_value}");
    if let Some(existing) = find_property(input, object.open + 1, object.close, key) {
        let mut out = String::with_capacity(input.len() + replacement.len());
        out.push_str(&input[..existing.key_start]);
        out.push_str(&replacement);
        out.push_str(&input[existing.value_end..]);
        Ok(out)
    } else {
        insert_property_inside_object(input, object, &replacement)
    }
}

fn insert_property_inside_object(
    input: &str,
    object: ObjectSpan,
    property: &str,
) -> Result<String, String> {
    let child_indent = object_child_indent(input, object);
    let base_indent = object_base_indent(input, object.open);
    let property = indent_multiline(property, &child_indent);
    let prefix = if object_has_significant_content(input, object) {
        if object_last_significant_byte(input, object) == Some(b',') {
            "\n".to_string()
        } else {
            ",\n".to_string()
        }
    } else {
        "\n".to_string()
    };
    let suffix = format!("\n{base_indent}");
    let mut out = String::with_capacity(input.len() + property.len() + 8);
    out.push_str(&input[..object.close]);
    out.push_str(&prefix);
    out.push_str(&child_indent);
    out.push_str(&property);
    out.push_str(&suffix);
    out.push_str(&input[object.close..]);
    Ok(out)
}

fn indent_multiline(value: &str, indent: &str) -> String {
    value
        .lines()
        .enumerate()
        .map(|(idx, line)| {
            if idx == 0 {
                line.to_string()
            } else {
                format!("{indent}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Copy)]
struct ObjectSpan {
    open: usize,
    close: usize,
}

struct PropertySpan {
    key_start: usize,
    value_start: usize,
    value_end: usize,
}

fn find_root_object(input: &str) -> Option<ObjectSpan> {
    let i = skip_ws_comments(input, 0);
    if byte_at(input, i)? != b'{' {
        return None;
    }
    let end = matching_compound_end(input, i)?;
    Some(ObjectSpan {
        open: i,
        close: end,
    })
}

fn find_property(input: &str, start: usize, end: usize, key: &str) -> Option<PropertySpan> {
    let mut i = start;
    while i < end {
        i = skip_ws_comments(input, i);
        if i >= end || byte_at(input, i) == Some(b'}') {
            return None;
        }
        if byte_at(input, i) == Some(b',') {
            i += 1;
            continue;
        }
        if byte_at(input, i) != Some(b'"') {
            i += 1;
            continue;
        }
        let key_start = i;
        let (decoded, key_end) = parse_json_string(input, i)?;
        let colon = skip_ws_comments(input, key_end);
        if byte_at(input, colon) != Some(b':') {
            i = key_end;
            continue;
        }
        let value_start = skip_ws_comments(input, colon + 1);
        let value = find_value_span(input, value_start)?;
        if decoded == key {
            return Some(PropertySpan {
                key_start,
                value_start,
                value_end: value.end,
            });
        }
        i = value.end;
    }
    None
}

struct ValueSpan {
    start: usize,
    end: usize,
}

fn find_value_span(input: &str, start: usize) -> Option<ValueSpan> {
    match byte_at(input, start)? {
        b'{' | b'[' => {
            let end = matching_compound_end(input, start)?;
            Some(ValueSpan {
                start,
                end: end + 1,
            })
        }
        b'"' => {
            let (_, end) = parse_json_string(input, start)?;
            Some(ValueSpan { start, end })
        }
        _ => {
            let mut i = start;
            while i < input.len() {
                match byte_at(input, i) {
                    Some(b',') | Some(b'}') | Some(b']') => break,
                    Some(b'/') if byte_at(input, i + 1) == Some(b'/') => break,
                    Some(b'/') if byte_at(input, i + 1) == Some(b'*') => break,
                    Some(_) => i += 1,
                    None => break,
                }
            }
            while i > start && input.as_bytes()[i - 1].is_ascii_whitespace() {
                i -= 1;
            }
            Some(ValueSpan { start, end: i })
        }
    }
}

fn matching_compound_end(input: &str, open: usize) -> Option<usize> {
    let open_b = byte_at(input, open)?;
    let close_b = match open_b {
        b'{' => b'}',
        b'[' => b']',
        _ => return None,
    };
    let mut depth = 0usize;
    let mut i = open;
    while i < input.len() {
        match byte_at(input, i)? {
            b'"' => {
                let (_, end) = parse_json_string(input, i)?;
                i = end;
                continue;
            }
            b'/' if byte_at(input, i + 1) == Some(b'/') => {
                i += 2;
                while i < input.len() && byte_at(input, i) != Some(b'\n') {
                    i += 1;
                }
                continue;
            }
            b'/' if byte_at(input, i + 1) == Some(b'*') => {
                i += 2;
                while i + 1 < input.len()
                    && !(byte_at(input, i) == Some(b'*') && byte_at(input, i + 1) == Some(b'/'))
                {
                    i += 1;
                }
                i += 2;
                continue;
            }
            b if b == open_b => depth += 1,
            b if b == close_b => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn parse_json_string(input: &str, start: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut i = start + 1;
    while i < input.len() {
        let b = byte_at(input, i)?;
        if b == b'\\' {
            out.push('\\');
            i += 1;
            if i < input.len() {
                out.push(byte_at(input, i)? as char);
                i += 1;
            }
            continue;
        }
        if b == b'"' {
            let raw = &input[start..=i];
            let decoded = serde_json::from_str::<String>(raw).unwrap_or(out);
            return Some((decoded, i + 1));
        }
        out.push(b as char);
        i += 1;
    }
    None
}

fn skip_ws_comments(input: &str, mut i: usize) -> usize {
    loop {
        while i < input.len() && input.as_bytes()[i].is_ascii_whitespace() {
            i += 1;
        }
        if byte_at(input, i) == Some(b'/') && byte_at(input, i + 1) == Some(b'/') {
            i += 2;
            while i < input.len() && byte_at(input, i) != Some(b'\n') {
                i += 1;
            }
            continue;
        }
        if byte_at(input, i) == Some(b'/') && byte_at(input, i + 1) == Some(b'*') {
            i += 2;
            while i + 1 < input.len()
                && !(byte_at(input, i) == Some(b'*') && byte_at(input, i + 1) == Some(b'/'))
            {
                i += 1;
            }
            i += 2;
            continue;
        }
        break;
    }
    i
}

fn object_base_indent(input: &str, open: usize) -> String {
    input[..open]
        .rsplit_once('\n')
        .map(|(_, line)| {
            line.chars()
                .take_while(|c| matches!(*c, ' ' | '\t'))
                .collect()
        })
        .unwrap_or_default()
}

fn object_child_indent(input: &str, object: ObjectSpan) -> String {
    let mut i = object.open + 1;
    while i < object.close {
        match byte_at(input, i) {
            Some(b'\n') => {
                let line_start = i + 1;
                let mut j = line_start;
                while j < object.close && matches!(byte_at(input, j), Some(b' ' | b'\t')) {
                    j += 1;
                }
                if j < object.close && !matches!(byte_at(input, j), Some(b'\n' | b'\r' | b'}')) {
                    return input[line_start..j].to_string();
                }
                i = j;
            }
            Some(b'"') => {
                let base = object_base_indent(input, object.open);
                return format!("{base}  ");
            }
            Some(_) => i += 1,
            None => break,
        }
    }
    format!("{}  ", object_base_indent(input, object.open))
}

fn object_has_significant_content(input: &str, object: ObjectSpan) -> bool {
    object_last_significant_byte(input, object).is_some()
}

fn object_last_significant_byte(input: &str, object: ObjectSpan) -> Option<u8> {
    let mut i = object.open + 1;
    let mut last = None;
    while i < object.close {
        match byte_at(input, i)? {
            b'"' => {
                last = Some(b'"');
                let (_, end) = parse_json_string(input, i)?;
                i = end;
            }
            b'/' if byte_at(input, i + 1) == Some(b'/') => {
                i += 2;
                while i < input.len() && byte_at(input, i) != Some(b'\n') {
                    i += 1;
                }
            }
            b'/' if byte_at(input, i + 1) == Some(b'*') => {
                i += 2;
                while i + 1 < input.len()
                    && !(byte_at(input, i) == Some(b'*') && byte_at(input, i + 1) == Some(b'/'))
                {
                    i += 1;
                }
                i += 2;
            }
            b if b.is_ascii_whitespace() => i += 1,
            b => {
                last = Some(b);
                i += 1;
            }
        }
    }
    last
}

fn byte_at(input: &str, idx: usize) -> Option<u8> {
    input.as_bytes().get(idx).copied()
}

fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(&ch) = chars.peek() {
        if in_string {
            out.push(ch);
            chars.next();
            if ch == '\\' {
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
            chars.next();
        } else if ch == '/' {
            chars.next();
            match chars.peek() {
                Some(&'/') => {
                    for c in chars.by_ref() {
                        if c == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => out.push('/'),
            }
        } else {
            out.push(ch);
            chars.next();
        }
    }

    out
}

fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }

        if ch == ',' {
            let mut lookahead = chars.clone();
            while matches!(lookahead.peek(), Some(c) if c.is_whitespace()) {
                lookahead.next();
            }
            if matches!(lookahead.peek(), Some('}' | ']')) {
                continue;
            }
        }

        out.push(ch);
    }

    out
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_entry(mode: JeanMcpInstallMode) -> JeanMcpEntry {
        JeanMcpEntry {
            mode,
            server_name: mode.server_name().to_string(),
            command: "/tmp/Jean Dev.app/Contents/MacOS/jean".to_string(),
            socket: "/tmp/jean.sock".to_string(),
            token: "tok".to_string(),
        }
    }

    #[test]
    fn launcher_path_treats_dev_binary_as_stable() {
        let path =
            Path::new("/Users/heyandras/jean/jean/solid-dolphin/src-tauri/target/debug/jean");

        assert!(!launcher_path_is_unstable_with_container_env(path, false));
    }

    #[test]
    fn launcher_path_treats_macos_app_binary_as_stable() {
        let path = Path::new("/Applications/Jean.app/Contents/MacOS/jean");

        assert!(!launcher_path_is_unstable_with_container_env(path, false));
    }

    #[test]
    fn launcher_path_treats_appimage_mount_as_unstable() {
        let path = Path::new("/tmp/.mount_JeanAbc/usr/bin/jean");

        assert!(launcher_path_is_unstable_with_container_env(path, false));
    }

    #[test]
    fn launcher_path_treats_container_launcher_env_as_unstable() {
        let path = Path::new("/usr/bin/jean");

        assert!(launcher_path_is_unstable_with_container_env(path, true));
    }

    #[test]
    fn jsonc_patch_preserves_comments_and_adds_dev_prod() {
        let input = r#"{
  // keep this
  "mcp": {
    "existing": { "url": "x" } // existing comment
  }
}"#;
        let dev = test_entry(JeanMcpInstallMode::Dev);
        let prod = test_entry(JeanMcpInstallMode::Prod);
        let once = patch_jsonc_object_property(
            input,
            "mcp",
            &dev.server_name,
            &dev.opencode_server_json(),
        )
        .unwrap();
        let twice = patch_jsonc_object_property(
            &once,
            "mcp",
            &prod.server_name,
            &prod.opencode_server_json(),
        )
        .unwrap();
        assert!(twice.contains("// keep this"));
        assert!(twice.contains("// existing comment"));
        assert!(twice.contains("\"jean-dev\""));
        assert!(twice.contains("\"jean\""));
        validate_jsonc(&twice, Path::new("test")).unwrap();
    }

    #[test]
    fn opencode_config_path_prefers_xdg_config_over_home_files() {
        let unique = format!(
            "jean-opencode-path-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let home = std::env::temp_dir().join(unique);
        let xdg = home.join(".config").join("opencode");
        std::fs::create_dir_all(&xdg).unwrap();
        std::fs::write(home.join("opencode.json"), "{}").unwrap();
        std::fs::write(xdg.join("opencode.json"), "{}").unwrap();

        let found = find_opencode_config_path(&home).unwrap();
        assert_eq!(found, xdg.join("opencode.json"));

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn jsonc_patch_is_idempotent_for_same_key() {
        let dev = test_entry(JeanMcpInstallMode::Dev);
        let once = patch_jsonc_object_property("{}", "mcp", "jean-dev", &dev.cursor_server_json())
            .unwrap();
        let twice =
            patch_jsonc_object_property(&once, "mcp", "jean-dev", &dev.cursor_server_json())
                .unwrap();
        assert_eq!(twice.matches("\"jean-dev\"").count(), 1);
    }

    #[test]
    fn claude_jsonc_patch_preserves_projects_and_adds_mcp_server() {
        let input = r#"{
  "projects": {
    "/repo": {
      "allowedTools": ["Bash(git status)"]
    }
  },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx"
    }
  }
}"#;
        let prod = test_entry(JeanMcpInstallMode::Prod);
        let updated = patch_jsonc_object_property(
            input,
            "mcpServers",
            &prod.server_name,
            &prod.claude_server_json(),
        )
        .unwrap();

        assert!(updated.contains("\"projects\""));
        assert!(updated.contains("\"allowedTools\""));
        assert!(updated.contains("\"filesystem\""));
        assert!(updated.contains("\"jean\""));
        assert!(updated.contains("\"JEAN_MCP_MODE\": \"prod\""));
        validate_jsonc(&updated, Path::new("test")).unwrap();
    }

    #[test]
    fn claude_snippet_uses_top_level_mcp_servers() {
        let prod = test_entry(JeanMcpInstallMode::Prod);
        let snippet = prod.claude_snippet();
        let parsed: serde_json::Value = serde_json::from_str(&snippet).unwrap();
        assert!(parsed
            .get("mcpServers")
            .and_then(|servers| servers.get("jean"))
            .is_some());
        assert!(parsed.get("mcp").is_none());
    }

    #[test]
    fn codex_toml_edit_preserves_unrelated_comments_and_dev_prod() {
        let mut doc = r#"# global comment
model = "gpt-5.5"

# existing server
[mcp_servers.filesystem]
command = "npx"
"#
        .parse::<toml_edit::DocumentMut>()
        .unwrap();
        let dev = test_entry(JeanMcpInstallMode::Dev);
        let prod = test_entry(JeanMcpInstallMode::Prod);

        doc["mcp_servers"][&dev.server_name] = dev.codex_table_item();
        doc["mcp_servers"][&prod.server_name] = prod.codex_table_item();
        let rendered = doc.to_string();

        assert!(rendered.contains("# global comment"));
        assert!(rendered.contains("# existing server"));
        assert!(rendered.contains("[mcp_servers.jean-dev]"));
        assert!(rendered.contains("[mcp_servers.jean]"));
        rendered.parse::<toml_edit::DocumentMut>().unwrap();
    }
}

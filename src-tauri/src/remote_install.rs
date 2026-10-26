//! Install jean-server on a remote Linux host over SSH and verify readiness.
//!
//! Desktop-only: used by the native Jean app when adding a remote connection
//! from a user + IP/host pair.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEFAULT_SSH_PORT: u16 = 22;
const DEFAULT_JEAN_PORT: u16 = 3456;
const INSTALL_SCRIPT_URL: &str =
    "https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh";
const SSH_CONNECT_TIMEOUT_SECS: u64 = 15;
const HEALTH_ATTEMPTS: u32 = 24;
const HEALTH_INTERVAL_MS: u64 = 2_500;
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRemoteInput {
    /// Optional display name for the connection profile.
    pub name: Option<String>,
    /// SSH username on the remote host.
    pub user: String,
    /// Remote host IP or hostname (also used as the Web Access URL host).
    pub host: String,
    /// SSH port (default 22).
    pub ssh_port: Option<u16>,
    /// jean-server listen port (default 3456).
    pub jean_port: Option<u16>,
    /// Force user-level install (no sudo). When None, try system then user.
    pub user_install: Option<bool>,
    /// Install loopback-only and let the desktop open an SSH tunnel.
    #[serde(default)]
    pub via_tunnel: Option<bool>,
    /// Skip the "reuse existing token" short circuit and reinstall.
    #[serde(default)]
    pub force_install: Option<bool>,
    #[serde(default)]
    pub host_key_fingerprint: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Jean-owned known_hosts path. Set by the desktop command, not the webview.
    #[serde(default)]
    pub known_hosts_file: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRemoteResult {
    pub name: String,
    pub url: String,
    pub token: String,
    pub already_installed: bool,
    pub install_mode: String,
    pub ready: bool,
    pub log: String,
    /// `direct` keeps the public URL. `ssh` means readiness is through a tunnel.
    pub transport: String,
    #[serde(default)]
    pub local_url: Option<String>,
    #[serde(default)]
    pub host_key_fingerprint: Option<String>,
    #[serde(default)]
    pub token_stored: bool,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Token is present for the desktop command to store; the command clears it
    /// before the value reaches the webview when `token_stored` is set.
    #[serde(default)]
    pub pending_tunnel: bool,
}

#[allow(clippy::too_many_arguments)]
fn install_result(
    name: String,
    url: String,
    token: String,
    already_installed: bool,
    install_mode: String,
    ready: bool,
    log: String,
    transport: &str,
    pending_tunnel: bool,
) -> InstallRemoteResult {
    let log = crate::ssh_tunnel::redact(&log, &token);
    InstallRemoteResult {
        name,
        url,
        token,
        already_installed,
        install_mode,
        ready,
        log,
        transport: transport.to_string(),
        local_url: None,
        host_key_fingerprint: None,
        token_stored: false,
        profile_id: None,
        pending_tunnel,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    step: String,
    message: String,
}

/// Escape a string for safe embedding in a remote bash single-quoted string.
pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Validate SSH username (no spaces/control; common safe set).
pub fn validate_ssh_user(user: &str) -> Result<(), String> {
    let user = user.trim();
    if user.is_empty() {
        return Err("SSH user is required.".to_string());
    }
    if user.len() > 64 {
        return Err("SSH user is too long.".to_string());
    }
    if !user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '$')
    {
        return Err("SSH user may only contain letters, numbers, ., _, -, or $.".to_string());
    }
    Ok(())
}

/// Validate host / IP (no spaces, not empty).
pub fn validate_host(host: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Host or IP address is required.".to_string());
    }
    if host.len() > 253 {
        return Err("Host is too long.".to_string());
    }
    if host.contains(char::is_whitespace) || host.contains('/') || host.contains('?') {
        return Err("Enter a hostname or IP address (not a URL).".to_string());
    }
    if host.starts_with("http://") || host.starts_with("https://") {
        return Err("Enter a hostname or IP address (not a URL).".to_string());
    }
    Ok(())
}

pub fn validate_port(port: u16, label: &str) -> Result<(), String> {
    if port == 0 {
        return Err(format!("{label} must be between 1 and 65535."));
    }
    Ok(())
}

/// Format host for use inside an HTTP URL (bracket IPv6).
pub fn format_host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Build the Web Access base URL for a host + jean port.
pub fn build_web_access_url(host: &str, jean_port: u16) -> String {
    format!("http://{}:{}", format_host_for_url(host), jean_port)
}

/// Extract a token emitted by our remote install wrapper (`JEAN_INSTALL_TOKEN=...`).
pub fn parse_install_token(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("JEAN_INSTALL_TOKEN=") {
            let token = rest.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Extract token from a jean-server env file body.
pub fn parse_env_token(env_body: &str) -> Option<String> {
    for line in env_body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("JEAN_TOKEN=") {
            let token = rest.trim().trim_matches('"').trim_matches('\'');
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn emit_progress(app: &AppHandle, step: &str, message: &str) {
    let _ = app.emit(
        "remote-install:progress",
        ProgressPayload {
            step: step.to_string(),
            message: message.to_string(),
        },
    );
}

fn silent_ssh_command() -> Command {
    jean_core::silent_command("ssh")
}

#[derive(Clone)]
struct SshClientOptions {
    known_hosts_file: Option<std::path::PathBuf>,
    identity_file: Option<std::path::PathBuf>,
    strict_host_keys: bool,
}

impl SshClientOptions {
    fn legacy() -> Self {
        Self {
            known_hosts_file: None,
            identity_file: None,
            strict_host_keys: false,
        }
    }
}

fn apply_ssh_client_options(cmd: &mut Command, ssh_port: u16, options: &SshClientOptions) {
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("PasswordAuthentication=no");
    cmd.arg("-o").arg("KbdInteractiveAuthentication=no");
    cmd.arg("-o").arg("PreferredAuthentications=publickey");
    cmd.arg("-o").arg("ForwardAgent=no");
    cmd.arg("-o")
        .arg(format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"));
    if options.strict_host_keys {
        let Some(file) = options.known_hosts_file.as_ref() else {
            cmd.arg("-o").arg("StrictHostKeyChecking=yes");
            cmd.arg("-p").arg(ssh_port.to_string());
            return;
        };
        cmd.arg("-o").arg("StrictHostKeyChecking=yes");
        cmd.arg("-o").arg("UpdateHostKeys=no");
        cmd.arg("-o").arg(known_hosts_option(file));
        cmd.arg("-o").arg(format!(
            "GlobalKnownHostsFile={}",
            if cfg!(windows) { "NUL" } else { "/dev/null" }
        ));
    } else {
        cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    }
    if let Some(identity) = &options.identity_file {
        cmd.arg("-o").arg("IdentitiesOnly=yes");
        cmd.arg("-i").arg(identity);
    }
    cmd.arg("-p").arg(ssh_port.to_string());
}

fn known_hosts_option(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let value = if text.contains(' ') || text.contains('"') {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        text
    };
    format!("UserKnownHostsFile={value}")
}

fn ssh_failure(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "ssh is not installed on this computer. Install OpenSSH client and try again.".to_string()
    } else {
        format!("Failed to run ssh: {error}")
    }
}

fn command_output(output: std::process::Output) -> (i32, String, String) {
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn run_ssh(
    user: &str,
    host: &str,
    ssh_port: u16,
    remote_cmd: &str,
    options: &SshClientOptions,
) -> Result<(i32, String, String), String> {
    let target = format!("{user}@{host}");
    let mut cmd = silent_ssh_command();
    apply_ssh_client_options(&mut cmd, ssh_port, options);
    let output = cmd
        .arg(&target)
        .arg(remote_cmd)
        .output()
        .map_err(ssh_failure)?;
    Ok(command_output(output))
}

/// Run a bash script on stdin so the install token is not in the local argv.
fn run_ssh_script(
    user: &str,
    host: &str,
    ssh_port: u16,
    script: &str,
    options: &SshClientOptions,
) -> Result<(i32, String, String), String> {
    use std::io::Write;
    use std::process::Stdio;

    let target = format!("{user}@{host}");
    let mut cmd = silent_ssh_command();
    apply_ssh_client_options(&mut cmd, ssh_port, options);
    let mut child = cmd
        .arg(&target)
        .arg("bash")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(ssh_failure)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|error| format!("Failed to send the install script: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to finish ssh: {error}"))?;
    Ok(command_output(output))
}

fn run_ssh_ok(
    user: &str,
    host: &str,
    ssh_port: u16,
    remote_cmd: &str,
    options: &SshClientOptions,
) -> Result<String, String> {
    let (code, stdout, stderr) = run_ssh(user, host, ssh_port, remote_cmd, options)?;
    if code != 0 {
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("unknown ssh error");
        let detail = crate::ssh_tunnel::redact(detail, "");
        return Err(format!("SSH command failed (exit {code}): {detail}"));
    }
    Ok(stdout)
}

/// A concrete host alias from `~/.ssh/config` (wildcard patterns are skipped).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

const SSH_CONFIG_MAX_INCLUDE_DEPTH: usize = 16;

/// Split a config line into `(keyword, args)`. Supports `Key value` and `Key=value`.
fn split_ssh_config_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let key_end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..key_end].to_ascii_lowercase();
    let mut rest = line[key_end..].trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for c in rest.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            '#' if !in_quotes && !has_token => break,
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    Some((keyword, args))
}

fn is_ssh_host_pattern(token: &str) -> bool {
    token.starts_with('!') || token.contains('*') || token.contains('?')
}

/// Parse ssh config text. `load_include` returns the text of each file an
/// `Include` argument resolves to.
fn parse_ssh_config_with(
    text: &str,
    load_include: &mut dyn FnMut(&str) -> Vec<String>,
    depth: usize,
    hosts: &mut Vec<SshConfigHost>,
) {
    // Indexes into `hosts` that the current Host block applies to.
    let mut current: Vec<usize> = Vec::new();

    for line in text.lines() {
        let Some((keyword, args)) = split_ssh_config_line(line) else {
            continue;
        };
        match keyword.as_str() {
            "host" => {
                current.clear();
                for alias in args.iter().filter(|a| !is_ssh_host_pattern(a)) {
                    let index = match hosts.iter().position(|h| &h.alias == alias) {
                        Some(index) => index,
                        None => {
                            hosts.push(SshConfigHost {
                                alias: alias.clone(),
                                host_name: None,
                                user: None,
                                port: None,
                            });
                            hosts.len() - 1
                        }
                    };
                    if !current.contains(&index) {
                        current.push(index);
                    }
                }
            }
            "match" => current.clear(),
            "include" => {
                if depth >= SSH_CONFIG_MAX_INCLUDE_DEPTH {
                    continue;
                }
                for arg in &args {
                    for body in load_include(arg) {
                        parse_ssh_config_with(&body, load_include, depth + 1, hosts);
                    }
                }
            }
            // ssh uses the first value it finds, so never overwrite.
            "hostname" | "user" | "port" => {
                let Some(value) = args.first() else {
                    continue;
                };
                for &index in &current {
                    let host = &mut hosts[index];
                    match keyword.as_str() {
                        "hostname" if host.host_name.is_none() => {
                            host.host_name = Some(value.clone());
                        }
                        "user" if host.user.is_none() => host.user = Some(value.clone()),
                        "port" if host.port.is_none() => {
                            host.port = value.parse::<u16>().ok().filter(|p| *p > 0);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

/// Parse ssh config text without following `Include` lines.
#[cfg(test)]
fn parse_ssh_config(text: &str) -> Vec<SshConfigHost> {
    let mut hosts = Vec::new();
    parse_ssh_config_with(text, &mut |_| Vec::new(), 0, &mut hosts);
    hosts
}

/// Match a file name against a simple `*` / `?` pattern.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Resolve one `Include` argument to file paths. Relative paths are relative
/// to `~/.ssh`. Wildcards are supported in the last path component only.
fn resolve_ssh_include(arg: &str, home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let ssh_dir = home.join(".ssh");
    let path = if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else {
        let p = std::path::Path::new(arg);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            ssh_dir.join(p)
        }
    };

    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    if !file_name.contains('*') && !file_name.contains('?') {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut matches: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| wildcard_match(file_name, name))
        })
        .map(|entry| entry.path())
        .filter(|p| p.is_file())
        .collect();
    matches.sort();
    matches
}

/// List concrete host aliases from `~/.ssh/config` (follows `Include`).
/// A missing config returns an empty list.
pub fn list_ssh_config_hosts() -> Vec<SshConfigHost> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Vec::new();
    };
    let mut hosts = Vec::new();
    let mut load = |arg: &str| -> Vec<String> {
        resolve_ssh_include(arg, &home)
            .into_iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .collect()
    };
    parse_ssh_config_with(&text, &mut load, 0, &mut hosts);
    hosts
}

/// Extract the `uname` line that follows our `JEAN_SSH_OK` marker.
fn parse_ssh_test_output(stdout: &str) -> Result<String, String> {
    let mut lines = stdout.lines().map(str::trim);
    if !lines.any(|line| line == "JEAN_SSH_OK") {
        return Err(format!(
            "SSH connected, but the test command gave no reply: {}",
            stdout.trim()
        ));
    }
    Ok(lines
        .find(|line| !line.is_empty())
        .unwrap_or("unknown system")
        .to_string())
}

/// Check SSH key access to a host. Returns `uname -sm` output (e.g. `Linux x86_64`).
pub fn test_ssh_connection(
    user: &str,
    host: &str,
    ssh_port: Option<u16>,
) -> Result<String, String> {
    let user = user.trim();
    let host = host.trim();
    validate_ssh_user(user)?;
    validate_host(host)?;
    let ssh_port = ssh_port.unwrap_or(DEFAULT_SSH_PORT);
    validate_port(ssh_port, "SSH port")?;

    let stdout = run_ssh_ok(
        user,
        host,
        ssh_port,
        "echo JEAN_SSH_OK && uname -sm",
        &SshClientOptions::legacy(),
    )?;
    parse_ssh_test_output(&stdout)
}

/// Effective hostname for a target, as ssh resolves it (`ssh -G`). This maps
/// ssh config aliases (e.g. `dev` → `10.0.0.5`) so the HTTP URL works too.
fn resolve_ssh_hostname(user: &str, host: &str, ssh_port: u16) -> Option<String> {
    let output = silent_ssh_command()
        .args(["-G", "-p", &ssh_port.to_string(), &format!("{user}@{host}")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ssh_g_hostname(&String::from_utf8_lossy(&output.stdout))
}

fn parse_ssh_g_hostname(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (key, value) = line.trim().split_once(char::is_whitespace)?;
        let value = value.trim();
        (key.eq_ignore_ascii_case("hostname") && !value.is_empty() && validate_host(value).is_ok())
            .then(|| value.to_string())
    })
}

/// Parse `http://host:port/path?query` without the url crate.
fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        format!("Only http:// URLs are supported for remote install probes: {url}")
    })?;

    let (authority, path_and_query) = match rest.split_once('/') {
        Some((auth, path)) => (auth, format!("/{path}")),
        None => (rest, "/".to_string()),
    };

    if authority.is_empty() {
        return Err(format!("URL missing host: {url}"));
    }

    let (host, port) = if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| format!("Invalid IPv6 URL host: {url}"))?;
        let host = authority[1..end].to_string();
        let after = &authority[end + 1..];
        let port = if let Some(p) = after.strip_prefix(':') {
            p.parse::<u16>()
                .map_err(|_| format!("Invalid port in URL: {url}"))?
        } else if after.is_empty() {
            80
        } else {
            return Err(format!("Invalid URL authority: {url}"));
        };
        (host, port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        let port = p
            .parse::<u16>()
            .map_err(|_| format!("Invalid port in URL: {url}"))?;
        (h.to_string(), port)
    } else {
        (authority.to_string(), 80)
    };

    Ok((host, port, path_and_query))
}

fn http_get_status(url: &str) -> Result<(u16, String), String> {
    let (host, port, path) = parse_http_url(url)?;
    let addr = resolve_socket_addr(&host, port)?;
    let mut stream = TcpStream::connect_timeout(&addr, HTTP_TIMEOUT)
        .map_err(|e| format!("Could not connect to {host}:{port}: {e}"))?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(HTTP_TIMEOUT))
        .map_err(|e| e.to_string())?;

    let host_header = if port == 80 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nUser-Agent: jean-remote-install\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("HTTP write failed: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("HTTP read failed: {e}"))?;

    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("Invalid HTTP response from {url}"))?;

    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| response.split("\n\n").nth(1))
        .unwrap_or("")
        .to_string();

    Ok((status, body))
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("Could not resolve {host}"))
}

/// Probe healthz / readyz / auth from this client.
pub fn check_remote_ready(url: &str, token: &str) -> Result<(), String> {
    let base = url.trim_end_matches('/');

    let (health_status, _) =
        http_get_status(&format!("{base}/healthz")).map_err(|e| format!("healthz: {e}"))?;
    if health_status != 200 {
        return Err(format!("healthz returned HTTP {health_status}"));
    }

    let (ready_status, ready_body) =
        http_get_status(&format!("{base}/readyz")).map_err(|e| format!("readyz: {e}"))?;
    if ready_status != 200 {
        return Err(format!(
            "readyz returned HTTP {ready_status}: {}",
            ready_body.trim()
        ));
    }

    if !token.is_empty() {
        let auth_url = format!("{base}/api/auth?token={}", urlencoding_encode(token));
        let (auth_status, auth_body) =
            http_get_status(&auth_url).map_err(|e| format!("api/auth: {e}"))?;
        if auth_status != 200 {
            return Err(format!(
                "api/auth returned HTTP {auth_status}: {}",
                auth_body.trim()
            ));
        }
        if !auth_body.contains("\"ok\":true") && !auth_body.contains("\"ok\": true") {
            return Err(format!("api/auth rejected token: {}", auth_body.trim()));
        }
    }

    Ok(())
}

/// Minimal URL-encoding for query values (token characters).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn wait_until_ready(app: &AppHandle, url: &str, token: &str) -> Result<(), String> {
    let mut last_error = "not checked yet".to_string();
    for attempt in 1..=HEALTH_ATTEMPTS {
        emit_progress(
            app,
            "health",
            &format!("Checking readiness ({attempt}/{HEALTH_ATTEMPTS})…"),
        );
        match check_remote_ready(url, token) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error;
                if attempt < HEALTH_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(HEALTH_INTERVAL_MS));
                }
            }
        }
    }
    Err(format!(
        "jean-server did not become ready at {url}: {last_error}"
    ))
}

fn try_read_existing_token(
    user: &str,
    host: &str,
    ssh_port: u16,
    options: &SshClientOptions,
) -> Option<(String, String)> {
    // Prefer system env, then user env.
    let system_cmd = "sudo -n cat /etc/jean-server.env 2>/dev/null || true";
    if let Ok(body) = run_ssh_ok(user, host, ssh_port, system_cmd, options) {
        if let Some(token) = parse_env_token(&body) {
            return Some((token, "system".to_string()));
        }
    }

    let user_cmd = "cat \"$HOME/.config/jean-server/jean-server.env\" 2>/dev/null || true";
    if let Ok(body) = run_ssh_ok(user, host, ssh_port, user_cmd, options) {
        if let Some(token) = parse_env_token(&body) {
            return Some((token, "user".to_string()));
        }
    }

    None
}

fn set_existing_server_name(
    user: &str,
    host: &str,
    ssh_port: u16,
    mode: &str,
    name: &str,
    options: &SshClientOptions,
) -> Result<(), String> {
    let name = shell_escape(name);
    let command = if mode == "system" {
        format!(
            "sudo -n sed -i '/^JEAN_SERVER_NAME=/d' /etc/jean-server.env && printf '%s\\n' {name} | sudo -n sed 's/^/JEAN_SERVER_NAME=/' | sudo -n tee -a /etc/jean-server.env >/dev/null && sudo -n systemctl restart jean-server"
        )
    } else {
        format!(
            "sed -i '/^JEAN_SERVER_NAME=/d' \"$HOME/.config/jean-server/jean-server.env\" && printf '%s\\n' {name} | sed 's/^/JEAN_SERVER_NAME=/' >> \"$HOME/.config/jean-server/jean-server.env\" && systemctl --user restart jean-server"
        )
    };
    run_ssh_ok(user, host, ssh_port, &command, options).map(|_| ())
}

/// Build the remote bash install script.
pub fn build_install_remote_script(
    jean_port: u16,
    user_install: bool,
    name: &str,
    bind_host: &str,
) -> String {
    let name_arg = format!(" --name {}", shell_escape(name));
    let bind_host = shell_escape(bind_host);
    let install_args = if user_install {
        format!(
            "--user-install --host {bind_host} --port {jean_port} --token \"$TOKEN\"{name_arg} -y"
        )
    } else {
        format!("--host {bind_host} --port {jean_port} --token \"$TOKEN\"{name_arg} -y")
    };
    let sudo_prefix = if user_install {
        String::new()
    } else {
        "sudo -n ".to_string()
    };
    let script_url = shell_escape(INSTALL_SCRIPT_URL);

    // Direct installs bind every interface. SSH-tunnel installs pass 127.0.0.1
    // so the server stays loopback-only and the desktop reaches it through ssh -L.
    format!(
        r#"set -euo pipefail
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required on the remote host" >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required on the remote host" >&2
  exit 1
fi
TOKEN="$(
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
)"
echo "JEAN_INSTALL_TOKEN=${{TOKEN}}"
curl -fsSL {script_url} | {sudo_prefix}bash -s -- {install_args}
"#
    )
}

#[allow(clippy::too_many_arguments)]
fn run_install(
    app: &AppHandle,
    user: &str,
    host: &str,
    ssh_port: u16,
    jean_port: u16,
    force_user_install: Option<bool>,
    name: &str,
    bind_host: &str,
    options: &SshClientOptions,
) -> Result<(String, String, String), String> {
    let mut log = String::new();
    let modes: Vec<(bool, &str)> = match force_user_install {
        Some(true) => vec![(true, "user")],
        Some(false) => vec![(false, "system")],
        None => vec![(false, "system"), (true, "user")],
    };

    let mut last_error = String::new();
    for (user_install, mode_name) in modes {
        emit_progress(
            app,
            "install",
            &format!("Installing jean-server ({mode_name} install)…"),
        );
        let script = build_install_remote_script(jean_port, user_install, name, bind_host);
        let (code, stdout, stderr) = run_ssh_script(user, host, ssh_port, &script, options)?;
        log.push_str(&format!("--- {mode_name} install ---\n"));
        let safe_stdout = crate::ssh_tunnel::redact(&stdout, "");
        let safe_stderr = crate::ssh_tunnel::redact(&stderr, "");
        if !safe_stdout.is_empty() {
            log.push_str(&safe_stdout);
            if !safe_stdout.ends_with('\n') {
                log.push('\n');
            }
        }
        if !safe_stderr.is_empty() {
            log.push_str(&safe_stderr);
            if !safe_stderr.ends_with('\n') {
                log.push('\n');
            }
        }

        if code == 0 {
            let token = parse_install_token(&stdout)
                .or_else(|| parse_install_token(&stderr))
                .ok_or_else(|| {
                    format!("Install completed but no token was returned. Output:\n{log}")
                })?;
            return Ok((token, mode_name.to_string(), log));
        }

        last_error = crate::ssh_tunnel::redact(
            &format!(
                "{mode_name} install failed (exit {code}): {}",
                [stderr.trim(), stdout.trim()]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or("no output")
            ),
            "",
        );

        // If system install failed because sudo needs a password, try user install.
        let combined = format!("{stderr}\n{stdout}").to_lowercase();
        if !user_install
            && (combined.contains("password")
                || combined.contains("sudo")
                || combined.contains("a password is required")
                || combined.contains("system install requires root"))
        {
            continue;
        }
        if force_user_install.is_some() {
            break;
        }
    }

    Err(format!("{last_error}\n\n{log}"))
}

/// Install (or reuse) jean-server on a remote host and return connection details.
pub fn install_remote_jean_server(
    app: AppHandle,
    input: InstallRemoteInput,
) -> Result<InstallRemoteResult, String> {
    let user = input.user.trim().to_string();
    let host = input.host.trim().to_string();
    validate_ssh_user(&user)?;
    validate_host(&host)?;

    let ssh_port = input.ssh_port.unwrap_or(DEFAULT_SSH_PORT);
    let jean_port = input.jean_port.unwrap_or(DEFAULT_JEAN_PORT);
    validate_port(ssh_port, "SSH port")?;
    validate_port(jean_port, "Jean port")?;

    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&host)
        .to_string();

    let via_tunnel = input.via_tunnel.unwrap_or(false);
    let force_install = input.force_install.unwrap_or(false);
    let ssh_options = if via_tunnel {
        let known_hosts = input
            .known_hosts_file
            .clone()
            .ok_or_else(|| "Trust the SSH host key before installing over a tunnel.".to_string())?;
        SshClientOptions {
            known_hosts_file: Some(std::path::PathBuf::from(known_hosts)),
            identity_file: input
                .identity_file
                .as_ref()
                .map(|path| std::path::PathBuf::from(path.trim()))
                .filter(|path| !path.as_os_str().is_empty()),
            strict_host_keys: true,
        }
    } else {
        SshClientOptions::legacy()
    };
    let bind_host = if via_tunnel { "127.0.0.1" } else { "0.0.0.0" };

    // The SSH target may be an ssh config alias; the HTTP URL needs the real host.
    // Tunnel installs never use this URL for traffic.
    let url_host = resolve_ssh_hostname(&user, &host, ssh_port).unwrap_or_else(|| host.clone());
    let url = build_web_access_url(&url_host, jean_port);
    let mut log = String::new();

    // 1) SSH connectivity
    emit_progress(
        &app,
        "ssh",
        &format!("Connecting via SSH to {user}@{host}:{ssh_port}…"),
    );
    run_ssh_ok(
        &user,
        &host,
        ssh_port,
        "echo JEAN_SSH_OK && uname -s",
        &ssh_options,
    )
    .map_err(|e| {
        format!(
            "{e}\n\nMake sure:\n\
             • SSH key auth works for {user}@{host} (password login is not supported)\n\
             • The host is reachable on port {ssh_port}\n\
             • OpenSSH client is installed on this computer"
        )
    })?;
    log.push_str("SSH connection OK\n");

    // 2) Reuse existing install when it is already reachable.
    emit_progress(&app, "probe", "Checking for an existing jean-server…");
    if !force_install {
        if let Some((token, mode)) = try_read_existing_token(&user, &host, ssh_port, &ssh_options) {
            log.push_str(&format!("Found existing env token ({mode})\n"));
            if via_tunnel {
                emit_progress(
                    &app,
                    "tunnel",
                    "Existing jean-server found. Opening the SSH tunnel…",
                );
                return Ok(install_result(
                    name, url, token, true, mode, false, log, "ssh", true,
                ));
            }
            if check_remote_ready(&url, &token).is_ok() {
                set_existing_server_name(&user, &host, ssh_port, &mode, &name, &ssh_options)?;
                wait_until_ready(&app, &url, &token)?;
                emit_progress(&app, "done", "Existing jean-server is ready.");
                return Ok(install_result(
                    name, url, token, true, mode, true, log, "direct", false,
                ));
            }
            log.push_str("Existing install found but not reachable yet; reinstalling…\n");
        }
    }

    // 3) Install
    let (token, mode, install_log) = run_install(
        &app,
        &user,
        &host,
        ssh_port,
        jean_port,
        input.user_install,
        &name,
        bind_host,
        &ssh_options,
    )?;
    log.push_str(&install_log);

    if via_tunnel {
        emit_progress(
            &app,
            "tunnel",
            "jean-server is installed on 127.0.0.1. Opening the SSH tunnel…",
        );
        return Ok(install_result(
            name, url, token, false, mode, false, log, "ssh", true,
        ));
    }

    // 4) Wait until healthy from this client (direct URL only).
    emit_progress(&app, "health", "Waiting for jean-server to become ready…");
    wait_until_ready(&app, &url, &token).map_err(|e| {
        let safe_log = crate::ssh_tunnel::redact(&log, &token);
        let safe_error = crate::ssh_tunnel::redact(&e, &token);
        format!(
            "{safe_error}\n\nInstall finished, but this computer cannot reach {url}.\n\
             Check firewall rules for port {jean_port} and that the host IP is correct.\n\n{safe_log}"
        )
    })?;

    emit_progress(&app, "done", "Remote jean-server is ready.");
    Ok(install_result(
        name, url, token, false, mode, true, log, "direct", false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_escape_wraps_and_escapes_quotes() {
        assert_eq!(shell_escape("hello"), "'hello'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn validate_user_and_host() {
        assert!(validate_ssh_user("ubuntu").is_ok());
        assert!(validate_ssh_user("").is_err());
        assert!(validate_ssh_user("bad user").is_err());
        assert!(validate_host("192.168.1.10").is_ok());
        assert!(validate_host("build.local").is_ok());
        assert!(validate_host("https://example.com").is_err());
        assert!(validate_host("").is_err());
    }

    #[test]
    fn builds_web_access_url() {
        assert_eq!(
            build_web_access_url("10.0.0.5", 3456),
            "http://10.0.0.5:3456"
        );
        assert_eq!(
            build_web_access_url("2001:db8::1", 3456),
            "http://[2001:db8::1]:3456"
        );
    }

    #[test]
    fn parses_install_and_env_tokens() {
        let out = "\
==> downloading
JEAN_INSTALL_TOKEN=abc123+/=
==> done
";
        assert_eq!(parse_install_token(out).as_deref(), Some("abc123+/="));
        assert_eq!(
            parse_env_token("JEAN_HOST=0.0.0.0\nJEAN_TOKEN=secret-token\n").as_deref(),
            Some("secret-token")
        );
    }

    #[test]
    fn install_script_includes_flags() {
        let system = build_install_remote_script(3456, false, "Dev Server", "0.0.0.0");
        assert!(system.contains("sudo -n"));
        assert!(system.contains("--host '0.0.0.0'"));
        assert!(system.contains("--port 3456"));
        assert!(system.contains("--name 'Dev Server'"));
        assert!(system.contains("JEAN_INSTALL_TOKEN="));
        assert!(!system.contains("--user-install"));
        assert!(system.contains(INSTALL_SCRIPT_URL));

        let user = build_install_remote_script(4000, true, "Dev Server", "127.0.0.1");
        assert!(user.contains("--user-install"));
        assert!(user.contains("--host '127.0.0.1'"));
        assert!(user.contains("--port 4000"));
        assert!(!user.contains("sudo -n"));
        assert!(!user.contains("0.0.0.0"));
    }

    #[test]
    fn parse_http_url_basic() {
        let (host, port, path) = parse_http_url("http://10.0.0.1:3456/api/auth?token=x").unwrap();
        assert_eq!(host, "10.0.0.1");
        assert_eq!(port, 3456);
        assert_eq!(path, "/api/auth?token=x");
    }

    #[test]
    fn parses_ssh_config_hosts() {
        let text = r#"
# comment
Host *
    User nobody

Host dev box2
    HostName 10.0.0.5
    USER ubuntu
    Port 2222
    IdentityFile ~/.ssh/id_dev

host=prod
  hostname prod.example.com
  user "deploy"

Host web-? !bad *.internal staging
  Port nope

Match host foo
  User matchuser

Host dev
  User other
"#;
        let hosts = parse_ssh_config(text);
        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "dev".into(),
                    host_name: Some("10.0.0.5".into()),
                    user: Some("ubuntu".into()),
                    port: Some(2222),
                },
                SshConfigHost {
                    alias: "box2".into(),
                    host_name: Some("10.0.0.5".into()),
                    user: Some("ubuntu".into()),
                    port: Some(2222),
                },
                SshConfigHost {
                    alias: "prod".into(),
                    host_name: Some("prod.example.com".into()),
                    user: Some("deploy".into()),
                    port: None,
                },
                SshConfigHost {
                    alias: "staging".into(),
                    host_name: None,
                    user: None,
                    port: None,
                },
            ]
        );
    }

    #[test]
    fn parses_empty_ssh_config() {
        assert!(parse_ssh_config("").is_empty());
        assert!(parse_ssh_config("# only\n\nUser root\n").is_empty());
    }

    #[test]
    fn follows_ssh_config_includes() {
        let text = "Include config.d/*\nHost main\n  User me\n";
        let mut hosts = Vec::new();
        let mut load = |arg: &str| -> Vec<String> {
            assert_eq!(arg, "config.d/*");
            vec!["Host inc\n  HostName 1.2.3.4\n  Port 2200\n".to_string()]
        };
        parse_ssh_config_with(text, &mut load, 0, &mut hosts);
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["inc", "main"]);
        assert_eq!(hosts[0].port, Some(2200));
        assert_eq!(hosts[1].user.as_deref(), Some("me"));
    }

    #[test]
    fn include_recursion_is_bounded() {
        let mut hosts = Vec::new();
        let mut load = |_: &str| vec!["Include self\nHost loop\n".to_string()];
        parse_ssh_config_with("Include self\n", &mut load, 0, &mut hosts);
        assert_eq!(hosts.len(), 1);
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard_match("*", "work"));
        assert!(wildcard_match("*.conf", "a.conf"));
        assert!(!wildcard_match("*.conf", "a.txt"));
        assert!(wildcard_match("host?", "host1"));
        assert!(!wildcard_match("host?", "host12"));
    }

    #[test]
    fn resolves_relative_includes_to_ssh_dir() {
        let home = std::path::Path::new("/home/u");
        assert_eq!(
            resolve_ssh_include("work", home),
            vec![std::path::PathBuf::from("/home/u/.ssh/work")]
        );
        assert_eq!(
            resolve_ssh_include("~/other", home),
            vec![std::path::PathBuf::from("/home/u/other")]
        );
    }

    #[test]
    fn parses_ssh_g_hostname_line() {
        let out = "user ubuntu\nhostname 10.0.0.5\nport 22\n";
        assert_eq!(parse_ssh_g_hostname(out).as_deref(), Some("10.0.0.5"));
        assert_eq!(parse_ssh_g_hostname("user x\n"), None);
    }

    #[test]
    fn parses_ssh_test_output() {
        assert_eq!(
            parse_ssh_test_output("JEAN_SSH_OK\nLinux x86_64\n").unwrap(),
            "Linux x86_64"
        );
        assert!(parse_ssh_test_output("motd only\n").is_err());
    }
}

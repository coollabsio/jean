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
        return Err(
            "SSH user may only contain letters, numbers, ., _, -, or $.".to_string(),
        );
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
    #[allow(unused_mut)]
    let mut cmd = Command::new("ssh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run_ssh(
    user: &str,
    host: &str,
    ssh_port: u16,
    remote_cmd: &str,
) -> Result<(i32, String, String), String> {
    let target = format!("{user}@{host}");
    let output = silent_ssh_command()
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            &format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"),
            "-p",
            &ssh_port.to_string(),
            &target,
            remote_cmd,
        ])
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "ssh is not installed on this computer. Install OpenSSH client and try again."
                    .to_string()
            } else {
                format!("Failed to run ssh: {error}")
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code().unwrap_or(-1);
    Ok((code, stdout, stderr))
}

fn run_ssh_ok(
    user: &str,
    host: &str,
    ssh_port: u16,
    remote_cmd: &str,
) -> Result<String, String> {
    let (code, stdout, stderr) = run_ssh(user, host, ssh_port, remote_cmd)?;
    if code != 0 {
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("unknown ssh error");
        return Err(format!("SSH command failed (exit {code}): {detail}"));
    }
    Ok(stdout)
}

/// Parse `http://host:port/path?query` without the url crate.
fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("Only http:// URLs are supported for remote install probes: {url}"))?;

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
) -> Option<(String, String)> {
    // Prefer system env, then user env.
    let system_cmd = "sudo -n cat /etc/jean-server.env 2>/dev/null || true";
    if let Ok(body) = run_ssh_ok(user, host, ssh_port, system_cmd) {
        if let Some(token) = parse_env_token(&body) {
            return Some((token, "system".to_string()));
        }
    }

    let user_cmd = "cat \"$HOME/.config/jean-server/jean-server.env\" 2>/dev/null || true";
    if let Ok(body) = run_ssh_ok(user, host, ssh_port, user_cmd) {
        if let Some(token) = parse_env_token(&body) {
            return Some((token, "user".to_string()));
        }
    }

    None
}

/// Build the remote bash install script.
pub fn build_install_remote_script(jean_port: u16, user_install: bool) -> String {
    let install_args = if user_install {
        format!(
            "--user-install --host 0.0.0.0 --port {jean_port} --token \"$TOKEN\" -y"
        )
    } else {
        format!("--host 0.0.0.0 --port {jean_port} --token \"$TOKEN\" -y")
    };
    let sudo_prefix = if user_install {
        String::new()
    } else {
        "sudo -n ".to_string()
    };
    let script_url = shell_escape(INSTALL_SCRIPT_URL);

    // Bind 0.0.0.0 so the desktop client can reach the server by the host/IP
    // the user entered. Token auth stays required.
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

fn run_install(
    app: &AppHandle,
    user: &str,
    host: &str,
    ssh_port: u16,
    jean_port: u16,
    force_user_install: Option<bool>,
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
        let script = build_install_remote_script(jean_port, user_install);
        let (code, stdout, stderr) = run_ssh(user, host, ssh_port, &script)?;
        log.push_str(&format!("--- {mode_name} install ---\n"));
        if !stdout.is_empty() {
            log.push_str(&stdout);
            if !stdout.ends_with('\n') {
                log.push('\n');
            }
        }
        if !stderr.is_empty() {
            log.push_str(&stderr);
            if !stderr.ends_with('\n') {
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

        last_error = format!(
            "{mode_name} install failed (exit {code}): {}",
            [stderr.trim(), stdout.trim()]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("no output")
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

    let url = build_web_access_url(&host, jean_port);
    let mut log = String::new();

    // 1) SSH connectivity
    emit_progress(
        &app,
        "ssh",
        &format!("Connecting via SSH to {user}@{host}:{ssh_port}…"),
    );
    run_ssh_ok(&user, &host, ssh_port, "echo JEAN_SSH_OK && uname -s").map_err(|e| {
        format!(
            "{e}\n\nMake sure:\n\
             • SSH key auth works for {user}@{host} (password login is not supported)\n\
             • The host is reachable on port {ssh_port}\n\
             • OpenSSH client is installed on this computer"
        )
    })?;
    log.push_str("SSH connection OK\n");

    // 2) Reuse existing install if already ready
    emit_progress(&app, "probe", "Checking for an existing jean-server…");
    if let Some((token, mode)) = try_read_existing_token(&user, &host, ssh_port) {
        log.push_str(&format!("Found existing env token ({mode})\n"));
        if check_remote_ready(&url, &token).is_ok() {
            emit_progress(&app, "done", "Existing jean-server is ready.");
            return Ok(InstallRemoteResult {
                name,
                url,
                token,
                already_installed: true,
                install_mode: mode,
                ready: true,
                log,
            });
        }
        log.push_str("Existing install found but not reachable yet; reinstalling…\n");
    }

    // 3) Install
    let (token, mode, install_log) = run_install(
        &app,
        &user,
        &host,
        ssh_port,
        jean_port,
        input.user_install,
    )?;
    log.push_str(&install_log);

    // 4) Wait until healthy from this client
    emit_progress(&app, "health", "Waiting for jean-server to become ready…");
    wait_until_ready(&app, &url, &token).map_err(|e| {
        format!(
            "{e}\n\nInstall finished, but this computer cannot reach {url}.\n\
             Check firewall rules for port {jean_port} and that the host IP is correct.\n\n{log}"
        )
    })?;

    emit_progress(&app, "done", "Remote jean-server is ready.");
    Ok(InstallRemoteResult {
        name,
        url,
        token,
        already_installed: false,
        install_mode: mode,
        ready: true,
        log,
    })
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
        let system = build_install_remote_script(3456, false);
        assert!(system.contains("sudo -n"));
        assert!(system.contains("--host 0.0.0.0"));
        assert!(system.contains("--port 3456"));
        assert!(system.contains("JEAN_INSTALL_TOKEN="));
        assert!(!system.contains("--user-install"));
        assert!(system.contains(INSTALL_SCRIPT_URL));

        let user = build_install_remote_script(4000, true);
        assert!(user.contains("--user-install"));
        assert!(user.contains("--port 4000"));
        assert!(!user.contains("sudo -n"));
    }

    #[test]
    fn parse_http_url_basic() {
        let (host, port, path) =
            parse_http_url("http://10.0.0.1:3456/api/auth?token=x").unwrap();
        assert_eq!(host, "10.0.0.1");
        assert_eq!(port, 3456);
        assert_eq!(path, "/api/auth?token=x");
    }
}

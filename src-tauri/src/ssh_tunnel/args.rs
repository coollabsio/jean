//! Argument builders for Jean-managed `ssh -N` local forwards.
//!
//! Arguments are passed directly to OpenSSH. Nothing here is interpolated
//! through a shell, and these helpers never receive tokens or private keys.

use std::path::{Path, PathBuf};

pub const DEFAULT_SSH_PORT: u16 = 22;
pub const DEFAULT_REMOTE_HOST: &str = "127.0.0.1";
pub const DEFAULT_REMOTE_PORT: u16 = 3456;
pub const BACKOFF_CAP_MS: u64 = 30_000;

/// `CREATE_NO_WINDOW` (0x08000000). Spawn goes through
/// [`jean_core::silent_command`], which sets this flag on Windows so the
/// OpenSSH client does not flash a console.

#[derive(Debug, Clone)]
pub struct ForwardSpec {
    pub user: String,
    pub host: String,
    pub ssh_port: u16,
    pub identity_file: Option<PathBuf>,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub known_hosts_file: PathBuf,
}

pub fn null_known_hosts_file() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// OpenSSH option values treat spaces as separators unless the path is quoted.
pub fn ssh_config_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.contains(' ') || text.contains('"') {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        text
    }
}

pub fn forward_bind(local_port: u16, remote_host: &str, remote_port: u16) -> String {
    let remote = if remote_host.contains(':') && !remote_host.starts_with('[') {
        format!("[{remote_host}]")
    } else {
        remote_host.to_string()
    };
    format!("127.0.0.1:{local_port}:{remote}:{remote_port}")
}

pub fn build_forward_args(spec: &ForwardSpec) -> Vec<String> {
    let mut args = Vec::new();
    push_auth_args(
        &mut args,
        spec.ssh_port,
        spec.identity_file.as_deref(),
        &spec.known_hosts_file,
    );
    args.push("-N".into());
    args.push("-T".into());
    args.push("-n".into());
    args.push("-L".into());
    args.push(forward_bind(
        spec.local_port,
        &spec.remote_host,
        spec.remote_port,
    ));
    args.push(format!("{}@{}", spec.user, spec.host));
    args
}

pub fn build_exec_args(
    user: &str,
    host: &str,
    ssh_port: u16,
    identity_file: Option<&Path>,
    known_hosts_file: &Path,
    remote_command: &[&str],
) -> Vec<String> {
    let mut args = Vec::new();
    push_auth_args(&mut args, ssh_port, identity_file, known_hosts_file);
    args.push(format!("{user}@{host}"));
    args.extend(remote_command.iter().map(|part| (*part).to_string()));
    args
}

fn push_auth_args(
    args: &mut Vec<String>,
    ssh_port: u16,
    identity_file: Option<&Path>,
    known_hosts_file: &Path,
) {
    for option in [
        "BatchMode=yes",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "NumberOfPasswordPrompts=0",
        "PreferredAuthentications=publickey",
        "ForwardAgent=no",
        "ExitOnForwardFailure=yes",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "ConnectTimeout=15",
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
    ] {
        args.push("-o".into());
        args.push(option.into());
    }
    args.push("-o".into());
    args.push(format!(
        "UserKnownHostsFile={}",
        ssh_config_path(known_hosts_file)
    ));
    args.push("-o".into());
    args.push(format!("GlobalKnownHostsFile={}", null_known_hosts_file()));
    if let Some(identity) = identity_file {
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
        args.push("-i".into());
        args.push(identity.to_string_lossy().replace('\\', "/"));
    }
    args.push("-p".into());
    args.push(ssh_port.to_string());
}

/// Bounded exponential backoff: 1s, 2s, 4s, 8s, 16s, then 30s.
pub fn backoff_delay_ms(attempt: u32) -> u64 {
    if attempt == 0 {
        return 1_000;
    }
    let shift = attempt.saturating_sub(1).min(5);
    1_000u64.saturating_mul(1u64 << shift).min(BACKOFF_CAP_MS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    Retryable,
    HostKey,
    Auth,
    MissingBinary,
}

pub fn classify_ssh_failure(stderr: &str) -> FailureClass {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
        || (lower.contains("host key") && lower.contains("has changed"))
        || (lower.contains("offending") && lower.contains("key"))
    {
        return FailureClass::HostKey;
    }
    if lower.contains("permission denied")
        || lower.contains("authentication failed")
        || lower.contains("no more authentication methods")
    {
        return FailureClass::Auth;
    }
    FailureClass::Retryable
}

pub fn classify_health_failure(error: &str) -> FailureClass {
    let lower = error.to_ascii_lowercase();
    if lower.contains("rejected") || lower.contains("http 401") || lower.contains("http 403") {
        FailureClass::Auth
    } else {
        FailureClass::Retryable
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterFailure {
    Retry { delay_ms: u64 },
    Stop,
}

pub fn decide_after_failure(class: FailureClass, attempt: u32) -> AfterFailure {
    match class {
        FailureClass::Retryable => AfterFailure::Retry {
            delay_ms: backoff_delay_ms(attempt),
        },
        FailureClass::HostKey | FailureClass::Auth | FailureClass::MissingBinary => {
            AfterFailure::Stop
        }
    }
}

/// User-facing error for a browser preview forward. Unlike the jean-server
/// tunnel, a failed preview does not reconnect on its own.
pub fn preview_forward_failure(class: FailureClass, detail: &str, port: u16) -> String {
    let detail = sanitize_detail(detail);
    let prefix = match class {
        FailureClass::HostKey => format!(
            "Could not forward remote port {port}. SSH host key verification failed. Review the server fingerprint and trust the new key before retrying."
        ),
        FailureClass::Auth => format!(
            "Could not forward remote port {port}. SSH key authentication failed. Password login is not supported."
        ),
        FailureClass::MissingBinary => {
            "ssh is not installed on this computer. Install the OpenSSH client and try again."
                .to_string()
        }
        FailureClass::Retryable => {
            format!("Could not forward remote port {port}. The SSH forward did not open.")
        }
    };
    if detail.is_empty() || matches!(class, FailureClass::MissingBinary) {
        prefix
    } else if matches!(class, FailureClass::Retryable) {
        format!("Could not forward remote port {port}. {detail}")
    } else {
        format!("{prefix} {detail}")
    }
}

/// Preview forwards always target the SSH server's own loopback, on the same
/// local port the remote service uses, so the embedded browser does not open
/// this computer's server by accident.
pub fn preview_forward_spec(base: &ForwardSpec, remote_port: u16) -> ForwardSpec {
    ForwardSpec {
        user: base.user.clone(),
        host: base.host.clone(),
        ssh_port: base.ssh_port,
        identity_file: base.identity_file.clone(),
        remote_host: DEFAULT_REMOTE_HOST.to_string(),
        remote_port,
        local_port: remote_port,
        known_hosts_file: base.known_hosts_file.clone(),
    }
}

pub fn failure_message(class: FailureClass, detail: &str) -> String {
    let detail = sanitize_detail(detail);
    match class {
        FailureClass::HostKey => format!(
            "SSH host key verification failed. Review the server fingerprint and trust the new key before reconnecting. {detail}"
        ),
        FailureClass::Auth => format!(
            "SSH key authentication failed. Password login is not supported. Check the SSH agent or identity file. {detail}"
        ),
        FailureClass::MissingBinary => {
            "ssh is not installed on this computer. Install the OpenSSH client and try again."
                .to_string()
        }
        FailureClass::Retryable => {
            if detail.is_empty() {
                "SSH tunnel dropped. Reconnecting.".to_string()
            } else {
                format!("SSH tunnel dropped. Reconnecting. {detail}")
            }
        }
    }
}

pub fn sanitize_detail(detail: &str) -> String {
    let mut lines = Vec::new();
    let mut in_private_key = false;
    for line in detail.lines() {
        let trimmed = line.trim();
        if in_private_key {
            if trimmed.contains("END") && trimmed.contains("PRIVATE KEY") {
                in_private_key = false;
            }
            continue;
        }
        if trimmed.contains("BEGIN") && trimmed.contains("PRIVATE KEY") {
            in_private_key = true;
            continue;
        }
        if trimmed.is_empty() || trimmed.contains("PRIVATE KEY") {
            continue;
        }
        lines.push(trimmed);
        if lines.len() == 4 {
            break;
        }
    }
    let joined = lines.join(" ");
    if joined.chars().count() > 400 {
        let end = joined
            .char_indices()
            .nth(400)
            .map(|(idx, _)| idx)
            .unwrap_or(joined.len());
        format!("{}…", &joined[..end])
    } else {
        joined
    }
}

pub fn redact(text: &str, secret: &str) -> String {
    let replaced = if secret.len() >= 6 {
        text.replace(secret, "[redacted]")
    } else {
        text.to_string()
    };
    redact_assignments(&replaced)
}

fn redact_assignments(text: &str) -> String {
    let mut result = String::new();
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let newline = if line.ends_with('\n') { "\n" } else { "" };
        if let Some(rest) = trimmed.strip_prefix("JEAN_INSTALL_TOKEN=") {
            if !rest.trim().is_empty() && rest.trim() != "[redacted]" {
                result.push_str("JEAN_INSTALL_TOKEN=[redacted]");
                result.push_str(newline);
                continue;
            }
        }
        if let Some(rest) = trimmed.strip_prefix("JEAN_TOKEN=") {
            if !rest.trim().is_empty() && rest.trim() != "[redacted]" {
                result.push_str("JEAN_TOKEN=[redacted]");
                result.push_str(newline);
                continue;
            }
        }
        result.push_str(line);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ForwardSpec {
        ForwardSpec {
            user: "ubuntu".into(),
            host: "build.example".into(),
            ssh_port: 22,
            identity_file: None,
            remote_host: "127.0.0.1".into(),
            remote_port: 3456,
            local_port: 41000,
            known_hosts_file: PathBuf::from("/tmp/jean known/known_hosts"),
        }
    }

    #[test]
    fn forward_args_pin_host_keys_and_disable_password_and_agent() {
        let args = build_forward_args(&spec());
        let joined = args.join(" ");
        assert!(joined.contains("-N -T -n -L 127.0.0.1:41000:127.0.0.1:3456"));
        assert!(joined.contains("BatchMode=yes"));
        assert!(joined.contains("PasswordAuthentication=no"));
        assert!(joined.contains("PreferredAuthentications=publickey"));
        assert!(joined.contains("ForwardAgent=no"));
        assert!(joined.contains("ExitOnForwardFailure=yes"));
        assert!(joined.contains("ServerAliveInterval=15"));
        assert!(joined.contains("ServerAliveCountMax=3"));
        assert!(joined.contains("StrictHostKeyChecking=yes"));
        assert!(joined.contains("UpdateHostKeys=no"));
        assert!(joined.contains("UserKnownHostsFile=\"/tmp/jean known/known_hosts\""));
        assert!(!joined.contains("accept-new"));
        assert!(!joined.contains("IdentitiesOnly"));
        assert!(!args.iter().any(|arg| arg == "-i"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("ubuntu@build.example")
        );
    }

    #[test]
    fn identity_file_is_an_argument_not_a_shell_string() {
        let mut spec = spec();
        spec.identity_file = Some(PathBuf::from("/keys/id ed25519"));
        let args = build_forward_args(&spec);
        let identity_at = args.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(args[identity_at + 1], "/keys/id ed25519");
        assert!(args.iter().any(|arg| arg == "IdentitiesOnly=yes"));
        assert!(!args.join(" ").contains("sh -c"));
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        assert_eq!(backoff_delay_ms(1), 1_000);
        assert_eq!(backoff_delay_ms(2), 2_000);
        assert_eq!(backoff_delay_ms(3), 4_000);
        assert_eq!(backoff_delay_ms(4), 8_000);
        assert_eq!(backoff_delay_ms(5), 16_000);
        assert_eq!(backoff_delay_ms(6), BACKOFF_CAP_MS);
        assert_eq!(backoff_delay_ms(20), BACKOFF_CAP_MS);
    }

    #[test]
    fn failure_class_stops_host_key_and_auth_and_retries_drops() {
        assert_eq!(
            decide_after_failure(classify_ssh_failure("Host key verification failed."), 1),
            AfterFailure::Stop
        );
        assert_eq!(
            decide_after_failure(classify_ssh_failure("Permission denied (publickey)."), 2),
            AfterFailure::Stop
        );
        assert_eq!(
            decide_after_failure(classify_ssh_failure("Connection refused"), 3),
            AfterFailure::Retry { delay_ms: 4_000 }
        );
        assert_eq!(
            classify_health_failure("api/auth rejected token: {\"ok\":false}"),
            FailureClass::Auth
        );
    }

    #[test]
    fn preview_forward_uses_the_remote_loopback_on_the_same_port() {
        let mut base = spec();
        base.remote_host = "10.0.0.4".into();
        base.remote_port = 3456;
        base.local_port = 41000;
        let preview = preview_forward_spec(&base, 5173);
        let joined = build_forward_args(&preview).join(" ");
        assert!(joined.contains("-L 127.0.0.1:5173:127.0.0.1:5173"));
        assert!(joined.contains("ubuntu@build.example"));
        assert!(!joined.contains("3456"));
        assert!(!joined.contains("41000"));
        assert!(!joined.contains("10.0.0.4"));
        let message = preview_forward_failure(FailureClass::Retryable, "Connection refused", 5173);
        assert!(message.contains("5173"));
        assert!(message.contains("Connection refused"));
        assert!(!message.contains("Reconnecting"));
    }

    #[test]
    fn redact_strips_tokens_and_private_key_blocks() {
        let raw = "JEAN_INSTALL_TOKEN=super-secret-token\nkeep\nJEAN_TOKEN=super-secret-token\n";
        let redacted = redact(raw, "super-secret-token");
        assert!(!redacted.contains("super-secret-token"));
        assert!(redacted.contains("JEAN_INSTALL_TOKEN=[redacted]"));
        assert!(redacted.contains("keep"));
        assert!(sanitize_detail("-----BEGIN OPENSSH PRIVATE KEY-----\nline").is_empty());
    }
}

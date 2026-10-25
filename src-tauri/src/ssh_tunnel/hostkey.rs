//! Explicit SSH host-key fingerprints and a Jean-owned known_hosts file.
//!
//! The first connection never uses `StrictHostKeyChecking=accept-new`. The
//! desktop shows the fingerprint, and only a confirm action writes the pin.

use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedKey {
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
}

pub fn fingerprint_sha256(public_key: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(public_key.trim())
        .map_err(|_| "Host key is not valid base64.".to_string())?;
    let digest = Sha256::digest(raw);
    let mut encoded = base64::engine::general_purpose::STANDARD.encode(digest);
    while encoded.ends_with('=') {
        encoded.pop();
    }
    Ok(format!("SHA256:{encoded}"))
}

pub fn known_hosts_marker(host: &str, port: u16) -> String {
    let bracketed = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    if port == 22 {
        bracketed
    } else {
        format!("[{host}]:{port}")
    }
}

/// Prefer ed25519, then ecdsa, then rsa. Comment and hashed lines are ignored.
pub fn parse_keyscan(output: &str) -> Option<ScannedKey> {
    let mut best: Option<(u8, ScannedKey)> = None;
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('|') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(_host) = parts.next() else {
            continue;
        };
        let Some(key_type) = parts.next() else {
            continue;
        };
        let Some(public_key) = parts.next() else {
            continue;
        };
        let key_type = key_type.to_string();
        let public_key = public_key.to_string();
        let rank = match key_type.as_str() {
            "ssh-ed25519" => 0,
            "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" => 1,
            "ssh-rsa" => 2,
            _ => 3,
        };
        let Ok(fingerprint) = fingerprint_sha256(&public_key) else {
            continue;
        };
        let candidate = ScannedKey {
            key_type,
            public_key,
            fingerprint,
        };
        let better = best
            .as_ref()
            .map(|(best_rank, _)| rank < *best_rank)
            .unwrap_or(true);
        if better {
            best = Some((rank, candidate));
        }
    }
    best.map(|(_, key)| key)
}

pub fn parse_ssh_g(output: &str) -> (Option<String>, Option<u16>) {
    let mut hostname = None;
    let mut port = None;
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let Some(value) = parts.next() else { continue };
        if key.eq_ignore_ascii_case("hostname") && !value.is_empty() {
            hostname = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("port") {
            if let Ok(parsed) = value.parse::<u16>() {
                if parsed > 0 {
                    port = Some(parsed);
                }
            }
        }
    }
    (hostname, port)
}

pub fn upsert_trusted_key(
    file: &Path,
    hosts: &[(&str, u16)],
    key_type: &str,
    public_key: &str,
    expected_fingerprint: &str,
) -> Result<(), String> {
    let fingerprint = fingerprint_sha256(public_key)?;
    if fingerprint != expected_fingerprint {
        return Err(
            "Host key does not match the confirmed fingerprint. Trust it again.".to_string(),
        );
    }
    if hosts.is_empty() {
        return Err("SSH host is required.".to_string());
    }

    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the SSH known_hosts directory: {error}"))?;
    }

    let markers: Vec<String> = hosts
        .iter()
        .map(|(host, port)| known_hosts_marker(host, *port))
        .collect();
    let existing = fs::read_to_string(file).unwrap_or_default();
    let mut kept = Vec::new();
    for line in existing.lines() {
        let marker = line.split_whitespace().next().unwrap_or("");
        if markers.iter().any(|item| item == marker) {
            continue;
        }
        if !line.trim().is_empty() {
            kept.push(line.to_string());
        }
    }
    for marker in &markers {
        kept.push(format!("{marker} {key_type} {public_key}"));
    }
    let mut body = kept.join("\n");
    body.push('\n');
    write_private_file(file, &body)?;
    Ok(())
}

pub fn trusted_fingerprint_matches(file: &Path, host: &str, port: u16, fingerprint: &str) -> bool {
    let Ok(text) = fs::read_to_string(file) else {
        return false;
    };
    let marker = known_hosts_marker(host, port);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(line_marker) = parts.next() else {
            continue;
        };
        if line_marker != marker {
            continue;
        }
        let _key_type = parts.next();
        let Some(public_key) = parts.next() else {
            continue;
        };
        if fingerprint_sha256(public_key).ok().as_deref() == Some(fingerprint) {
            return true;
        }
    }
    false
}

pub fn write_private_file(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {parent:?}: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = temp_sibling(path);
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        use std::io::Write;
        file.write_all(body.as_bytes())
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    }
    fs::rename(&tmp, path)
        .map_err(|error| format!("Could not save {}: {error}", path.display()))?;
    Ok(())
}

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("known_hosts");
    path.with_file_name(format!(".{name}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_KEY: &str = "amVhbi1zc2gtdHVubmVsLXRlc3Qta2V5LW1hdGVyaWFsLTAx";
    const SAMPLE_FINGERPRINT: &str = "SHA256:VXOwYc8SlaNTtvwWXHbY2czg60R6TkMijEdRlhI8wtM";

    #[test]
    fn fingerprint_matches_openssh_sha256() {
        assert_eq!(fingerprint_sha256(SAMPLE_KEY).unwrap(), SAMPLE_FINGERPRINT);
    }

    #[test]
    fn keyscan_prefers_ed25519() {
        let output = "\
# comment
10.0.0.5 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7example\n\
10.0.0.5 ssh-ed25519 amVhbi1zc2gtdHVubmVsLXRlc3Qta2V5LW1hdGVyaWFsLTAx\n";
        let parsed = parse_keyscan(output).unwrap();
        assert_eq!(parsed.key_type, "ssh-ed25519");
        assert_eq!(parsed.fingerprint, SAMPLE_FINGERPRINT);
    }

    #[test]
    fn known_hosts_round_trip_replaces_changed_keys() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("known_hosts");
        upsert_trusted_key(
            &file,
            &[("build.example", 22), ("10.0.0.5", 2222)],
            "ssh-ed25519",
            SAMPLE_KEY,
            SAMPLE_FINGERPRINT,
        )
        .unwrap();
        assert!(trusted_fingerprint_matches(
            &file,
            "build.example",
            22,
            SAMPLE_FINGERPRINT
        ));
        assert!(trusted_fingerprint_matches(
            &file,
            "10.0.0.5",
            2222,
            SAMPLE_FINGERPRINT
        ));
        assert!(!trusted_fingerprint_matches(
            &file,
            "build.example",
            22,
            "SHA256:different"
        ));

        let other = "amVhbi1zc2gtdHVubmVsLXRlc3Qta2V5LW1hdGVyaWFsLTAy";
        let other_fp = fingerprint_sha256(other).unwrap();
        upsert_trusted_key(
            &file,
            &[("build.example", 22)],
            "ssh-ed25519",
            other,
            &other_fp,
        )
        .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("build.example "))
                .count(),
            1
        );
        assert!(text.contains(other));
        assert!(!trusted_fingerprint_matches(
            &file,
            "build.example",
            22,
            SAMPLE_FINGERPRINT
        ));
    }

    #[test]
    fn refuses_fingerprint_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let error = upsert_trusted_key(
            &dir.path().join("known_hosts"),
            &[("host", 22)],
            "ssh-ed25519",
            SAMPLE_KEY,
            "SHA256:nope",
        )
        .unwrap_err();
        assert!(error.contains("does not match"));
    }

    #[test]
    fn parses_ssh_g_hostname_and_port() {
        let (host, port) = parse_ssh_g("user ubuntu\nhostname 10.0.0.5\nport 2222\n");
        assert_eq!(host.as_deref(), Some("10.0.0.5"));
        assert_eq!(port, Some(2222));
    }
}

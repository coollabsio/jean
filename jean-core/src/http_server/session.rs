//! Browser sessions for web access.
//!
//! A browser exchanges the access token once (`/api/auth?token=…`) for a random
//! session ID kept in an `HttpOnly` cookie, so the token never lives in browser
//! storage. Only SHA-256 hashes of session IDs are written to disk. Each session
//! is bound to a fingerprint of the access token it was created with, so
//! regenerating the token signs out every browser.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Sliding expiry: a session expires after this long without use.
pub const SESSION_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// `last_used_at` is persisted at most this often, to avoid a disk write per request.
const TOUCH_PERSIST_SECS: u64 = 60 * 60;
const MAX_SESSIONS: usize = 100;
/// Failed token attempts allowed per IP within `FAILURE_WINDOW`.
const MAX_FAILURES: usize = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct SessionRecord {
    token_fingerprint: String,
    created_at: u64,
    last_used_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct SessionFile {
    /// Keyed by SHA-256 hex of the session ID.
    sessions: HashMap<String, SessionRecord>,
}

pub struct WebSessions {
    path: Option<PathBuf>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    failures: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_live(record: &SessionRecord, fingerprint: &str, now: u64) -> bool {
    record.token_fingerprint == fingerprint
        && now.saturating_sub(record.last_used_at) < SESSION_TTL_SECS
}

impl WebSessions {
    /// Load sessions from `path`. A missing or unreadable file starts empty.
    pub fn load(path: PathBuf) -> Self {
        let sessions = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SessionFile>(&bytes).ok())
            .map(|file| file.sessions)
            .unwrap_or_default();
        Self {
            path: Some(path),
            sessions: Mutex::new(sessions),
            failures: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            path: None,
            sessions: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn persist(&self, sessions: &HashMap<String, SessionRecord>) {
        let Some(path) = &self.path else { return };
        let file = SessionFile {
            sessions: sessions.clone(),
        };
        match serde_json::to_vec(&file) {
            Ok(bytes) => {
                if let Err(e) = crate::platform::write_file_atomically(path, &bytes) {
                    log::warn!("Failed to save web sessions: {e}");
                }
            }
            Err(e) => log::warn!("Failed to serialize web sessions: {e}"),
        }
    }

    /// Create a session for `token` and return its ID (the cookie value).
    pub fn create(&self, token: &str, now: u64) -> String {
        let id = super::auth::generate_token();
        let fingerprint = sha256_hex(token);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, record| is_live(record, &fingerprint, now));
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, record)| record.last_used_at)
                .map(|(hash, _)| hash.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            sha256_hex(&id),
            SessionRecord {
                token_fingerprint: fingerprint,
                created_at: now,
                last_used_at: now,
            },
        );
        self.persist(&sessions);
        id
    }

    /// Whether `id` is a live session for the current `token`. Extends its expiry.
    pub fn validate(&self, id: &str, token: &str, now: u64) -> bool {
        let fingerprint = sha256_hex(token);
        let mut sessions = self.sessions.lock().unwrap();
        let Some(record) = sessions.get_mut(&sha256_hex(id)) else {
            return false;
        };
        if !is_live(record, &fingerprint, now) {
            return false;
        }
        if now.saturating_sub(record.last_used_at) >= TOUCH_PERSIST_SECS {
            record.last_used_at = now;
            self.persist(&sessions);
        }
        true
    }

    pub fn revoke(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.remove(&sha256_hex(id)).is_some() {
            self.persist(&sessions);
        }
    }

    /// Whether `ip` used up its failed token attempts in the current window.
    pub fn is_rate_limited(&self, ip: IpAddr, now: Instant) -> bool {
        let mut failures = self.failures.lock().unwrap();
        let Some(attempts) = failures.get_mut(&ip) else {
            return false;
        };
        attempts.retain(|at| now.duration_since(*at) < FAILURE_WINDOW);
        if attempts.is_empty() {
            failures.remove(&ip);
            return false;
        }
        attempts.len() >= MAX_FAILURES
    }

    pub fn record_failure(&self, ip: IpAddr, now: Instant) {
        let mut failures = self.failures.lock().unwrap();
        failures.retain(|_, attempts| {
            attempts.retain(|at| now.duration_since(*at) < FAILURE_WINDOW);
            !attempts.is_empty()
        });
        failures.entry(ip).or_default().push(now);
    }
}

/// Cookie name per port: cookies ignore ports, so two Jean servers on one
/// host must not overwrite each other's session.
pub fn cookie_name(port: u16) -> String {
    format!("jean_session_{port}")
}

/// `Set-Cookie` value for a session. No `Secure` flag: web access also runs on
/// plain `http://` (LAN, Tailscale), where browsers drop `Secure` cookies.
pub fn session_cookie(name: &str, id: &str) -> String {
    format!("{name}={id}; Path=/; Max-Age={SESSION_TTL_SECS}; HttpOnly; SameSite=Lax")
}

pub fn expired_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

/// Value of cookie `name` from the request's `Cookie` headers.
pub fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn session_validates_until_idle_ttl() {
        let sessions = WebSessions::in_memory();
        let id = sessions.create("token", 1_000);
        assert!(sessions.validate(&id, "token", 1_000 + SESSION_TTL_SECS - 1));
        assert!(!sessions.validate("other", "token", 1_000));
    }

    #[test]
    fn use_extends_session_expiry() {
        let sessions = WebSessions::in_memory();
        let id = sessions.create("token", 0);
        let later = SESSION_TTL_SECS - 10;
        assert!(sessions.validate(&id, "token", later));
        assert!(sessions.validate(&id, "token", later + SESSION_TTL_SECS - 1));
    }

    #[test]
    fn idle_session_expires() {
        let sessions = WebSessions::in_memory();
        let id = sessions.create("token", 0);
        assert!(!sessions.validate(&id, "token", SESSION_TTL_SECS));
    }

    #[test]
    fn regenerated_token_invalidates_sessions() {
        let sessions = WebSessions::in_memory();
        let id = sessions.create("old-token", 0);
        assert!(!sessions.validate(&id, "new-token", 1));
    }

    #[test]
    fn revoked_session_is_rejected() {
        let sessions = WebSessions::in_memory();
        let id = sessions.create("token", 0);
        sessions.revoke(&id);
        assert!(!sessions.validate(&id, "token", 1));
    }

    #[test]
    fn sessions_survive_reload_and_store_only_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("web-sessions.json");
        let id = WebSessions::load(path.clone()).create("token", 0);

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&id));
        assert!(!raw.contains("\"token\""));
        assert!(WebSessions::load(path).validate(&id, "token", 1));
    }

    #[test]
    fn rate_limit_blocks_after_max_failures_and_resets() {
        let sessions = WebSessions::in_memory();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let other: IpAddr = "10.0.0.2".parse().unwrap();
        let start = Instant::now();
        for _ in 0..MAX_FAILURES {
            assert!(!sessions.is_rate_limited(ip, start));
            sessions.record_failure(ip, start);
        }
        assert!(sessions.is_rate_limited(ip, start));
        assert!(!sessions.is_rate_limited(other, start));
        assert!(!sessions.is_rate_limited(ip, start + FAILURE_WINDOW));
    }

    #[test]
    fn cookie_value_finds_named_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; jean_session_3456=abc"),
        );
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("jean_session_4000=def"),
        );
        assert_eq!(
            cookie_value(&headers, "jean_session_3456").as_deref(),
            Some("abc")
        );
        assert_eq!(
            cookie_value(&headers, "jean_session_4000").as_deref(),
            Some("def")
        );
        assert_eq!(cookie_value(&headers, "jean_session_1"), None);
    }

    #[test]
    fn session_cookie_is_http_only_and_lax_without_secure() {
        let cookie = session_cookie("jean_session_3456", "abc");
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"));
    }
}

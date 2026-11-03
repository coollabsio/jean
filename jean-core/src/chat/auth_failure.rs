//! Sessions whose last turn failed because the backend CLI is not logged in.
//!
//! Backends report failures only through `chat:error` events, emitted from
//! many places. A listener records auth failures here so the send path can
//! withdraw the prompt (back to the composer, out of history) instead of
//! keeping it as a failed attempt: the user must log in and resend anyway.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use tauri::AppHandle;

static AUTH_FAILED_SESSIONS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// True when a backend error means the CLI is not logged in. Mirrors
/// `isCliAuthError` in `src/lib/cli-auth.ts`.
pub fn is_cli_auth_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    const MARKERS: [&str; 21] = [
        "not logged in",
        "please run /login",
        "not authenticated",
        "authentication required",
        "auth required",
        "login required",
        "please log in",
        "please login",
        "unauthorized",
        "token expired",
        "session expired",
        "to authenticate",
        "to log in again",
        "to login again",
        "run `claude`",
        "run `codex`",
        "run `opencode`",
        "run `devin`",
        "run `agy`",
        "run `muse login`",
        "launch the cli without arguments to sign in",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
        || (lower.contains("isn't available in this environment") && lower.contains("login"))
}

/// Record `chat:error` auth failures. The runtime calls listeners
/// synchronously inside `emit`, so the entry exists before the send path
/// finishes the run.
pub fn start_auth_failure_listener(app: &AppHandle) {
    app.listen("chat:error", |event| {
        #[derive(serde::Deserialize)]
        struct Payload {
            session_id: String,
            error: String,
        }
        let Ok(payload) = serde_json::from_str::<Payload>(event.payload()) else {
            return;
        };
        if is_cli_auth_error(&payload.error) {
            AUTH_FAILED_SESSIONS
                .lock()
                .unwrap()
                .insert(payload.session_id);
        }
    });
}

/// Whether the session's turn failed on auth since the last call. Clears it.
pub fn take_auth_failure(session_id: &str) -> bool {
    AUTH_FAILED_SESSIONS.lock().unwrap().remove(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cli_auth_errors() {
        assert!(is_cli_auth_error("Not logged in · Please run /login"));
        assert!(is_cli_auth_error("Claude is not authenticated."));
        assert!(is_cli_auth_error(
            "/login isn't available in this environment"
        ));
    }

    #[test]
    fn ignores_other_provider_errors() {
        assert!(!is_cli_auth_error("Claude AI usage limit reached"));
        assert!(!is_cli_auth_error("API Error: 529 overloaded"));
    }

    #[test]
    fn take_clears_the_entry() {
        AUTH_FAILED_SESSIONS
            .lock()
            .unwrap()
            .insert("s-take".to_string());
        assert!(take_auth_failure("s-take"));
        assert!(!take_auth_failure("s-take"));
    }
}

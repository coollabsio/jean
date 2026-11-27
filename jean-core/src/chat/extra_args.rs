//! User-defined extra CLI arguments per backend (issue #335), for example
//! `opencode --pure`.
//!
//! The preference is one string per backend in
//! `AppPreferences.cli_extra_args`, keyed by the backend id. It is split with
//! shell-words rules and passed as separate argv items, never as a shell
//! string. Jean's own flags win: a user flag is dropped when it is reserved
//! for the backend (output format, permissions, session, transport) or when
//! Jean already passes the same flag on this spawn.

use super::types::Backend;
use tauri::AppHandle;

/// Characters that `cmd.exe` treats as operators. On Windows, npm `.cmd`
/// shims run through `cmd.exe /C` (`platform::cli_command`), and `std` quotes
/// only whitespace there, so these must never reach argv.
const FORBIDDEN_CHARS: &[char] = &['&', '|', '^', '<', '>', '%', '\r', '\n', '\0'];

/// Preference key for a backend (matches the backend's serde name).
pub fn backend_key(backend: &Backend) -> &'static str {
    match backend {
        Backend::Claude => "claude",
        Backend::Codex => "codex",
        Backend::Opencode => "opencode",
        Backend::Cursor => "cursor",
        Backend::Pi => "pi",
        Backend::Commandcode => "commandcode",
        Backend::Grok => "grok",
        Backend::Kimi => "kimi",
        Backend::Devin => "devin",
        Backend::Antigravity => "antigravity",
        Backend::Muse => "muse",
    }
}

/// Flags Jean controls for a backend. A user value for these would change the
/// output format Jean parses, bypass the execution mode, or break the session
/// and transport wiring, so they are always dropped.
fn reserved_flags(backend: &Backend) -> &'static [&'static str] {
    match backend {
        Backend::Claude => &[
            "-p",
            "--print",
            "--output-format",
            "--input-format",
            "--json-schema",
            "--replay-user-messages",
            "--include-partial-messages",
            "-r",
            "--resume",
            "-c",
            "--continue",
            "--session-id",
            "--fork-session",
            "--permission-mode",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--permission-prompt-tool",
        ],
        Backend::Codex => &[
            "--json",
            "--experimental-json",
            "--output-schema",
            "-o",
            "--output-last-message",
            "-s",
            "--sandbox",
            "-a",
            "--ask-for-approval",
            "--full-auto",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--listen",
            "--print-startup-config",
            "--startup-sign-out",
        ],
        Backend::Opencode => &["--hostname", "--port", "--stdio", "--service", "--cors"],
        Backend::Cursor => &[
            "-p",
            "--print",
            "--output-format",
            "--stream-partial-output",
            "--resume",
            "-f",
            "--force",
            "--yolo",
            "--mode",
            "--sandbox",
            "--trust",
            "--workspace",
        ],
        Backend::Pi => &[
            "--mode",
            "-p",
            "--print",
            "--session",
            "--no-session",
            "--continue",
            "-c",
        ],
        Backend::Commandcode => &[
            "-p",
            "--print",
            "--output-format",
            "--resume",
            "--continue",
            "--yolo",
            "--auto-accept",
            "--dangerously-skip-permissions",
            "--permission-mode",
        ],
        Backend::Grok => &[
            "-p",
            "--print",
            "--output-format",
            "--resume",
            "--yolo",
            "--permission-mode",
            "--sandbox",
            "--always-approve",
            "--cwd",
            "--prompt-file",
            "--no-plan",
            "--leader",
            "--no-leader",
        ],
        Backend::Kimi => &[
            "--print",
            "--output-format",
            "--input-format",
            "--yolo",
            "--yes",
            "-y",
            "--session",
            "--continue",
        ],
        Backend::Devin => &[
            "-p",
            "--print",
            "--output-format",
            "--permission-mode",
            "--dangerously-skip-permissions",
            "--resume",
            "--continue",
            "--cloud",
        ],
        Backend::Antigravity => &[
            "-p",
            "--prompt",
            "-o",
            "--output-format",
            "-y",
            "--yolo",
            "--approval-mode",
            "-r",
            "--resume",
            "--mode",
            "--sandbox",
            "--dangerously-skip-permissions",
            "--conversation",
            "--json-schema",
        ],
        Backend::Muse => &[
            "--json",
            "--permission-profile",
            "--output-schema",
            "--trust-workspace",
            "--disable-request-user-input",
            "--disable-sandbox",
            "--yolo",
        ],
    }
}

/// Flags that a CLI accepts many times, where a user value does not replace
/// Jean's value. Codex `-c key=value` overrides apply in order, and Jean's
/// come after the user's, so Jean still wins for the same key.
fn repeatable_flags(backend: &Backend) -> &'static [&'static str] {
    match backend {
        Backend::Claude => &["--add-dir", "--allowedTools", "--disallowedTools"],
        Backend::Codex => &["-c", "--config", "--enable", "--disable"],
        Backend::Muse => &["-c", "--config"],
        _ => &[],
    }
}

fn is_flag(token: &str) -> bool {
    token.len() > 1 && token.starts_with('-')
}

fn flag_name(token: &str) -> &str {
    token.split_once('=').map_or(token, |(name, _)| name)
}

/// Split the preference string with shell-words rules and validate it.
///
/// Only flags are accepted. A bare word is allowed only as the value directly
/// after a flag (`--log-level debug`), so a user value can never become the
/// prompt or a subcommand.
pub fn parse_extra_args(raw: &str) -> Result<Vec<String>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let tokens = shell_words::split(raw).map_err(|e| format!("Invalid quoting: {e}"))?;
    let mut previous_was_flag = false;
    for token in &tokens {
        if let Some(c) = token.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
            return Err(format!(
                "Argument '{token}' contains the forbidden character '{c}'"
            ));
        }
        if token == "--" {
            return Err("The '--' separator is not allowed".to_string());
        }
        if is_flag(token) {
            previous_was_flag = true;
        } else if previous_was_flag {
            previous_was_flag = false;
        } else {
            return Err(format!(
                "Argument '{token}' must be a flag (start with '-') or the value of the flag before it"
            ));
        }
    }
    Ok(tokens)
}

/// Remove user flags that Jean must control. A dropped flag also drops its
/// bare value (`--model x` drops both tokens).
pub fn filter_extra_args(
    user: Vec<String>,
    jean_args: &[String],
    backend: &Backend,
) -> Vec<String> {
    let reserved = reserved_flags(backend);
    let repeatable = repeatable_flags(backend);
    let jean_flags: Vec<&str> = jean_args
        .iter()
        .filter(|arg| is_flag(arg))
        .map(|arg| flag_name(arg))
        .collect();

    let mut kept = Vec::with_capacity(user.len());
    let mut dropping = false;
    for token in user {
        if !is_flag(&token) {
            if !dropping {
                kept.push(token);
            }
            dropping = false;
            continue;
        }
        let name = flag_name(&token);
        dropping =
            reserved.contains(&name) || (jean_flags.contains(&name) && !repeatable.contains(&name));
        if dropping {
            log::warn!(
                "Ignoring extra {} CLI argument '{name}': Jean controls this flag",
                backend_key(backend)
            );
        } else {
            kept.push(token);
        }
    }
    kept
}

/// Parse and filter the raw preference string for one spawn.
pub fn build_extra_args(
    raw: Option<&str>,
    jean_args: &[String],
    backend: &Backend,
) -> Result<Vec<String>, String> {
    let user = parse_extra_args(raw.unwrap_or_default()).map_err(|e| {
        format!(
            "Invalid extra CLI arguments for {} (Settings > Backends): {e}",
            backend_key(backend)
        )
    })?;
    Ok(filter_extra_args(user, jean_args, backend))
}

/// The user's extra args for `backend`, filtered against `jean_args` (the
/// args Jean passes on this spawn). Returns an error for an invalid
/// preference so the run fails with a clear message instead of silently
/// running without the user's flags.
pub fn extra_args_for(
    app: &AppHandle,
    backend: &Backend,
    jean_args: &[String],
) -> Result<Vec<String>, String> {
    let prefs = crate::load_preferences_sync(app)?;
    build_extra_args(
        prefs
            .cli_extra_args
            .get(backend_key(backend))
            .map(String::as_str),
        jean_args,
        backend,
    )
}

/// Append the user's extra args to a `Command`, filtered against the args
/// Jean already added to it. Call it after Jean's flags; on CLIs with a
/// trailing positional prompt, call it before that positional.
pub fn apply_extra_args(
    app: &AppHandle,
    backend: &Backend,
    command: &mut std::process::Command,
) -> Result<(), String> {
    let jean_args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    command.args(extra_args_for(app, backend, &jean_args)?);
    Ok(())
}

/// Insert the user's extra args into `args` at `index` (after a subcommand
/// such as `exec`), so Jean's later flags are parsed after the user's.
pub fn insert_extra_os_args(
    app: &AppHandle,
    backend: &Backend,
    args: &mut Vec<std::ffi::OsString>,
    index: usize,
) -> Result<(), String> {
    let prefs = crate::load_preferences_sync(app)?;
    let raw = prefs
        .cli_extra_args
        .get(backend_key(backend))
        .map(String::as_str);
    splice_extra_os_args(raw, backend, args, index)
}

/// Pure part of [`insert_extra_os_args`].
pub(crate) fn splice_extra_os_args(
    raw: Option<&str>,
    backend: &Backend,
    args: &mut Vec<std::ffi::OsString>,
    index: usize,
) -> Result<(), String> {
    let jean_args: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let extra = build_extra_args(raw, &jean_args, backend)?;
    args.splice(index..index, extra.into_iter().map(Into::into));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn parse_empty_and_whitespace_is_empty() {
        assert_eq!(parse_extra_args("").unwrap(), Vec::<String>::new());
        assert_eq!(parse_extra_args("   \t ").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn parse_splits_flags_and_values() {
        assert_eq!(
            parse_extra_args("--pure --log-level debug").unwrap(),
            strings(&["--pure", "--log-level", "debug"])
        );
    }

    #[test]
    fn parse_honors_quotes() {
        assert_eq!(
            parse_extra_args(r#"--agent 'my agent' --title="a b""#).unwrap(),
            strings(&["--agent", "my agent", "--title=a b"])
        );
    }

    #[test]
    fn parse_rejects_unmatched_quote() {
        let err = parse_extra_args("--agent 'oops").unwrap_err();
        assert!(err.contains("Invalid quoting"), "{err}");
    }

    #[test]
    fn parse_rejects_shell_metacharacters() {
        for raw in [
            "--x a&b",
            "--x 'a|b'",
            "--x '%PATH%'",
            "--x 'a\nb'",
            "--x '>out'",
        ] {
            assert!(parse_extra_args(raw).is_err(), "{raw:?} should be rejected");
        }
    }

    #[test]
    fn parse_rejects_positional_and_separator() {
        assert!(parse_extra_args("hello").is_err());
        assert!(parse_extra_args("--flag value extra").is_err());
        assert!(parse_extra_args("--pure --").is_err());
    }

    #[test]
    fn filter_drops_reserved_flag_and_its_value() {
        let kept = filter_extra_args(
            strings(&["--output-format", "text", "--verbose"]),
            &[],
            &Backend::Claude,
        );
        assert_eq!(kept, strings(&["--verbose"]));
    }

    #[test]
    fn filter_drops_flag_jean_already_passes() {
        let jean = strings(&["exec", "--model", "gpt-5", "-"]);
        let kept = filter_extra_args(
            strings(&["--model=o3", "--profile", "work"]),
            &jean,
            &Backend::Codex,
        );
        assert_eq!(kept, strings(&["--profile", "work"]));
    }

    #[test]
    fn filter_keeps_repeatable_codex_config_overrides() {
        let jean = strings(&["exec", "-c", "model_verbosity=\"low\""]);
        let kept = filter_extra_args(
            strings(&["-c", "web_search=\"live\""]),
            &jean,
            &Backend::Codex,
        );
        assert_eq!(kept, strings(&["-c", "web_search=\"live\""]));
    }

    #[test]
    fn build_opencode_serve_args_keep_pure_and_drop_port() {
        let jean = strings(&["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
        let kept = build_extra_args(Some("--pure --port 9999"), &jean, &Backend::Opencode).unwrap();
        assert_eq!(kept, strings(&["--pure"]));
    }

    #[test]
    fn build_claude_args_drop_permission_bypass() {
        let jean = strings(&["--print", "--model", "sonnet"]);
        let kept = build_extra_args(
            Some("--dangerously-skip-permissions --model opus --debug api"),
            &jean,
            &Backend::Claude,
        )
        .unwrap();
        assert_eq!(kept, strings(&["--debug", "api"]));
    }

    #[test]
    fn build_reports_backend_on_invalid_input() {
        let err = build_extra_args(Some("'"), &[], &Backend::Pi).unwrap_err();
        assert!(err.contains("for pi"), "{err}");
    }

    #[test]
    fn build_without_preference_is_empty() {
        assert!(build_extra_args(None, &[], &Backend::Cursor)
            .unwrap()
            .is_empty());
    }
}

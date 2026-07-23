// Cross-platform abstractions for shell execution and process management

pub mod cli_detect;
pub mod process;
pub mod shell;
pub mod wsl;

pub use cli_detect::*;
pub use process::*;
pub use shell::*;
pub use wsl::*;

use std::sync::atomic::{AtomicBool, Ordering};

/// Explicit opt-in for native open actions over the HTTP/WebSocket transport.
/// Set via `--allow-native-open` / `JEAN_ALLOW_NATIVE_OPEN=1`, or automatically
/// when the desktop app hosts Web Access (GUI-capable process).
static ALLOW_NATIVE_OPEN: AtomicBool = AtomicBool::new(false);

/// Enable or disable the explicit native-open opt-in for headless/web transport.
pub fn set_allow_native_open(enabled: bool) {
    ALLOW_NATIVE_OPEN.store(enabled, Ordering::Relaxed);
}

/// True when native open was explicitly enabled (CLI/env or desktop host).
pub fn allow_native_open_enabled() -> bool {
    ALLOW_NATIVE_OPEN.load(Ordering::Relaxed)
}

/// Whether HTTP dispatch may spawn local file managers / editors / terminals.
///
/// Allowed when:
/// - the process is the desktop app hosting Web Access (`set_allow_native_open(true)`), or
/// - the operator passed `--allow-native-open` / `JEAN_ALLOW_NATIVE_OPEN=1`, or
/// - Jean is running under WSL (can launch Windows host tools like `explorer.exe`)
pub fn native_open_allowed() -> bool {
    allow_native_open_enabled() || is_running_in_wsl()
}

/// Reject native open commands unless [`native_open_allowed`].
pub fn ensure_native_open_allowed(action: &str) -> Result<(), String> {
    if native_open_allowed() {
        Ok(())
    } else {
        Err(format!(
            "Opening {action} is only available in the desktop app, under WSL, or with --allow-native-open"
        ))
    }
}

/// Serialize tests that mutate the process-wide native-open flag.
#[cfg(test)]
pub fn with_native_open_flag_lock<T>(f: impl FnOnce() -> T) -> T {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

#[cfg(test)]
mod native_open_tests {
    use super::*;

    #[test]
    fn native_open_respects_explicit_flag() {
        with_native_open_flag_lock(|| {
            let previous = allow_native_open_enabled();
            set_allow_native_open(false);
            // Without the flag, permission depends only on WSL detection.
            let without_flag = native_open_allowed();
            assert_eq!(without_flag, is_running_in_wsl());

            set_allow_native_open(true);
            assert!(native_open_allowed());
            assert!(ensure_native_open_allowed("an editor").is_ok());

            set_allow_native_open(previous);
        });
    }

    #[test]
    fn ensure_native_open_mentions_desktop_app_when_blocked() {
        with_native_open_flag_lock(|| {
            let previous = allow_native_open_enabled();
            set_allow_native_open(false);
            if !is_running_in_wsl() {
                let err = ensure_native_open_allowed("a file manager").unwrap_err();
                assert!(err.contains("desktop app"), "{err}");
                assert!(err.contains("allow-native-open"), "{err}");
            }
            set_allow_native_open(previous);
        });
    }
}

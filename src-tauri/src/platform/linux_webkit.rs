//! Linux WebKitGTK environment defaults for Tauri desktop runs.
//!
//! Transparent windows + hardware compositing break on many Linux setups
//! (NVIDIA, GBM/DMABUF, some Wayland compositors). Defaults prioritize
//! *performance* on modern GPUs while keeping the DMABUF workaround that
//! prevents common GBM crashes. Full software-compositing mode remains
//! available via `JEAN_SAFE_GRAPHICS=1` for broken drivers (issue #129).
//!
//! Related: https://github.com/coollabsio/jean/issues/100

/// Whether full safe-graphics mode is requested (software compositing path).
pub fn safe_graphics_requested() -> bool {
    is_truthy_env(&std::env::var("JEAN_SAFE_GRAPHICS").unwrap_or_default())
}

/// Parse common truthy env values (`1`, `true`, `yes`; case-insensitive).
pub fn is_truthy_env(value: &str) -> bool {
    matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}

/// Apply Linux WebKitGTK / GDK environment defaults before the webview starts.
///
/// - Always leaves user-set variables alone (`var_os(...).is_none()` guards).
/// - Defaults `WEBKIT_DISABLE_DMABUF_RENDERER=1` (stability; low perf impact).
/// - Enables `WEBKIT_DISABLE_COMPOSITING_MODE=1` only when `JEAN_SAFE_GRAPHICS=1`
///   (software compositing is much slower on low-power CPUs such as Intel N97).
/// - Optional `JEAN_FORCE_X11=1` sets `GDK_BACKEND=x11` outside AppImage.
pub fn apply_linux_webkit_env() {
    log::trace!("Setting WebKit compatibility fixes for Linux");

    let is_appimage =
        std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
    if is_appimage {
        log::trace!("Running inside AppImage");
    }

    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    let xdg_session_type = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_lowercase();
    let is_wayland = wayland_display.is_some() || xdg_session_type == "wayland";
    let compositor = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    log::trace!(
        "Display: wayland={is_wayland}, compositor={compositor}, session={xdg_session_type}"
    );

    // DMABUF is a frequent GBM-error trigger; disable unless the user overrides.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: called once during process startup before the webview/runtime
        // spawns threads that could race on the process environment.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        log::trace!("WEBKIT_DISABLE_DMABUF_RENDERER=1");
    }

    // Full software compositing is opt-in: it avoids some driver bugs but can
    // peg low-power CPUs (issue #129). Users can also set the env var directly.
    if safe_graphics_requested() && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none()
    {
        // SAFETY: same startup-only rationale as above.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        log::trace!("WEBKIT_DISABLE_COMPOSITING_MODE=1 (JEAN_SAFE_GRAPHICS)");
    }

    let force_x11 = std::env::var("JEAN_FORCE_X11").unwrap_or_else(|_| "0".to_string()) == "1";
    if force_x11 && is_appimage {
        log::trace!(
            "JEAN_FORCE_X11 requested but ignored in AppImage (AppRun/apprun-hooks control backend)"
        );
    }
    if !is_appimage && force_x11 && std::env::var_os("GDK_BACKEND").is_none() {
        // SAFETY: same startup-only rationale as above.
        unsafe {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        log::trace!("GDK_BACKEND=x11 (forced by JEAN_FORCE_X11)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_truthy_env_parses_common_values() {
        for value in ["1", "true", "TRUE", "yes", "Yes"] {
            assert!(is_truthy_env(value), "expected {value} to be truthy");
        }
        for value in ["0", "false", "no", "", "maybe", "on"] {
            assert!(!is_truthy_env(value), "expected {value} to be falsey");
        }
    }

    #[test]
    fn safe_graphics_helper_reads_env() {
        // Best-effort: only assert when the variable is unset or already a
        // known truthy/falsey value so parallel tests that set JEAN_SAFE_GRAPHICS
        // do not flake.
        match std::env::var("JEAN_SAFE_GRAPHICS") {
            Err(_) => assert!(!safe_graphics_requested()),
            Ok(v) => {
                assert_eq!(safe_graphics_requested(), is_truthy_env(&v));
            }
        }
    }
}

#[cfg(target_os = "windows")]
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "windows")]
pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "windows")]
pub fn show_notification(
    app: &AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    let executable = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Failed to resolve the Jean executable directory".to_string())?;
    let app_id = toast_app_id_for_exe_dir(directory, &app.config().identifier);
    let app = app.clone();
    Toast::new(&app_id)
        .title(&title)
        .text2(body.as_deref().unwrap_or_default())
        .on_activated(move |_| {
            restore_main_window(&app);
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

/// Resolve the toast app id for the current executable directory.
///
/// Unbundled `target\\debug` / `target\\release` builds must use PowerShell's
/// AUMID so Windows still delivers toasts; packaged installs use Jean's id.
#[cfg(target_os = "windows")]
pub(crate) fn toast_app_id_for_exe_dir(exe_dir: &std::path::Path, app_identifier: &str) -> String {
    use tauri_winrt_notification::Toast;

    let is_unbundled_build =
        exe_dir.ends_with("target\\debug") || exe_dir.ends_with("target\\release");
    if is_unbundled_build {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app_identifier.to_string()
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::toast_app_id_for_exe_dir;
    use std::path::Path;
    use tauri_winrt_notification::Toast;

    #[test]
    fn unbundled_debug_builds_use_powershell_app_id() {
        let app_id = toast_app_id_for_exe_dir(Path::new(r"C:\repo\target\debug"), "io.jean.app");
        assert_eq!(app_id, Toast::POWERSHELL_APP_ID);
    }

    #[test]
    fn unbundled_release_builds_use_powershell_app_id() {
        let app_id = toast_app_id_for_exe_dir(Path::new(r"C:\repo\target\release"), "io.jean.app");
        assert_eq!(app_id, Toast::POWERSHELL_APP_ID);
    }

    #[test]
    fn packaged_builds_use_app_identifier() {
        let app_id =
            toast_app_id_for_exe_dir(Path::new(r"C:\Program Files\Jean"), "io.jean.app");
        assert_eq!(app_id, "io.jean.app");
    }
}

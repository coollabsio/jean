use tauri::{AppHandle, Manager, Runtime};

/// Restore Jean's main window after the user activates a native notification.
pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Show a Windows notification and restore Jean when its body is clicked.
#[cfg(target_os = "windows")]
pub fn show_notification(
    app: &AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    let exe = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "Failed to resolve the Jean executable directory".to_string())?;
    let is_unbundled_build =
        exe_dir.ends_with("target\\debug") || exe_dir.ends_with("target\\release");
    let app_id = if is_unbundled_build {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
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

#[cfg(test)]
mod tests {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn restore_main_window_shows_and_unminimizes_it() {
        let app = tauri::test::mock_app();
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        window.minimize().unwrap();
        window.hide().unwrap();

        super::restore_main_window(app.handle());

        assert!(window.is_visible().unwrap());
        assert!(!window.is_minimized().unwrap());
    }
}

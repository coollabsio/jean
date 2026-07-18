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
    let unbundled = directory.ends_with("target\\debug") || directory.ends_with("target\\release");
    let app_id = if unbundled {
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

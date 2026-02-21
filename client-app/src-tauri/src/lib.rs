use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::fs;
use std::path::PathBuf;

/// Client connection configuration stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClientConfig {
    /// The URL of the Jean server (e.g. "http://192.168.1.100:3456")
    #[serde(default)]
    pub server_url: String,
    /// Access token for authenticating with the server
    #[serde(default)]
    pub server_token: String,
}

/// Get the path to client-config.json in the Tauri app data directory.
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not determine app data directory: {e}"))?;

    fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;

    Ok(app_data.join("client-config.json"))
}

/// Load the client connection config from disk.
#[tauri::command]
fn load_client_config(app: tauri::AppHandle) -> Result<ClientConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(ClientConfig::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse config: {e}"))
}

/// Send a native system notification.
#[tauri::command]
fn send_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut notification = app.notification().builder().title(&title);
    if let Some(b) = body.as_deref() {
        notification = notification.body(b);
    }
    notification.show().map_err(|e| format!("Notification failed: {e}"))
}

/// Save the client connection config to disk.
#[tauri::command]
fn save_client_config(app: tauri::AppHandle, config: ClientConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let contents =
        serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn run() {
    // FIX: Avoid WebKit GBM buffer errors on Linux (especially NVIDIA)
    //
    // This issue occurs when using transparent windows with WebKitGTK on Linux,
    // particularly with NVIDIA GPUs. The error "Failed to create GBM buffer of size NxN: Invalid argument"
    // is caused by incompatibilities between hardware-accelerated compositing and certain
    // GPU drivers/compositors.
    //
    // Related issues:
    // - https://github.com/tauri-apps/tauri/issues/13493
    // - https://github.com/tauri-apps/tauri/issues/8254
    // - https://bugs.webkit.org/show_bug.cgi?id=165246
    // - https://github.com/tauri-apps/tauri/issues/9394 (NVIDIA problems doc)
    //
    // The fix disables problematic GPU compositing modes. Users can override via env vars:
    // - JEAN_FORCE_X11=1 to force X11 backend (default: no)
    // - WEBKIT_DISABLE_COMPOSITING_MODE=0 to re-enable GPU compositing (risky)
    #[cfg(target_os = "linux")]
    {
        log::trace!("Setting WebKit compatibility fixes for Linux (client app)");

        // Disable problematic GPU compositing modes
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            log::trace!("WEBKIT_DISABLE_COMPOSITING_MODE=1");
        }

        // Disable DMABUF renderer (common cause of GBM errors)
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            log::trace!("WEBKIT_DISABLE_DMABUF_RENDERER=1");
        }

        // Force X11 backend if Wayland causes issues
        // Check if user explicitly wants X11 via environment variable
        let force_x11 = std::env::var("JEAN_FORCE_X11").unwrap_or_else(|_| "0".to_string()) == "1";
        if force_x11 && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
            log::trace!("GDK_BACKEND=x11 (forced by JEAN_FORCE_X11)");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Create the main window programmatically so we can inject
            // an initialization script that runs BEFORE any page JS.
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(Default::default()),
            )
            .initialization_script(
                "Object.defineProperty(window, '__JEAN_CLIENT_MODE__', { value: true, writable: false, configurable: false });"
            )
            .title("Jean Client")
            .inner_size(1000.0, 700.0)
            .min_inner_size(1000.0, 700.0)
            .resizable(true)
            .center()
            .decorations(false)
            .transparent(true)
            .shadow(true);

            // HudWindow effect is macOS-only, conditionally apply to prevent crashes on other platforms
            #[cfg(target_os = "macos")]
            {
                builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
                    effects: vec![tauri::window::Effect::HudWindow],
                    radius: Some(12.0),
                    state: Some(tauri::window::EffectState::Active),
                    color: None,
                });
            }

            let _window = builder.build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_client_config,
            save_client_config,
            send_native_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jean Client");
}

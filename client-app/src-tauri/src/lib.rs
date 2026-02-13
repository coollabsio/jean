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

/// Save the client connection config to disk.
#[tauri::command]
fn save_client_config(app: tauri::AppHandle, config: ClientConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let contents =
        serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Create the main window programmatically so we can inject
            // an initialization script that runs BEFORE any page JS.
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(Default::default()),
            )
            .initialization_script(
                "Object.defineProperty(window, '__JEAN_CLIENT_MODE__', { value: true, writable: false, configurable: false });"
            )
            .title("Jean Client")
            .inner_size(800.0, 600.0)
            .min_inner_size(1000.0, 700.0)
            .resizable(true)
            .center()
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .effects(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::window::Effect::HudWindow],
                radius: Some(12.0),
                state: Some(tauri::window::EffectState::Active),
                color: None,
            })
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_client_config,
            save_client_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jean Client");
}

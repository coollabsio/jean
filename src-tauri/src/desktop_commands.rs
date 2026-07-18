use base64::Engine;
use serde_json::{json, Value};
use std::io::Cursor;
use std::process::Command;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::CoreRuntime;

async fn core_command(runtime: &CoreRuntime, command: &str, args: Value) -> Result<Value, String> {
    jean_core::http_server::dispatch::dispatch_command(&runtime.0, command, args).await
}

fn spawn(command: &str, args: &[String]) -> Result<(), String> {
    Command::new(command)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch {command}: {error}"))
}

fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        spawn("open", &[url])
    }
    #[cfg(target_os = "windows")]
    {
        spawn(
            "cmd",
            &["/c".to_string(), "start".to_string(), String::new(), url],
        )
    }
    #[cfg(target_os = "linux")]
    {
        spawn("xdg-open", &[url])
    }
}

#[tauri::command]
pub async fn set_window_vibrancy(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSColor, NSWindow};
        use tauri::window::Effect;

        if let Some(window) = app.get_webview_window("main") {
            let ns_window = window.ns_window().map_err(|error| error.to_string())?;
            if ns_window.is_null() {
                return Err("ns_window pointer is null".to_string());
            }
            let pointer = ns_window as usize;
            window
                .run_on_main_thread(move || unsafe {
                    let ns_window: &NSWindow = &*(pointer as *const NSWindow);
                    ns_window.setOpaque(!enabled);
                    let color = if enabled {
                        NSColor::clearColor()
                    } else {
                        NSColor::windowBackgroundColor()
                    };
                    ns_window.setBackgroundColor(Some(&color));
                })
                .map_err(|error| error.to_string())?;

            if enabled {
                window
                    .set_effects(tauri::utils::config::WindowEffectsConfig {
                        effects: vec![Effect::Sidebar],
                        radius: Some(12.0),
                        state: Some(tauri::window::EffectState::Active),
                        color: None,
                    })
                    .map_err(|error| error.to_string())?;
            } else {
                window
                    .set_effects(None)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, enabled);
    Ok(())
}

#[tauri::command]
pub async fn send_native_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::platform::notifications::show_notification(&app, title, body)
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut notification = app.notification().builder().title(title);
        if let Some(body) = body {
            notification = notification.body(body);
        }
        notification.show().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn read_clipboard_image(
    runtime: State<'_, CoreRuntime>,
) -> Result<Option<Value>, String> {
    let encoded = tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        let image = match clipboard.get_image() {
            Ok(image) => image,
            Err(arboard::Error::ContentNotAvailable) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if image.width.saturating_mul(image.height) > 50_000_000 {
            return Err(format!(
                "Clipboard image too large: {}x{}",
                image.width, image.height
            ));
        }
        let rgba = image::RgbaImage::from_raw(
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )
        .ok_or_else(|| "Invalid clipboard image data".to_string())?;
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(png.into_inner()),
        ))
    })
    .await
    .map_err(|error| error.to_string())??;

    match encoded {
        Some(data) => core_command(
            &runtime,
            "save_pasted_image",
            json!({ "data": data, "mimeType": "image/png" }),
        )
        .await
        .map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn write_clipboard_text(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        clipboard.set_text(text).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_dropped_image(
    runtime: State<'_, CoreRuntime>,
    source_path: String,
) -> Result<Value, String> {
    jean_core::save_dropped_image_from_path(runtime.0.clone(), source_path).await
}

#[tauri::command]
pub async fn open_file_in_default_app(
    path: String,
    editor: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let editor = editor.unwrap_or_else(|| "zed".to_string());
    let binary = match editor.as_str() {
        "vscode" => "code",
        "cursor" => "cursor",
        "xcode" => "xed",
        "intellij" => "idea",
        _ => "zed",
    };
    let target = match (line, column) {
        (Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(line), None) => format!("{path}:{line}"),
        _ => path,
    };
    spawn(binary, &[target])
}

#[tauri::command]
pub async fn open_worktree_in_finder(worktree_path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        spawn("open", &[worktree_path])
    }
    #[cfg(target_os = "windows")]
    {
        spawn("explorer", &[worktree_path])
    }
    #[cfg(target_os = "linux")]
    {
        spawn("xdg-open", &[worktree_path])
    }
}

#[tauri::command]
pub async fn open_log_directory(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    open_worktree_in_finder(path).await
}

#[tauri::command]
pub async fn open_project_worktrees_folder(
    runtime: State<'_, CoreRuntime>,
    project_id: String,
) -> Result<(), String> {
    let path = jean_core::get_project_worktrees_folder(&runtime.0, &project_id)?;
    open_worktree_in_finder(path.to_string_lossy().into_owned()).await
}

#[tauri::command]
pub async fn open_worktree_in_terminal(
    worktree_path: String,
    terminal: Option<String>,
) -> Result<(), String> {
    let terminal = terminal.unwrap_or_else(|| "terminal".to_string());
    #[cfg(target_os = "macos")]
    {
        let application = match terminal.as_str() {
            "warp" => "Warp",
            "ghostty" => "Ghostty",
            "iterm2" => "iTerm",
            _ => "Terminal",
        };
        spawn(
            "open",
            &["-a".to_string(), application.to_string(), worktree_path],
        )
    }
    #[cfg(target_os = "windows")]
    {
        spawn("wt", &["-d".to_string(), worktree_path])
    }
    #[cfg(target_os = "linux")]
    {
        let binary = if terminal == "ghostty" {
            "ghostty"
        } else {
            "x-terminal-emulator"
        };
        Command::new(binary)
            .current_dir(worktree_path)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn open_worktree_in_editor(
    worktree_path: String,
    editor: Option<String>,
) -> Result<(), String> {
    open_file_in_default_app(worktree_path, editor, None, None).await
}

#[tauri::command]
pub async fn open_project_on_github(
    runtime: State<'_, CoreRuntime>,
    project_id: String,
) -> Result<(), String> {
    open_url(jean_core::get_project_github_url(&runtime.0, &project_id)?)
}

#[tauri::command]
pub async fn open_branch_on_github(
    runtime: State<'_, CoreRuntime>,
    repo_path: String,
    branch: String,
) -> Result<(), String> {
    let url = core_command(
        &runtime,
        "get_github_branch_url",
        json!({ "repoPath": repo_path, "branch": branch }),
    )
    .await?
    .as_str()
    .ok_or_else(|| "Invalid GitHub branch URL".to_string())?
    .to_string();
    open_url(url)
}

#[tauri::command]
pub async fn set_project_avatar(
    app: AppHandle,
    runtime: State<'_, CoreRuntime>,
    project_id: String,
) -> Result<Value, String> {
    let source_path = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
        .set_title("Select Project Avatar")
        .blocking_pick_file()
        .ok_or_else(|| "No file selected".to_string())?
        .into_path()
        .map_err(|error| error.to_string())?;
    jean_core::set_project_avatar_from_path(runtime.0.clone(), project_id, source_path).await
}

#[tauri::command]
pub async fn start_http_server(
    runtime: State<'_, CoreRuntime>,
    port: Option<u16>,
) -> Result<jean_core::http_server::server::ServerStatus, String> {
    jean_core::start_http_server(runtime.0.clone(), port).await
}

#[tauri::command]
pub async fn stop_http_server(runtime: State<'_, CoreRuntime>) -> Result<(), String> {
    jean_core::stop_http_server(runtime.0.clone()).await
}

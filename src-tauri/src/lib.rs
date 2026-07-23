use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

mod browser;
mod desktop_commands;
mod http_server;
mod platform;
mod remote_install;

pub(crate) struct CoreRuntime(pub jean_core::RuntimeContext);

#[tauri::command]
async fn dispatch_core_command(
    runtime: State<'_, CoreRuntime>,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    jean_core::http_server::dispatch::dispatch_command(
        &runtime.0,
        &command,
        args.unwrap_or_else(|| Value::Object(Default::default())),
    )
    .await
}

fn should_run_server() -> bool {
    const SERVER_ARGS: &[&str] = &[
        "--headless",
        "--help",
        "-h",
        "--version",
        "-V",
        "--jean-mcp-stdio",
        "--jean-pi-rpc-host",
        "--jean-grok-acp-host",
        "--jean-kimi-acp-host",
    ];
    std::env::var("JEAN_HEADLESS").is_ok_and(|value| value != "0" && value != "false")
        || std::env::args().any(|argument| SERVER_ARGS.contains(&argument.as_str()))
}

#[cfg(target_os = "macos")]
fn fix_macos_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(shell)
        .args(["-l", "-i", "-c", "/usr/bin/printenv PATH"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .trim()
                .split(':')
                .filter(|entry| !entry.contains("/Volumes/"))
                .collect::<Vec<_>>()
                .join(":");
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn create_app_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_menu = SubmenuBuilder::new(app, "Jean")
        .item(&MenuItemBuilder::with_id("about", "About Jean").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Jean"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Jean"))?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-right-sidebar", "Toggle Right Sidebar").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal")
                .accelerator("CmdOrCtrl+Backquote")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-browser", "Toggle Browser")
                .accelerator("CmdOrCtrl+Shift+Backquote")
                .build(app)?,
        )
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(
            &MenuItemBuilder::with_id("magic-menu", "Magic Menu")
                .accelerator("CmdOrCtrl+M")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("quick-menu", "Quick Menu")
                .accelerator("CmdOrCtrl+Period")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_menu_events(app: &tauri::App) {
    app.on_menu_event(|app, event| {
        let frontend_event = match event.id().as_ref() {
            "about" => Some("menu-about"),
            "check-updates" => Some("menu-check-updates"),
            "preferences" => Some("menu-preferences"),
            "toggle-left-sidebar" => Some("menu-toggle-left-sidebar"),
            "toggle-right-sidebar" => Some("menu-toggle-right-sidebar"),
            "toggle-terminal" => Some("menu-toggle-terminal"),
            "toggle-browser" => Some("menu-toggle-browser"),
            "magic-menu" => Some("menu-magic-menu"),
            "quick-menu" => Some("menu-quick-menu"),
            _ => None,
        };
        if let Some(frontend_event) = frontend_event {
            let _ = app.emit(frontend_event, ());
        }
    });
}

fn initialize_core(app: &mut tauri::App) -> Result<jean_core::RuntimeContext, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let core = jean_core::RuntimeContext::new(app_data_dir, resource_dir)?;
    let event_app = app.handle().clone();
    core.set_event_sink(move |event, payload| {
        let payload: Value = serde_json::from_str(payload)
            .map_err(|error| format!("Invalid core event payload: {error}"))?;
        event_app
            .emit(event, payload)
            .map_err(|error| error.to_string())
    });
    tauri::async_runtime::block_on(async {
        jean_core::async_runtime::set(tokio::runtime::Handle::current());
    });
    jean_core::initialize_runtime(&core)?;
    Ok(core)
}

fn allow_project_assets(app: &AppHandle, core: &jean_core::RuntimeContext) {
    let projects =
        tauri::async_runtime::block_on(jean_core::http_server::dispatch::dispatch_command(
            core,
            "list_projects",
            Value::Object(Default::default()),
        ));
    let Ok(Value::Array(projects)) = projects else {
        return;
    };
    for project in projects {
        for key in ["path", "worktrees_dir"] {
            if let Some(path) = project.get(key).and_then(Value::as_str) {
                let _ = app.asset_protocol_scope().allow_directory(path, true);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let _ = app
            .asset_protocol_scope()
            .allow_directory(home.join("jean"), true);
    }
}

#[cfg(target_os = "linux")]
fn install_linux_file_drop(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let drop_app = app.handle().clone();
    let result = window.with_webview(move |webview| {
        use gtk::prelude::WidgetExt;
        use std::cell::Cell;
        use std::rc::Rc;
        use webkit2gtk::glib;
        use webkit2gtk::glib::object::ObjectExt;

        let webview: webkit2gtk::WebView = webview.inner();
        let is_dropping = Rc::new(Cell::new(false));
        let drop_flag = is_dropping.clone();
        webview.connect_drag_drop(move |webview, context, _x, _y, time| {
            let target = gtk::gdk::Atom::intern("text/uri-list");
            if !context.list_targets().contains(&target) {
                return false;
            }
            drop_flag.set(true);
            webview.drag_get_data(context, &target, time);
            true
        });

        webview.connect_drag_data_received(move |webview, _context, _x, _y, data, _info, _time| {
            use gtk::gdk::prelude::SeatExt;

            if !is_dropping.replace(false) {
                return;
            }
            webview.stop_signal_emission_by_name("drag-data-received");
            let paths: Vec<String> = data
                .uris()
                .iter()
                .filter_map(|uri| glib::filename_from_uri(uri).ok())
                .map(|(path, _)| path.to_string_lossy().into_owned())
                .collect();
            if paths.is_empty() {
                return;
            }
            let (x, y) = webview
                .window()
                .and_then(|window| {
                    webview.display().default_seat().and_then(|seat| {
                        seat.pointer().map(|pointer| {
                            let (_, x, y, _) = window.device_position(&pointer);
                            (x, y)
                        })
                    })
                })
                .unwrap_or((0, 0));
            let _ = drop_app.emit(
                "linux-file-drop",
                serde_json::json!({ "paths": paths, "x": x, "y": y }),
            );
        });
    });
    if let Err(error) = result {
        log::warn!("Failed to install Linux file-drop handler: {error}");
    }
}

fn setup_runtime(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let core = initialize_core(app).map_err(std::io::Error::other)?;
    allow_project_assets(app.handle(), &core);
    app.manage(CoreRuntime(core.clone()));

    let services = core.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = jean_core::start_runtime_services(services).await {
            log::warn!("Failed to start shared runtime services: {error}");
        }
    });

    let http = core.clone();
    let desktop_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let preferences = jean_core::http_server::dispatch::dispatch_command(
            &http,
            "load_preferences",
            Value::Object(Default::default()),
        )
        .await;
        let preferences = preferences.ok();
        let vibrancy = preferences
            .as_ref()
            .and_then(|value| value.get("window_vibrancy").and_then(Value::as_bool))
            .unwrap_or(false);
        if let Err(error) = desktop_commands::set_window_vibrancy(desktop_app, vibrancy).await {
            log::warn!("Failed to apply window vibrancy preference: {error}");
        }
        let should_start = preferences
            .as_ref()
            .and_then(|value| value.get("http_server_auto_start").and_then(Value::as_bool))
            .unwrap_or(false);
        if should_start {
            if let Err(error) = jean_core::start_http_server(http, None).await {
                log::warn!("Failed to auto-start HTTP server: {error}");
            }
        }
    });

    #[cfg(target_os = "linux")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_decorations(false);
        }
        install_linux_file_drop(app);
    }

    #[cfg(target_os = "macos")]
    {
        create_app_menu(app)?;
        install_menu_events(app);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Product version must be the desktop package, not jean-core's library version.
    jean_core::set_app_version(env!("CARGO_PKG_VERSION"));

    if should_run_server() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create Jean server runtime");
        if let Err(error) = runtime.block_on(jean_core::run_server()) {
            eprintln!("Jean server failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    #[cfg(target_os = "macos")]
    fix_macos_path();

    let log_targets = vec![
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .level_for("reqwest", log::LevelFilter::Warn)
                .targets(log_targets)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(setup_runtime)
        .invoke_handler(tauri::generate_handler![
            dispatch_core_command,
            desktop_commands::set_window_vibrancy,
            desktop_commands::send_native_notification,
            desktop_commands::read_clipboard_image,
            desktop_commands::write_clipboard_text,
            desktop_commands::save_dropped_image,
            desktop_commands::open_file_in_default_app,
            desktop_commands::open_worktree_in_finder,
            desktop_commands::open_log_directory,
            desktop_commands::open_project_worktrees_folder,
            desktop_commands::open_worktree_in_terminal,
            desktop_commands::open_worktree_in_editor,
            desktop_commands::open_project_on_github,
            desktop_commands::open_branch_on_github,
            desktop_commands::set_project_avatar,
            desktop_commands::start_http_server,
            desktop_commands::stop_http_server,
            desktop_commands::install_remote_jean_server,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_stop,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_set_focus,
            browser::browser_get_url,
            browser::browser_close,
            browser::browser_report_title,
            browser::browser_enable_grab,
            browser::browser_report_grab_context,
            browser::get_active_browser_tabs,
            browser::has_active_browser_tab,
        ])
        .build(tauri::generate_context!())
        .expect("error building Tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => jean_core::shutdown_runtime(),
            tauri::RunEvent::ExitRequested { api, .. } => {
                if jean_core::has_nonsurvivable_running_sessions() {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    jean_core::shutdown_runtime();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

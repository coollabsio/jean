//! Windows WebView2 stability helpers.
//!
//! Transparent windows + WebView2 process death leave an empty native frame
//! that shows the desktop wallpaper through the app ("Jean went invisible",
//! issue #575). Platform config disables transparency on Windows; this module
//! recovers from WebView2 process failures by reloading or restarting.

/// Classify a WebView2 process-failure kind for recovery decisions.
///
/// Returns `"browser"` when the entire browser process exited (must restart
/// the app), `"reload"` when a renderer/frame failure can try `Reload()`, or
/// `"ignore"` for GPU/utility subprocesses that WebView2 often recovers on
/// its own.
///
/// Used by the Windows `ProcessFailed` handler; also unit-tested on all hosts.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn process_failed_recovery(kind: i32) -> &'static str {
    // Values from COREWEBVIEW2_PROCESS_FAILED_KIND_* (webview2-com-sys).
    match kind {
        0 => "browser", // BROWSER_PROCESS_EXITED
        // RENDER_PROCESS_EXITED / UNRESPONSIVE / FRAME_RENDER_PROCESS_EXITED
        1..=3 => "reload",
        _ => "ignore",
    }
}

/// Install a WebView2 `ProcessFailed` handler on the main webview.
///
/// - Browser-process exit → restart the whole Jean process (the webview is
///   unusable after this; Task Manager shows only the host process).
/// - Render/frame process exit/unresponsive → attempt `Reload()`.
/// - GPU/utility exits → log only; WebView2 usually respawns them.
#[cfg(windows)]
pub fn install_process_failed_recovery(app: &tauri::App) {
    use tauri::Manager;
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
        },
        ProcessFailedEventHandler,
    };

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Windows WebView2 recovery: main window missing");
        return;
    };

    let app_handle = app.handle().clone();
    let result = window.with_webview(move |platform| {
        let controller = platform.controller();
        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(wv) => wv,
            Err(error) => {
                log::warn!("Windows WebView2 recovery: CoreWebView2 failed: {error}");
                return;
            }
        };

        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            // ProcessFailedKind is a COM out-param getter (returns Result<()>).
            let kind = args
                .as_ref()
                .and_then(|args: &ICoreWebView2ProcessFailedEventArgs| {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                    unsafe { args.ProcessFailedKind(&mut kind) }
                        .ok()
                        .map(|_| kind.0)
                })
                .unwrap_or(-1);

            let recovery = process_failed_recovery(kind);
            log::error!("WebView2 ProcessFailed kind={kind} recovery={recovery} (issue #575)");

            match recovery {
                "browser" => {
                    // Browser process is gone — only relaunch restores a live webview.
                    // Clone for the main-thread closure; run_on_main_thread borrows self.
                    let app = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || {
                        log::error!("Restarting Jean after WebView2 browser process exit");
                        app.restart();
                    });
                }
                "reload" => {
                    let reloaded = sender
                        .as_ref()
                        .and_then(|wv| unsafe { wv.Reload() }.ok())
                        .is_some();
                    if !reloaded {
                        log::warn!("WebView2 Reload after process failure failed");
                        let app = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            log::error!("Restarting Jean after failed WebView2 Reload");
                            app.restart();
                        });
                    }
                }
                _ => {}
            }
            Ok(())
        }));

        let mut token = 0i64;
        if let Err(error) = unsafe { webview.add_ProcessFailed(&handler, &mut token) } {
            log::warn!("Windows WebView2 recovery: add_ProcessFailed failed: {error}");
        } else {
            log::info!("Windows WebView2 ProcessFailed recovery installed");
        }
    });

    if let Err(error) = result {
        log::warn!("Windows WebView2 recovery: with_webview failed: {error}");
    }
}

#[cfg(not(windows))]
pub fn install_process_failed_recovery(_app: &tauri::App) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_process_exit_requires_restart() {
        assert_eq!(process_failed_recovery(0), "browser");
    }

    #[test]
    fn render_failures_try_reload() {
        assert_eq!(process_failed_recovery(1), "reload");
        assert_eq!(process_failed_recovery(2), "reload");
        assert_eq!(process_failed_recovery(3), "reload");
    }

    #[test]
    fn gpu_and_utility_are_ignored() {
        assert_eq!(process_failed_recovery(6), "ignore");
        assert_eq!(process_failed_recovery(5), "ignore");
        assert_eq!(process_failed_recovery(9), "ignore");
        assert_eq!(process_failed_recovery(-1), "ignore");
    }
}

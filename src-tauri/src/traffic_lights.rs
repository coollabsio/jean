//! Move the macOS traffic lights with the UI zoom.
//!
//! `webview.setZoom()` scales the web title bar, but AppKit keeps the native
//! window buttons at their default place. Tauri 2.11 has no public runtime
//! setter, so we move the buttons with AppKit directly (same approach as tao's
//! `inset_traffic_lights`). AppKit resets the title bar layout on resize, so
//! `reapply` must run again from the window resize event.

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    use std::sync::{Mutex, OnceLock};

    /// Default AppKit layout, read once before the first change.
    #[derive(Clone, Copy)]
    struct Defaults {
        /// Close button x, in title bar view points.
        x: f64,
        /// Distance from the top of the title bar to the button center.
        center_from_top: f64,
        /// Title bar container height.
        height: f64,
        /// Distance between two button origins.
        spacing: f64,
        /// Width from the close button left edge to the zoom button right edge.
        span: f64,
    }

    static DEFAULTS: OnceLock<Defaults> = OnceLock::new();
    static ZOOM: Mutex<f64> = Mutex::new(1.0);

    /// Must run on the main thread.
    pub fn apply(window: &tauri::Window, zoom: f64) -> Result<f64, String> {
        *ZOOM.lock().map_err(|error| error.to_string())? = zoom;
        layout(window, zoom)
    }

    /// Must run on the main thread.
    pub fn reapply(window: &tauri::Window) {
        let zoom = ZOOM.lock().map(|zoom| *zoom).unwrap_or(1.0);
        if (zoom - 1.0).abs() < 0.001 && DEFAULTS.get().is_none() {
            return;
        }
        if let Err(error) = layout(window, zoom) {
            log::warn!("Failed to reposition traffic lights: {error}");
        }
    }

    /// Returns the button span in points (from close left to zoom right edge).
    fn layout(window: &tauri::Window, zoom: f64) -> Result<f64, String> {
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        if pointer.is_null() {
            return Err("ns_window pointer is null".to_string());
        }
        let ns_window: &NSWindow = unsafe { &*(pointer as *const NSWindow) };
        // In fullscreen AppKit moves the buttons to a separate toolbar window.
        if ns_window
            .styleMask()
            .contains(NSWindowStyleMask::FullScreen)
        {
            return Ok(DEFAULTS.get().map(|d| d.span).unwrap_or(0.0));
        }

        let buttons = [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .map(|kind| ns_window.standardWindowButton(kind));
        let [Some(close), Some(minimize), Some(zoom_button)] = buttons else {
            return Err("standard window buttons not found".to_string());
        };
        let Some(title_bar_view) = (unsafe { close.superview() }) else {
            return Err("title bar view not found".to_string());
        };
        let Some(container) = (unsafe { title_bar_view.superview() }) else {
            return Err("title bar container not found".to_string());
        };

        let button_frame = close.frame();
        let button_height = button_frame.size.height;
        let defaults = *DEFAULTS.get_or_init(|| {
            let view_height = title_bar_view.frame().size.height;
            let center = button_frame.origin.y + button_height / 2.0;
            let zoom_frame = zoom_button.frame();
            Defaults {
                x: button_frame.origin.x,
                center_from_top: if title_bar_view.isFlipped() {
                    center
                } else {
                    view_height - center
                },
                height: container.frame().size.height,
                spacing: minimize.frame().origin.x - button_frame.origin.x,
                span: zoom_frame.origin.x + zoom_frame.size.width - button_frame.origin.x,
            }
        });

        let center_from_top = defaults.center_from_top * zoom;
        let height = (defaults.height * zoom).max(center_from_top + button_height / 2.0);

        let mut container_frame = container.frame();
        container_frame.size.height = height;
        container_frame.origin.y = ns_window.frame().size.height - height;
        container.setFrame(container_frame);

        let mut view_frame = title_bar_view.frame();
        view_frame.origin.y = 0.0;
        view_frame.size.height = height;
        title_bar_view.setFrame(view_frame);

        let center_y = if title_bar_view.isFlipped() {
            center_from_top
        } else {
            height - center_from_top
        };
        for (index, button) in [&close, &minimize, &zoom_button].into_iter().enumerate() {
            let mut origin = button.frame().origin;
            origin.x = defaults.x * zoom + index as f64 * defaults.spacing;
            origin.y = center_y - button_height / 2.0;
            button.setFrameOrigin(origin);
        }

        Ok(defaults.span)
    }
}

/// Moves the traffic lights to match the UI zoom (1.0 = 100%).
/// Returns the button group width in points, or `None` off macOS.
/// Sync command: Tauri runs it on the main thread, which AppKit requires.
#[tauri::command]
pub fn set_traffic_light_zoom(window: tauri::Window, zoom: f64) -> Result<Option<f64>, String> {
    if !zoom.is_finite() || zoom <= 0.0 {
        return Err(format!("invalid zoom: {zoom}"));
    }
    #[cfg(target_os = "macos")]
    return imp::apply(&window, zoom).map(Some);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(None)
    }
}

/// Re-applies the position after AppKit resets the title bar layout.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    if matches!(
        event,
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
    ) {
        imp::reapply(window);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, event);
}

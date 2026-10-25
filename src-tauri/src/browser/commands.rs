use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};

use super::registry::{
    get_all_tab_ids, get_label, has_tab, label_for_tab, register_tab, unregister_tab,
};
use super::types::{
    BrowserClosedEvent, BrowserGrabContext, BrowserGrabContextEvent, BrowserNavEvent,
    BrowserNewWindowEvent, BrowserPageLoadEvent, BrowserTitleEvent,
};
use crate::http_server::EmitExt;

const MAIN_WINDOW: &str = "main";
const REACT_GRAB_GLOBAL_JS: &str = include_str!("react_grab.global.js");
const MAX_NEW_WINDOW_URL_LEN: usize = 16_384;
const MAX_TEXT_LEN: usize = 10_000;
const MAX_HTML_LEN: usize = 80_000;
const MAX_STACK_LEN: usize = 30_000;
const MAX_SMALL_FIELD_LEN: usize = 2_000;

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("\n… truncated …");
            return out;
        }
        out.push(ch);
    }
    out
}

fn clean_optional(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|v| truncate_chars(v.trim(), max_chars))
        .filter(|v| !v.is_empty())
}

/// Where a child-webview new-window request should land inside Jean.
#[derive(Debug, PartialEq, Eq)]
enum NewWindowTarget {
    /// `window.open()` or `about:blank`.
    Blank,
    /// http(s) URL to load in a new tab.
    Url(String),
}

/// `window.open`, `target=_blank`, and middle-click all arrive as the webview
/// new-window request. http(s) opens that URL in a Jean tab. A blank request
/// opens a blank Jean tab. `javascript:`, `file:`, `data:`, `blob:`, and other
/// schemes are dropped, and the caller denies the OS window either way.
fn new_window_target(raw: &str) -> Option<NewWindowTarget> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Some(NewWindowTarget::Blank);
    }
    if raw.len() > MAX_NEW_WINDOW_URL_LEN {
        return None;
    }
    let Ok(url) = Url::parse(raw) else {
        return None;
    };
    match url.scheme() {
        "http" | "https" => Some(NewWindowTarget::Url(url.to_string())),
        "about" if url.path() == "blank" => Some(NewWindowTarget::Blank),
        _ => None,
    }
}

fn new_window_event_url(target: NewWindowTarget) -> String {
    match target {
        NewWindowTarget::Blank => String::new(),
        NewWindowTarget::Url(url) => url,
    }
}

fn emit_browser_new_window(app: &AppHandle, tab_id: &str, target: NewWindowTarget) {
    let _ = app.emit_all(
        "browser:new-window",
        &BrowserNewWindowEvent {
            tab_id: tab_id.to_string(),
            url: new_window_event_url(target),
        },
    );
}

fn sanitize_grab_context(mut context: BrowserGrabContext) -> BrowserGrabContext {
    context.url = truncate_chars(context.url.trim(), MAX_SMALL_FIELD_LEN);
    context.title = truncate_chars(context.title.trim(), MAX_SMALL_FIELD_LEN);
    context.tag_name = truncate_chars(context.tag_name.trim(), 128);
    if context.tag_name.is_empty() {
        context.tag_name = "element".to_string();
    }
    context.component_name = clean_optional(context.component_name, MAX_SMALL_FIELD_LEN);
    context.file_path = clean_optional(context.file_path, MAX_SMALL_FIELD_LEN);
    context.selector = clean_optional(context.selector, MAX_SMALL_FIELD_LEN);
    context.text = clean_optional(context.text, MAX_TEXT_LEN);
    context.html = clean_optional(context.html, MAX_HTML_LEN);
    context.stack_context = clean_optional(context.stack_context, MAX_STACK_LEN);
    context
}

fn browser_grab_inject_script(tab_id: &str, theme: Option<&str>) -> String {
    let tab_id_json = serde_json::to_string(tab_id).unwrap_or_else(|_| "\"\"".to_string());
    let theme = match theme {
        Some("light") => "light",
        _ => "dark",
    };
    let theme_json = serde_json::to_string(theme).unwrap_or_else(|_| "\"dark\"".to_string());
    format!(
        r#"(function() {{
  const JEAN_TAB_ID = {tab_id_json};
  const JEAN_THEME = {theme_json};
  window.__JEAN_REACT_GRAB_THEME__ = JEAN_THEME === 'light' ? 'light' : 'dark';
  if (window.__JEAN_REACT_GRAB_READY__) {{
    const reactGrab = window.__REACT_GRAB_MODULE__;
    try {{ reactGrab?.unregisterPlugin?.('comment'); }} catch (_) {{}}
    try {{ reactGrab?.unregisterPlugin?.('edit'); }} catch (_) {{}}
    try {{ reactGrab?.unregisterPlugin?.('open'); }} catch (_) {{}}
    try {{
      const applyTheme = () => document.querySelectorAll('[data-rg-theme]').forEach(el => {{
        if (el.getAttribute('data-rg-theme') !== window.__JEAN_REACT_GRAB_THEME__) {{
          el.setAttribute('data-rg-theme', window.__JEAN_REACT_GRAB_THEME__);
        }}
      }});
      applyTheme();
      setTimeout(applyTheme, 0);
    }} catch (_) {{}}
    try {{ window.__REACT_GRAB__?.activate?.(); }} catch (_) {{}}
    return;
  }}
  window.__REACT_GRAB_DISABLED__ = true;
  if (!window.__REACT_GRAB_MODULE__) {{
{REACT_GRAB_GLOBAL_JS}
  }}
  const reactGrab = window.__REACT_GRAB_MODULE__;
  function clip(value, max) {{
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${{trimmed.slice(0, max)}}\n… truncated …` : trimmed;
  }}
  function cssEscape(value) {{
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }}
  function selectorFor(element) {{
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (element.id) return `#${{cssEscape(element.id)}}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {{
      let part = current.localName || current.tagName.toLowerCase();
      if (current.classList && current.classList.length > 0) {{
        part += `.${{Array.from(current.classList).slice(0, 3).map(cssEscape).join('.')}}`;
      }}
      const parent = current.parentElement;
      if (parent) {{
        const siblings = Array.from(parent.children).filter(child => child.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${{siblings.indexOf(current) + 1}})`;
      }}
      parts.unshift(part);
      if (parts.length >= 5) break;
      current = parent;
    }}
    return parts.join(' > ');
  }}
  async function contextFor(element, actionContext) {{
    const api = window.__REACT_GRAB__;
    let source = null;
    let stackContext = null;
    try {{ source = await api?.getSource?.(element); }} catch (_) {{}}
    try {{ stackContext = await api?.getStackContext?.(element); }} catch (_) {{}}
    return {{
      url: String(location.href || ''),
      title: String(document.title || ''),
      tagName: actionContext?.tagName || element?.tagName?.toLowerCase?.() || 'element',
      componentName: actionContext?.componentName || source?.componentName || null,
      filePath: actionContext?.filePath || source?.filePath || null,
      lineNumber: actionContext?.lineNumber || source?.lineNumber || null,
      selector: selectorFor(element),
      text: clip(element?.innerText || element?.textContent || '', 10000),
      html: clip(element?.outerHTML || '', 80000),
      stackContext: clip(stackContext || '', 30000),
    }};
  }}
  async function sendToJean(actionContext) {{
    const element = actionContext?.element || actionContext?.elements?.[0] || window.__REACT_GRAB__?.getState?.().targetElement;
    if (!element) return false;
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    const context = await contextFor(element, actionContext);
    await internals.invoke('browser_report_grab_context', {{ tabId: JEAN_TAB_ID, context }});
    return true;
  }}
  const api = reactGrab?.getGlobalApi?.() || reactGrab?.init?.({{
    telemetry: false,
    activationMode: 'toggle',
    freezeReactUpdates: false,
  }});
  if (api && reactGrab?.setGlobalApi) reactGrab.setGlobalApi(api);
  function applyJeanTheme() {{
    try {{
      const theme = window.__JEAN_REACT_GRAB_THEME__ === 'light' ? 'light' : 'dark';
      document.querySelectorAll('[data-rg-theme]').forEach(el => {{
        if (el.getAttribute('data-rg-theme') !== theme) el.setAttribute('data-rg-theme', theme);
      }});
    }} catch (_) {{}}
  }}
  try {{ reactGrab?.unregisterPlugin?.('comment'); }} catch (_) {{}}
  try {{ reactGrab?.unregisterPlugin?.('edit'); }} catch (_) {{}}
  try {{ reactGrab?.unregisterPlugin?.('open'); }} catch (_) {{}}
  try {{ reactGrab?.unregisterPlugin?.('jean-chat'); }} catch (_) {{}}
  reactGrab?.registerPlugin?.({{
    name: 'jean-chat',
    actions: [{{
      id: 'send-to-jean-chat',
      label: 'Send to Jean Chat',
      shortcut: 'J',
      showInToolbarMenu: true,
      onAction: async (context) => {{
        if (context?.performWithFeedback) {{
          await context.performWithFeedback(() => sendToJean(context));
        }} else {{
          await sendToJean(context);
        }}
        context?.hideContextMenu?.();
      }},
    }}],
    hooks: {{
      onCopySuccess: async (elements) => {{
        if (elements && elements[0]) await sendToJean({{ element: elements[0], elements }});
      }},
    }},
  }});
  window.__JEAN_REACT_GRAB_READY__ = true;
  applyJeanTheme();
  try {{
    window.__JEAN_REACT_GRAB_THEME_OBSERVER__?.disconnect?.();
    const themeObserver = new MutationObserver(applyJeanTheme);
    themeObserver.observe(document.documentElement, {{
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-rg-theme'],
    }});
    window.__JEAN_REACT_GRAB_THEME_OBSERVER__ = themeObserver;
  }} catch (_) {{}}
  try {{ api?.setToolbarState?.({{ enabled: true, collapsed: false, defaultAction: 'send-to-jean-chat' }}); }} catch (_) {{}}
  try {{ api?.activate?.(); }} catch (_) {{}}
}})();"#
    )
}

/// JS injected after every page load. Reports title changes back to Rust via
/// the `browser_report_title` command. Tauri v2 has no first-class title-change
/// event for child webviews.
fn title_observer_script(tab_id: &str) -> String {
    let escaped = tab_id.replace('\\', "\\\\").replace('\'', "\\'");
    format!(
        r#"(function() {{
            const tabId = '{escaped}';
            const internals = window.__TAURI_INTERNALS__;
            if (!internals || !internals.invoke) return;
            const report = () => {{
                try {{ internals.invoke('browser_report_title', {{ tabId, title: document.title || '' }}); }}
                catch (_) {{}}
            }};
            report();
            try {{
                const target = document.querySelector('title') || document.head;
                if (target && window.MutationObserver) {{
                    const obs = new MutationObserver(report);
                    obs.observe(target, {{ subtree: true, characterData: true, childList: true }});
                }}
            }} catch (_) {{}}
        }})();"#
    )
}

/// Create a new browser tab as a child Webview of the main window.
#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    log::trace!("browser_create tab_id={tab_id} url={url}");

    if has_tab(&tab_id) {
        return Err(format!("Browser tab '{tab_id}' already exists"));
    }

    let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let label = label_for_tab(&tab_id);

    let main = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;

    let app_for_load = app.clone();
    let tab_for_load = tab_id.clone();
    let app_for_window = app.clone();
    let tab_for_window = tab_id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .on_new_window(move |url, _features| {
            // Deny always: `NewWindowResponse::Create` would open a separate
            // Tauri window. The pane adds a sibling tab from this event.
            log::trace!(
                "browser new-window tab_id={tab_for_window} url={}",
                url.as_str()
            );
            if let Some(target) = new_window_target(url.as_str()) {
                emit_browser_new_window(&app_for_window, &tab_for_window, target);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let url_str = payload.url().to_string();
            let event_name = match payload.event() {
                PageLoadEvent::Started => "browser:loading",
                PageLoadEvent::Finished => "browser:loaded",
            };
            let _ = app_for_load.emit_all(
                event_name,
                &BrowserPageLoadEvent {
                    tab_id: tab_for_load.clone(),
                    url: url_str.clone(),
                },
            );
            let _ = app_for_load.emit_all(
                "browser:nav",
                &BrowserNavEvent {
                    tab_id: tab_for_load.clone(),
                    url: url_str,
                },
            );
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.eval(title_observer_script(&tab_for_load));
            }
        });

    // Frontend sends PHYSICAL pixels (CSS px × devicePixelRatio).
    // Use PhysicalPosition/PhysicalSize so Tauri stores them as-is — bypassing
    // its scale_factor() conversion, which can disagree with WKWebView's real
    // devicePixelRatio under fractional macOS display scaling.
    main.add_child(
        builder,
        PhysicalPosition::new(x as i32, y as i32),
        PhysicalSize::new((width.max(1.0)) as u32, (height.max(1.0)) as u32),
    )
    .map_err(|e| format!("failed to add child webview: {e}"))?;

    register_tab(tab_id, label.clone());
    Ok(label)
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .eval("history.back()".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .eval("history.forward()".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .eval("location.reload()".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_stop(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .eval("window.stop()".to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    // Frontend sends PHYSICAL pixels — see browser_create for rationale.
    webview
        .set_position(PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(PhysicalSize::new(
            (width.max(1.0)) as u32,
            (height.max(1.0)) as u32,
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn browser_set_focus(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_get_url(app: AppHandle, tab_id: String) -> Result<String, String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .url()
        .map(|u| u.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    log::trace!("browser_close tab_id={tab_id}");
    if let Some(label) = unregister_tab(&tab_id) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    let _ = app.emit_all("browser:closed", &BrowserClosedEvent { tab_id });
    Ok(())
}

#[tauri::command]
pub async fn get_active_browser_tabs() -> Vec<String> {
    get_all_tab_ids()
}

#[tauri::command]
pub async fn has_active_browser_tab(tab_id: String) -> bool {
    has_tab(&tab_id)
}

/// Called by an injected MutationObserver every time the page <title> changes.
#[tauri::command]
pub async fn browser_report_title(
    app: AppHandle,
    tab_id: String,
    title: String,
) -> Result<(), String> {
    app.emit_all("browser:title", &BrowserTitleEvent { tab_id, title })
}

#[tauri::command]
pub async fn browser_enable_grab(
    app: AppHandle,
    tab_id: String,
    theme: Option<String>,
) -> Result<(), String> {
    let label = get_label(&tab_id).ok_or_else(|| format!("tab '{tab_id}' not found"))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    webview
        .eval(browser_grab_inject_script(&tab_id, theme.as_deref()))
        .map_err(|e| format!("failed to inject React Grab: {e}"))
}

#[tauri::command]
pub async fn browser_report_grab_context(
    app: AppHandle,
    tab_id: String,
    context: BrowserGrabContext,
) -> Result<(), String> {
    if !has_tab(&tab_id) {
        return Err(format!("tab '{tab_id}' not found"));
    }
    app.emit_all(
        "browser:grab-context",
        &BrowserGrabContextEvent {
            tab_id,
            context: sanitize_grab_context(context),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_grab_context_truncates_large_fields_and_defaults_tag() {
        let context = sanitize_grab_context(BrowserGrabContext {
            url: " https://example.com ".to_string(),
            title: " Example ".to_string(),
            tag_name: "   ".to_string(),
            component_name: Some(" Button ".to_string()),
            file_path: None,
            line_number: Some(42),
            selector: Some("   ".to_string()),
            text: Some("x".repeat(MAX_TEXT_LEN + 10)),
            html: Some("h".repeat(MAX_HTML_LEN + 10)),
            stack_context: Some("s".repeat(MAX_STACK_LEN + 10)),
        });

        assert_eq!(context.url, "https://example.com");
        assert_eq!(context.title, "Example");
        assert_eq!(context.tag_name, "element");
        assert_eq!(context.component_name.as_deref(), Some("Button"));
        assert_eq!(context.selector, None);
        assert!(context.text.unwrap().ends_with("… truncated …"));
        assert!(context.html.unwrap().ends_with("… truncated …"));
        assert!(context.stack_context.unwrap().ends_with("… truncated …"));
    }

    #[test]
    fn browser_grab_inject_script_embeds_local_react_grab_and_tab_id() {
        let script = browser_grab_inject_script("tab-'quoted", Some("dark"));

        assert!(script.contains("react-grab@0.1.47"));
        assert!(script.contains("browser_report_grab_context"));
        assert!(script.contains("Send to Jean Chat"));
        assert!(script.contains("__REACT_GRAB_MODULE__"));
        assert!(script.contains("const reactGrab = window.__REACT_GRAB_MODULE__"));
        assert!(script.contains("unregisterPlugin?.('comment')"));
        assert!(script.contains("unregisterPlugin?.('edit')"));
        assert!(script.contains("unregisterPlugin?.('open')"));
        assert!(script.contains("data-rg-theme"));
        assert!(script.contains("const JEAN_THEME = \"dark\""));
        assert!(script.contains(r#""tab-'quoted""#));
        assert!(!script.contains("https://cdn"));
        assert!(!script.contains("unpkg.com"));
        assert!(!script.contains("jsdelivr"));
    }

    #[test]
    fn new_window_target_opens_http_and_blank_tabs_only() {
        assert_eq!(
            new_window_target("https://example.com/a?b=1#c"),
            Some(NewWindowTarget::Url(
                "https://example.com/a?b=1#c".to_string()
            ))
        );
        assert_eq!(
            new_window_target("  http://localhost:3000/x "),
            Some(NewWindowTarget::Url("http://localhost:3000/x".to_string()))
        );
        assert_eq!(
            new_window_target("https://user:pass@example.com/a"),
            Some(NewWindowTarget::Url(
                "https://user:pass@example.com/a".to_string()
            ))
        );
        assert_eq!(new_window_target(""), Some(NewWindowTarget::Blank));
        assert_eq!(new_window_target("   "), Some(NewWindowTarget::Blank));
        assert_eq!(
            new_window_target("about:blank"),
            Some(NewWindowTarget::Blank)
        );
        assert_eq!(
            new_window_target("about:blank#ignored"),
            Some(NewWindowTarget::Blank)
        );

        assert_eq!(new_window_target("javascript:alert(1)"), None);
        assert_eq!(new_window_target("file:///etc/passwd"), None);
        assert_eq!(new_window_target("data:text/html,hi"), None);
        assert_eq!(new_window_target("blob:https://example.com/uuid"), None);
        assert_eq!(new_window_target("mailto:dev@example.com"), None);
        assert_eq!(new_window_target("not a url"), None);
        assert_eq!(
            new_window_target(&format!(
                "https://example.com/{}",
                "a".repeat(MAX_NEW_WINDOW_URL_LEN)
            )),
            None
        );
    }

    #[test]
    fn new_window_event_serializes_camel_case() {
        let json = serde_json::to_value(BrowserNewWindowEvent {
            tab_id: "tab-1".to_string(),
            url: "https://example.com/docs".to_string(),
        })
        .unwrap();

        assert_eq!(json["tabId"], "tab-1");
        assert_eq!(json["url"], "https://example.com/docs");
        assert_eq!(new_window_event_url(NewWindowTarget::Blank), "");
    }
}

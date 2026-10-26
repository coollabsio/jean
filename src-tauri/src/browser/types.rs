use serde::{Deserialize, Serialize};

/// Event payload for page load events (started/finished)
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageLoadEvent {
    pub tab_id: String,
    pub url: String,
}

/// Event payload for navigation state change (after navigate/back/forward/load)
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavEvent {
    pub tab_id: String,
    pub url: String,
}

/// Event payload for title change
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTitleEvent {
    pub tab_id: String,
    pub title: String,
}

/// Event payload for tab close
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedEvent {
    pub tab_id: String,
}

/// `window.open` / `target=_blank` should become a tab in the source pane.
///
/// `url` is an http(s) address. An empty string asks the pane for a blank tab
/// (`window.open()` / `about:blank`).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewWindowEvent {
    pub tab_id: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabContext {
    pub url: String,
    pub title: String,
    pub tag_name: String,
    pub component_name: Option<String>,
    pub file_path: Option<String>,
    pub line_number: Option<u32>,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub stack_context: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabContextEvent {
    pub tab_id: String,
    pub context: BrowserGrabContext,
}

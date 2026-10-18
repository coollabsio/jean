use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixStoppedEvent {
    pub project_id: String,
    pub project_name: String,
    pub backend: String,
    pub error: String,
}

/// In-memory Mr. Robot runtime status for one project (resets on restart).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixStatus {
    pub last_scan_at: Option<u64>,
    pub next_scan_at: Option<u64>,
    pub rate_limited_until: Option<u64>,
    pub last_error: Option<AutoFixStatusError>,
    pub failed_issues: Vec<AutoFixFailedIssue>,
    pub starting_issues: Vec<u32>,
    pub pending_yolo_sessions: usize,
    pub scanning: bool,
    pub active_now: bool,
    pub last_scan_summary: Option<String>,
    pub activity: Vec<AutoFixActivity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixStatusError {
    pub message: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixFailedIssue {
    pub issue_number: u32,
    pub attempts: u32,
    pub error: String,
    pub failed_at: u64,
    pub gave_up: bool,
}

#[derive(Debug, Clone)]
pub struct AutoFixIssueCandidate {
    pub number: u32,
    pub labels: Vec<String>,
}

/// Bounded runtime history. Like scan status, this resets on restart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixActivity {
    pub at: u64,
    pub message: String,
    pub issue_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixIssuePreview {
    pub issue_number: u32,
    pub labels: Vec<String>,
    pub reason: String,
    pub selected: bool,
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixStoppedEvent {
    pub project_id: String,
    pub project_name: String,
    pub backend: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct AutoFixIssueCandidate {
    pub number: u32,
    pub labels: Vec<String>,
}

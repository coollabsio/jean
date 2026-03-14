use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct RtkGainSnapshot {
    pub summary: RtkGainSummary,
    #[serde(default)]
    pub daily: Vec<RtkPeriodStat>,
    #[serde(default)]
    pub weekly: Vec<RtkPeriodStat>,
    #[serde(default)]
    pub monthly: Vec<RtkPeriodStat>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct RtkGainSummary {
    pub total_commands: usize,
    pub total_input: usize,
    pub total_output: usize,
    pub total_saved: usize,
    pub avg_savings_pct: f64,
    pub total_time_ms: u64,
    pub avg_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct RtkPeriodStat {
    pub label: String,
    pub commands: usize,
    pub input: usize,
    pub output: usize,
    pub saved: usize,
    pub savings_pct: f64,
    pub time_ms: u64,
}

#[derive(Debug, Deserialize)]
struct RtkGainResponse {
    summary: RtkGainSummary,
    #[serde(default)]
    daily: Vec<RtkPeriodStat>,
    #[serde(default)]
    weekly: Vec<RtkPeriodStat>,
    #[serde(default)]
    monthly: Vec<RtkPeriodStat>,
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn parse_rtk_gain_output(stdout: &str, fetched_at: u64) -> Result<RtkGainSnapshot, String> {
    let parsed: RtkGainResponse = serde_json::from_str(stdout).map_err(|error| {
        let snippet = stdout.chars().take(200).collect::<String>();
        format!("Failed to parse RTK gain JSON: {error}. Body starts with: {snippet}")
    })?;

    Ok(RtkGainSnapshot {
        summary: parsed.summary,
        daily: parsed.daily,
        weekly: parsed.weekly,
        monthly: parsed.monthly,
        fetched_at,
    })
}

fn ensure_rtk_enabled(preferences: &crate::AppPreferences) -> Result<(), String> {
    if preferences.rtk_ai_enabled {
        Ok(())
    } else {
        Err("RTK AI is disabled in Experimental settings.".to_string())
    }
}

#[tauri::command]
pub async fn get_rtk_gain(app: AppHandle) -> Result<RtkGainSnapshot, String> {
    let preferences = crate::load_preferences(app)
        .await
        .map_err(|error| format!("Failed to load preferences: {error}"))?;
    ensure_rtk_enabled(&preferences)?;

    let output = crate::platform::silent_command("rtk")
        .args(["gain", "--all", "--format", "json"])
        .output()
        .map_err(|error| format!("Failed to execute RTK: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("RTK gain command failed with status {}.", output.status)
        } else {
            format!("RTK gain command failed: {stderr}")
        });
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("RTK gain output was not valid UTF-8: {error}"))?;

    parse_rtk_gain_output(&stdout, now_unix_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rtk_gain_output_maps_summary_and_periods() {
        let stdout = r#"{
          "summary": {
            "total_commands": 42,
            "total_input": 12000,
            "total_output": 3000,
            "total_saved": 9000,
            "avg_savings_pct": 75.5,
            "total_time_ms": 123456,
            "avg_time_ms": 2939
          },
          "daily": [
            {
              "label": "2026-03-14",
              "commands": 10,
              "input": 5000,
              "output": 1000,
              "saved": 4000,
              "savings_pct": 80.0,
              "time_ms": 25000
            }
          ],
          "weekly": [],
          "monthly": [
            {
              "label": "2026-03",
              "commands": 42,
              "input": 12000,
              "output": 3000,
              "saved": 9000,
              "savings_pct": 75.5,
              "time_ms": 123456
            }
          ]
        }"#;

        let snapshot = parse_rtk_gain_output(stdout, 123).expect("RTK JSON should parse");

        assert_eq!(snapshot.summary.total_commands, 42);
        assert_eq!(snapshot.summary.total_saved, 9000);
        assert_eq!(snapshot.daily.len(), 1);
        assert_eq!(snapshot.daily[0].label, "2026-03-14");
        assert_eq!(snapshot.monthly.len(), 1);
        assert_eq!(snapshot.fetched_at, 123);
    }

    #[test]
    fn parse_rtk_gain_output_rejects_invalid_json() {
        let error = parse_rtk_gain_output("not-json", 123).expect_err("invalid JSON should fail");
        assert!(error.contains("Failed to parse RTK gain JSON"));
    }

    #[test]
    fn ensure_rtk_enabled_rejects_disabled_preference() {
        let prefs = crate::AppPreferences::default();
        let error =
            ensure_rtk_enabled(&prefs).expect_err("disabled RTK preference should be rejected");
        assert_eq!(error, "RTK AI is disabled in Experimental settings.");
    }
}

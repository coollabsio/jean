use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
    daily: Vec<RtkPeriodStatRaw>,
    #[serde(default)]
    weekly: Vec<RtkPeriodStatRaw>,
    #[serde(default)]
    monthly: Vec<RtkPeriodStatRaw>,
}

#[derive(Debug, Deserialize)]
struct RtkPeriodStatRaw {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    week_start: Option<String>,
    #[serde(default)]
    week_end: Option<String>,
    #[serde(default)]
    month: Option<String>,
    commands: usize,
    #[serde(default)]
    input: Option<usize>,
    #[serde(default)]
    input_tokens: Option<usize>,
    #[serde(default)]
    output: Option<usize>,
    #[serde(default)]
    output_tokens: Option<usize>,
    #[serde(default)]
    saved: Option<usize>,
    #[serde(default)]
    saved_tokens: Option<usize>,
    savings_pct: f64,
    #[serde(default)]
    time_ms: Option<u64>,
    #[serde(default)]
    total_time_ms: Option<u64>,
}

impl RtkPeriodStatRaw {
    fn into_period(self) -> RtkPeriodStat {
        let label = self
            .label
            .or(self.date)
            .or_else(|| {
                self.week_start.as_ref().map(|start| {
                    if let Some(end) = self.week_end.as_ref() {
                        format!("{} - {}", start, end)
                    } else {
                        start.clone()
                    }
                })
            })
            .or(self.month)
            .unwrap_or_else(|| "unknown".to_string());

        RtkPeriodStat {
            label,
            commands: self.commands,
            input: self.input.or(self.input_tokens).unwrap_or(0),
            output: self.output.or(self.output_tokens).unwrap_or(0),
            saved: self.saved.or(self.saved_tokens).unwrap_or(0),
            savings_pct: self.savings_pct,
            time_ms: self.time_ms.or(self.total_time_ms).unwrap_or(0),
        }
    }
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
        daily: parsed
            .daily
            .into_iter()
            .map(RtkPeriodStatRaw::into_period)
            .collect(),
        weekly: parsed
            .weekly
            .into_iter()
            .map(RtkPeriodStatRaw::into_period)
            .collect(),
        monthly: parsed
            .monthly
            .into_iter()
            .map(RtkPeriodStatRaw::into_period)
            .collect(),
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

fn path_candidates_for_binary(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(name));
            #[cfg(windows)]
            candidates.push(dir.join(format!("{name}.exe")));
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(name));
        candidates.push(home.join(".cargo").join("bin").join(name));
        #[cfg(windows)]
        {
            candidates.push(home.join(".local").join("bin").join(format!("{name}.exe")));
            candidates.push(home.join(".cargo").join("bin").join(format!("{name}.exe")));
        }
    }

    candidates
}

fn is_usable_binary(path: &Path) -> bool {
    path.exists() && path.is_file()
}

pub fn resolve_rtk_binary() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("RTK_BIN") {
        let explicit_path = PathBuf::from(explicit);
        if is_usable_binary(&explicit_path) {
            return Ok(explicit_path);
        }
        return Err(format!(
            "RTK_BIN is set but points to a missing file: {}",
            explicit_path.display()
        ));
    }

    for candidate in path_candidates_for_binary("rtk") {
        if is_usable_binary(&candidate) {
            return Ok(candidate);
        }
    }

    let path = std::env::var("PATH").unwrap_or_default();
    Err(format!(
        "RTK binary not found. Ensure `rtk` is installed and available to Jean. PATH={path}"
    ))
}

pub fn silent_rtk_command() -> Result<std::process::Command, String> {
    let binary = resolve_rtk_binary()?;
    Ok(crate::platform::silent_command(binary))
}

#[tauri::command]
pub async fn get_rtk_gain(app: AppHandle) -> Result<RtkGainSnapshot, String> {
    let preferences = crate::load_preferences(app)
        .await
        .map_err(|error| format!("Failed to load preferences: {error}"))?;
    ensure_rtk_enabled(&preferences)?;

    let output = silent_rtk_command()?
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
    fn parse_rtk_gain_output_accepts_token_key_variants() {
        let stdout = r#"{
          "summary": {
            "total_commands": 2,
            "total_input": 688,
            "total_output": 203,
            "total_saved": 485,
            "avg_savings_pct": 70.4,
            "total_time_ms": 25,
            "avg_time_ms": 12
          },
          "daily": [
            {
              "date": "2026-03-16",
              "commands": 2,
              "input_tokens": 688,
              "output_tokens": 203,
              "saved_tokens": 485,
              "savings_pct": 70.4,
              "total_time_ms": 25
            }
          ],
          "weekly": [
            {
              "week_start": "2026-03-16",
              "week_end": "2026-03-22",
              "commands": 2,
              "input_tokens": 688,
              "output_tokens": 203,
              "saved_tokens": 485,
              "savings_pct": 70.4,
              "avg_time_ms": 12,
              "total_time_ms": 25
            }
          ],
          "monthly": [
            {
              "month": "2026-03",
              "commands": 2,
              "input_tokens": 688,
              "output_tokens": 203,
              "saved_tokens": 485,
              "savings_pct": 70.4,
              "total_time_ms": 25
            }
          ]
        }"#;

        let snapshot = parse_rtk_gain_output(stdout, 456).expect("RTK JSON should parse");

        assert_eq!(snapshot.daily[0].label, "2026-03-16");
        assert_eq!(snapshot.daily[0].saved, 485);
        assert_eq!(snapshot.weekly[0].label, "2026-03-16 - 2026-03-22");
        assert_eq!(snapshot.monthly[0].label, "2026-03");
        assert_eq!(snapshot.fetched_at, 456);
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

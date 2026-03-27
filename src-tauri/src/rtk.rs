use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
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

#[derive(Debug, serde::Deserialize)]
struct RtkGainResponse {
    summary: RtkGainSummary,
    #[serde(default)]
    daily: Vec<RtkPeriodStatRaw>,
    #[serde(default)]
    weekly: Vec<RtkPeriodStatRaw>,
    #[serde(default)]
    monthly: Vec<RtkPeriodStatRaw>,
}

#[derive(Debug, serde::Deserialize)]
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

fn run_init_command(args: &[&str]) {
    let mut command = match silent_rtk_command() {
        Ok(command) => command,
        Err(error) => {
            log::warn!("RTK initialization skipped: {error}");
            return;
        }
    };

    match command.args(args).output() {
        Ok(output) if output.status.success() => {
            log::info!("RTK initialized successfully: rtk {}", args.join(" "));
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.is_empty() {
                log::warn!(
                    "RTK initialization failed (status={}): rtk {}",
                    output.status,
                    args.join(" ")
                );
            } else {
                log::warn!(
                    "RTK initialization failed (status={}): rtk {} ({stderr})",
                    output.status,
                    args.join(" ")
                );
            }
        }
        Err(error) => {
            log::warn!(
                "RTK initialization command failed to start: rtk {} ({error})",
                args.join(" ")
            );
        }
    }
}

pub fn initialize_rtk_integration() {
    for args in [
        ["init", "-g", "--auto-patch"].as_slice(),
        ["init", "-g", "--opencode"].as_slice(),
        ["init", "-g", "--codex"].as_slice(),
    ] {
        run_init_command(args);
    }
}

pub fn uninstall_rtk_integration() {
    for args in [
        ["init", "-g", "--uninstall"].as_slice(),
        ["init", "-g", "--codex", "--uninstall"].as_slice(),
    ] {
        run_init_command(args);
    }
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

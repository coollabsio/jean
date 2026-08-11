//! Dispatch-facing Hermes commands: install, gateway lifecycle, status, jobs.

use super::client::HermesClient;
use super::config::{
    binary_exists, clear_jean_install_marker, connection_config_from_prefs,
    find_system_hermes_binary, hermes_env_path, hermes_home_dir, mark_jean_installed,
    patch_hermes_preferences, resolve_cli_binary, selected_model_from_prefs, was_jean_installed,
    INSTALL_SCRIPT_URL,
};
use super::gateway::{
    ensure_api_server_config, ensure_gateway_always_on, ensure_gateway_running,
    gateway_status_text, install_gateway_service, start_gateway, stop_gateway,
    uninstall_gateway_service,
};
use super::types::{
    jean_hermes_model_id, requires_cli_create, HermesCliStatus, HermesConnectionStatus,
    HermesCreateJobRequest, HermesGatewayStatus, HermesInstallCommand, HermesJob, HermesModelInfo,
    HermesUpdateJobRequest,
};
use crate::platform::silent_command;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "hermes-cli:progress",
        serde_json::json!({
            "stage": stage,
            "message": message,
            "percent": percent,
        }),
    );
}

fn parse_version(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    text.lines()
        .flat_map(|line| line.split_whitespace())
        .find(|part| {
            let trimmed = part.trim_start_matches('v');
            trimmed.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        })
        .map(|part| part.trim_start_matches('v').to_string())
}

pub async fn check_hermes_cli_installed(app: AppHandle) -> Result<HermesCliStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(HermesCliStatus {
            installed: false,
            version: None,
            path: None,
            jean_managed: was_jean_installed(&app),
        });
    }
    let version = silent_command(&binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|output| parse_version(&output.stdout).or_else(|| parse_version(&output.stderr)));
    Ok(HermesCliStatus {
        installed: true,
        version,
        path: Some(binary.to_string_lossy().to_string()),
        jean_managed: was_jean_installed(&app),
    })
}

pub async fn detect_hermes_in_path(app: AppHandle) -> Result<HermesCliStatus, String> {
    let Some(binary) = find_system_hermes_binary(&app) else {
        return Ok(HermesCliStatus {
            installed: false,
            version: None,
            path: None,
            jean_managed: false,
        });
    };
    let version = silent_command(&binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|output| parse_version(&output.stdout).or_else(|| parse_version(&output.stderr)));
    Ok(HermesCliStatus {
        installed: true,
        version,
        path: Some(binary.to_string_lossy().to_string()),
        jean_managed: was_jean_installed(&app),
    })
}

/// Auth for Hermes — same idea as PI:
/// user logs in / configures a provider via Hermes CLI or gateway
/// (`hermes model` / `hermes setup`); Hermes owns Claude/Codex/xAI import
/// and OAuth. Jean only detects Hermes-side credentials for UI readiness.
pub async fn check_hermes_cli_auth(app: AppHandle) -> Result<HermesAuthStatus, String> {
    let cli = check_hermes_cli_installed(app.clone()).await?;
    if !cli.installed {
        return Ok(HermesAuthStatus {
            authenticated: false,
            error: Some(
                "Hermes CLI is not installed. Install it in Settings, then run `hermes model` to log in."
                    .into(),
            ),
            gateway_running: false,
        });
    }

    let creds = hermes_credentials_configured();
    let status = check_hermes_status(app).await?;
    let authenticated = creds || status.api_authenticated;
    let error = if authenticated {
        None
    } else {
        Some(
            status
                .error
                .unwrap_or_else(|| {
                    "Not authenticated. Run `hermes model` (or `hermes setup --portal`) in a terminal to log in with your subscription / API key, then refresh models."
                        .into()
                })
        )
    };
    Ok(HermesAuthStatus {
        authenticated,
        error,
        gateway_running: status.api_reachable,
    })
}

/// True when Hermes has provider credentials on disk (auth.json or .env keys).
fn hermes_credentials_configured() -> bool {
    if hermes_auth_json_has_providers() {
        return true;
    }
    hermes_env_has_provider_keys()
}

fn hermes_auth_json_has_providers() -> bool {
    let path = hermes_home_dir().join("auth.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    value
        .get("providers")
        .and_then(|p| p.as_object())
        .is_some_and(|map| !map.is_empty())
}

fn hermes_env_has_provider_keys() -> bool {
    let path = hermes_env_path();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    const KEYS: &[&str] = &[
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_TOKEN",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "FIREWORKS_API_KEY",
        "DEEPSEEK_API_KEY",
        "KIMI_API_KEY",
        "MINIMAX_API_KEY",
        "NOVITA_API_KEY",
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "HF_TOKEN",
        "DASHSCOPE_API_KEY",
        "NVIDIA_API_KEY",
    ];
    raw.lines().any(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        KEYS.iter().any(|key| {
            line.starts_with(&format!("{key}="))
                && line
                    .split_once('=')
                    .map(|(_, v)| {
                        let v = v.trim().trim_matches('"').trim_matches('\'');
                        v.len() > 4
                            && !matches!(
                                v.to_ascii_lowercase().as_str(),
                                "changeme"
                                    | "your_api_key"
                                    | "your-api-key"
                                    | "placeholder"
                                    | "dummy"
                                    | "none"
                                    | "null"
                            )
                    })
                    .unwrap_or(false)
        })
    })
}

/// List models for authenticated Hermes providers (PI-style picker feed).
pub async fn list_hermes_models(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<HermesModelInfo>, String> {
    // Prefer live inventory from the gateway API (mirrors Hermes TUI picker).
    let _ = ensure_gateway_running(&app).await;
    if let Ok(client) = client_from_app(&app) {
        if let Ok(payload) = client.model_options(refresh.unwrap_or(false)).await {
            let models = parse_model_options_payload(&payload);
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }
    // Fallback: at least the stable alias so the UI is never empty.
    Ok(vec![HermesModelInfo {
        id: "hermes-agent".into(),
        label: "Hermes Agent (gateway default)".into(),
        provider: String::new(),
        model: "hermes-agent".into(),
        is_default: true,
    }])
}

fn parse_model_options_payload(payload: &Value) -> Vec<HermesModelInfo> {
    let current_provider = payload
        .get("provider")
        .or_else(|| payload.get("current_provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let current_model = payload
        .get("model")
        .or_else(|| payload.get("current_model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let providers = payload
        .get("providers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for row in providers {
        let slug = row
            .get("slug")
            .or_else(|| row.get("id"))
            .or_else(|| row.get("provider"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if slug.is_empty() {
            continue;
        }
        let name = row
            .get("name")
            .or_else(|| row.get("label"))
            .and_then(|v| v.as_str())
            .unwrap_or(&slug)
            .to_string();
        let models = row.get("models").cloned().unwrap_or(Value::Null);
        let model_ids = extract_model_ids(&models);
        for model_id in model_ids {
            if model_id.is_empty() {
                continue;
            }
            let is_default = (!current_provider.is_empty()
                && current_provider.eq_ignore_ascii_case(&slug)
                && current_model == model_id)
                || (current_provider.is_empty() && out.is_empty());
            out.push(HermesModelInfo {
                id: jean_hermes_model_id(&slug, &model_id),
                label: format!("{model_id} ({name})"),
                provider: slug.clone(),
                model: model_id,
                is_default,
            });
        }
    }

    // Ensure exactly one default when possible.
    if !out.is_empty() && !out.iter().any(|m| m.is_default) {
        out[0].is_default = true;
    }
    out
}

fn extract_model_ids(models: &Value) -> Vec<String> {
    match models {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                if let Some(s) = item.as_str() {
                    return Some(s.to_string());
                }
                item.get("id")
                    .or_else(|| item.get("model"))
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect(),
        Value::Object(map) => map.keys().cloned().collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    pub gateway_running: bool,
}

pub async fn check_hermes_status(app: AppHandle) -> Result<HermesConnectionStatus, String> {
    let cli = check_hermes_cli_installed(app.clone()).await?;
    let config = connection_config_from_prefs(&app);
    let base_url = config.base_url.clone();
    let profile = config.profile.clone();
    let client = match HermesClient::new(config) {
        Ok(c) => c,
        Err(error) => {
            return Ok(HermesConnectionStatus {
                cli,
                api_reachable: false,
                api_authenticated: false,
                base_url,
                profile,
                model: None,
                error: Some(error),
                capabilities: None,
                gateway: None,
            });
        }
    };

    let health = client.health().await;
    let api_reachable = health.is_ok();
    if !api_reachable {
        return Ok(HermesConnectionStatus {
            cli,
            api_reachable: false,
            api_authenticated: false,
            base_url,
            profile,
            model: Some(selected_model_from_prefs(&app)),
            error: health.err(),
            capabilities: None,
            gateway: Some(HermesGatewayStatus {
                service_text: gateway_status_text(&app),
                running: false,
            }),
        });
    }

    match client.capabilities().await {
        Ok(capabilities) => {
            let model = capabilities
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| Some(selected_model_from_prefs(&app)));
            Ok(HermesConnectionStatus {
                cli,
                api_reachable: true,
                api_authenticated: true,
                base_url,
                profile,
                model,
                error: None,
                capabilities: Some(capabilities),
                gateway: Some(HermesGatewayStatus {
                    service_text: gateway_status_text(&app),
                    running: true,
                }),
            })
        }
        Err(error) => Ok(HermesConnectionStatus {
            cli,
            api_reachable: true,
            api_authenticated: false,
            base_url,
            profile,
            model: Some(selected_model_from_prefs(&app)),
            error: Some(error),
            capabilities: None,
            gateway: Some(HermesGatewayStatus {
                service_text: gateway_status_text(&app),
                running: true,
            }),
        }),
    }
}

pub async fn get_hermes_install_command(_app: AppHandle) -> Result<HermesInstallCommand, String> {
    Ok(HermesInstallCommand {
        command: "curl".into(),
        args: vec![
            "-fsSL".into(),
            INSTALL_SCRIPT_URL.into(),
            "|".into(),
            "bash".into(),
            "-s".into(),
            "--".into(),
            "--skip-setup".into(),
            "--non-interactive".into(),
        ],
        description: "Install Hermes Agent via the official installer, then enable the gateway service so cron runs without Jean.".into(),
    })
}

pub async fn install_hermes_cli(app: AppHandle, _version: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return Err(
            "Use PowerShell: iex (irm https://hermes-agent.nousresearch.com/install.ps1). \
             Then run `hermes gateway install` so cron survives Jean quit."
                .to_string(),
        );
    }

    emit_progress(
        &app,
        "starting",
        "Preparing Hermes Agent installation...",
        0,
    );
    emit_progress(
        &app,
        "downloading",
        "Running official Hermes installer (this may take a few minutes)...",
        15,
    );

    let script =
        format!("curl -fsSL {INSTALL_SCRIPT_URL} | bash -s -- --skip-setup --non-interactive");
    let output = tokio::task::spawn_blocking(move || {
        silent_command("bash")
            .arg("-lc")
            .arg(&script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    .map_err(|e| format!("Install join error: {e}"))?
    .map_err(|e| format!("Failed to run Hermes installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Hermes installer failed: {}",
            if !stderr.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            }
        ));
    }

    emit_progress(&app, "verifying", "Verifying hermes binary...", 70);
    // Give PATH / symlink a moment on some systems.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        // Try common location explicitly.
        let home_bin = dirs::home_dir()
            .map(|h| h.join(".local/bin/hermes"))
            .filter(|p| p.exists());
        if home_bin.is_none() {
            return Err(
                "Hermes installer finished but `hermes` was not found on PATH. \
                 Reload your shell or ensure ~/.local/bin is on PATH."
                    .into(),
            );
        }
    }

    mark_jean_installed(&app)?;
    let _ = patch_hermes_preferences(&app, None, Some("path"));

    emit_progress(
        &app,
        "gateway",
        "Enabling API server and starting gateway service so cron can run...",
        85,
    );
    // Cron + messaging require Hermes always on — install user service and wait healthy.
    ensure_gateway_always_on(&app).await.map_err(|e| {
        format!(
            "Hermes CLI installed, but the gateway did not start: {e}. \
             Cron jobs will not run until the gateway is up. \
             Try Settings → Hermes Agent → Start gateway, or `hermes gateway install`."
        )
    })?;

    emit_progress(
        &app,
        "complete",
        "Hermes Agent installed; gateway is running for cron.",
        100,
    );
    Ok(())
}

pub async fn uninstall_hermes_cli(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "stopping", "Stopping Hermes gateway service...", 20);
    let app_clone = app.clone();
    let _ = tokio::task::spawn_blocking(move || uninstall_gateway_service(&app_clone))
        .await
        .map_err(|e| format!("Uninstall join error: {e}"))?;

    clear_jean_install_marker(&app);
    // Jean does not delete the full ~/.hermes install (user data/cron/skills).
    // Point users at hermes uninstall if they want a full wipe.
    emit_progress(
        &app,
        "complete",
        "Gateway service removed. Run `hermes uninstall` to remove Hermes itself.",
        100,
    );
    Ok(())
}

pub async fn update_hermes_cli(app: AppHandle) -> Result<(), String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Err("Hermes CLI not installed".into());
    }
    emit_progress(&app, "updating", "Running hermes update...", 30);
    let binary_clone = binary.clone();
    let output = tokio::task::spawn_blocking(move || {
        silent_command(&binary_clone)
            .arg("update")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    .map_err(|e| format!("Update join error: {e}"))?
    .map_err(|e| format!("Failed to run hermes update: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "hermes update failed: {}",
            if !stderr.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            }
        ));
    }

    emit_progress(
        &app,
        "gateway",
        "Ensuring gateway service is running for cron...",
        80,
    );
    // Best-effort always-on after update; do not fail the whole update if health lags.
    if let Err(e) = ensure_gateway_always_on(&app).await {
        log::warn!("Hermes update: gateway always-on failed: {e}");
        let msg = format!("Hermes updated, but gateway may need a manual start: {e}");
        emit_progress(&app, "complete", &msg, 100);
        return Ok(());
    }
    emit_progress(
        &app,
        "complete",
        "Hermes updated; gateway is running for cron.",
        100,
    );
    Ok(())
}

pub async fn start_hermes_gateway(app: AppHandle) -> Result<HermesConnectionStatus, String> {
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        ensure_api_server_config(&app_clone)?;
        // Prefer full service install so cron survives Jean quit.
        if install_gateway_service(&app_clone).is_err() {
            start_gateway(&app_clone)?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Start join error: {e}"))??;

    ensure_gateway_running(&app).await?;
    check_hermes_status(app).await
}

pub async fn stop_hermes_gateway(app: AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || stop_gateway(&app_clone))
        .await
        .map_err(|e| format!("Stop join error: {e}"))?
}

pub async fn ensure_hermes_gateway(app: AppHandle) -> Result<HermesConnectionStatus, String> {
    ensure_gateway_running(&app).await?;
    check_hermes_status(app).await
}

fn client_from_app(app: &AppHandle) -> Result<HermesClient, String> {
    HermesClient::new(connection_config_from_prefs(app))
}

pub async fn list_hermes_jobs(
    app: AppHandle,
    include_disabled: Option<bool>,
    project_id: Option<String>,
    worktree_id: Option<String>,
) -> Result<Vec<HermesJob>, String> {
    let _ = ensure_gateway_running(&app).await;
    let mut jobs = client_from_app(&app)?
        .list_jobs(include_disabled.unwrap_or(false))
        .await?;
    super::job_index::enrich_jobs(&app, &mut jobs);
    if let Some(pid) = project_id.filter(|s| !s.is_empty()) {
        jobs.retain(|j| j.project_id.as_deref() == Some(pid.as_str()));
    }
    if let Some(wid) = worktree_id.filter(|s| !s.is_empty()) {
        jobs.retain(|j| j.worktree_id.as_deref() == Some(wid.as_str()));
    }
    Ok(jobs)
}

pub async fn get_hermes_job(app: AppHandle, job_id: String) -> Result<HermesJob, String> {
    let _ = ensure_gateway_running(&app).await;
    let mut job = client_from_app(&app)?.get_job(&job_id).await?;
    let mut jobs = vec![job];
    super::job_index::enrich_jobs(&app, &mut jobs);
    job = jobs
        .into_iter()
        .next()
        .ok_or_else(|| "Job missing after enrich".to_string())?;
    Ok(job)
}

pub async fn create_hermes_job(
    app: AppHandle,
    request: HermesCreateJobRequest,
) -> Result<HermesJob, String> {
    if request.name.trim().is_empty() {
        return Err("Job name is required".to_string());
    }
    if request.schedule.trim().is_empty() {
        return Err("Job schedule is required".to_string());
    }
    // Cron is owned by Hermes: install/start the always-on gateway service first.
    ensure_gateway_always_on(&app).await?;

    let project_id = request.project_id.clone();
    let worktree_id = request.worktree_id.clone();
    let worktree_path = request.workdir.clone();

    let mut job = if requires_cli_create(&request) {
        create_job_via_cli(&app, &request).await?
    } else {
        client_from_app(&app)?.create_job_api(&request).await?
    };

    if !job.id.is_empty() {
        let link = super::job_index::link_from_create_request(
            &app,
            &job.id,
            project_id,
            worktree_id,
            worktree_path.or_else(|| job.workdir.clone()),
            None,
        );
        let _ = super::job_index::upsert_job_link(&app, link);
        let mut jobs = vec![job];
        super::job_index::enrich_jobs(&app, &mut jobs);
        job = jobs
            .into_iter()
            .next()
            .ok_or_else(|| "Job missing after create".to_string())?;
    }
    Ok(job)
}

/// Create a Hermes cron job bound to a Jean worktree (`workdir` + Jean index).
pub async fn create_hermes_job_from_worktree(
    app: AppHandle,
    worktree_id: String,
    name: String,
    schedule: String,
    prompt: String,
    deliver: Option<String>,
    skills: Option<Vec<String>>,
    model: Option<String>,
    provider: Option<String>,
) -> Result<HermesJob, String> {
    let worktree = crate::projects::get_worktree(app.clone(), worktree_id.clone()).await?;
    let request = HermesCreateJobRequest {
        name: if name.trim().is_empty() {
            format!("jean-{}", worktree.name)
        } else {
            name
        },
        schedule,
        prompt,
        deliver: Some(deliver.unwrap_or_else(|| "local".into())),
        skills,
        repeat: None,
        workdir: Some(worktree.path.clone()),
        model,
        provider,
        script: None,
        no_agent: None,
        enabled_toolsets: None,
        context_from: None,
        worktree_id: Some(worktree.id.clone()),
        project_id: Some(worktree.project_id.clone()),
    };
    create_hermes_job(app, request).await
}

pub async fn get_hermes_job_output(
    app: AppHandle,
    job_id: String,
) -> Result<super::job_index::HermesJobOutput, String> {
    let _ = app; // index lives under app data; output under Hermes home
    super::job_index::read_latest_job_output(&job_id)
}

pub async fn list_hermes_job_links(
    app: AppHandle,
) -> Result<Vec<super::job_index::HermesJobLink>, String> {
    Ok(super::job_index::list_job_links(&app))
}

pub async fn update_hermes_job(
    app: AppHandle,
    job_id: String,
    request: HermesUpdateJobRequest,
) -> Result<HermesJob, String> {
    let _ = ensure_gateway_running(&app).await;
    client_from_app(&app)?.update_job(&job_id, &request).await
}

pub async fn delete_hermes_job(app: AppHandle, job_id: String) -> Result<(), String> {
    let _ = ensure_gateway_running(&app).await;
    client_from_app(&app)?.delete_job(&job_id).await?;
    let _ = super::job_index::remove_job_link(&app, &job_id);
    Ok(())
}

pub async fn pause_hermes_job(app: AppHandle, job_id: String) -> Result<HermesJob, String> {
    let _ = ensure_gateway_running(&app).await;
    client_from_app(&app)?.pause_job(&job_id).await
}

pub async fn resume_hermes_job(app: AppHandle, job_id: String) -> Result<HermesJob, String> {
    // Resuming a schedule requires the always-on gateway, same as create.
    ensure_gateway_always_on(&app).await?;
    client_from_app(&app)?.resume_job(&job_id).await
}

pub async fn run_hermes_job(app: AppHandle, job_id: String) -> Result<Value, String> {
    let _ = ensure_gateway_running(&app).await;
    client_from_app(&app)?.run_job(&job_id).await
}

async fn create_job_via_cli(
    app: &AppHandle,
    request: &HermesCreateJobRequest,
) -> Result<HermesJob, String> {
    let binary = resolve_cli_binary(app);
    if !binary_exists(&binary) {
        return Err(
            "Hermes CLI not found on PATH. Install Hermes or create jobs without workdir via the API."
                .to_string(),
        );
    }

    let config = connection_config_from_prefs(app);
    let mut args: Vec<String> = Vec::new();
    if !config.profile.trim().is_empty() && config.profile.trim() != "default" {
        args.push("-p".into());
        args.push(config.profile.trim().to_string());
    }
    args.push("cron".into());
    args.push("create".into());
    args.push(request.schedule.clone());
    args.push(request.prompt.clone());
    args.push("--name".into());
    args.push(request.name.clone());
    let deliver = request
        .deliver
        .clone()
        .unwrap_or_else(|| "local".to_string());
    args.push("--deliver".into());
    args.push(deliver);

    if let Some(skills) = &request.skills {
        for skill in skills {
            if !skill.trim().is_empty() {
                args.push("--skill".into());
                args.push(skill.clone());
            }
        }
    }
    if let Some(repeat) = request.repeat {
        args.push("--repeat".into());
        args.push(repeat.to_string());
    }
    if let Some(workdir) = &request.workdir {
        if !workdir.trim().is_empty() {
            args.push("--workdir".into());
            args.push(workdir.clone());
        }
    }
    if let Some(model) = &request.model {
        if !model.trim().is_empty() {
            args.push("--model".into());
            args.push(model.clone());
        }
    }
    if let Some(provider) = &request.provider {
        if !provider.trim().is_empty() {
            args.push("--provider".into());
            args.push(provider.clone());
        }
    }
    if let Some(script) = &request.script {
        if !script.trim().is_empty() {
            args.push("--script".into());
            args.push(script.clone());
        }
    }
    if request.no_agent == Some(true) {
        args.push("--no-agent".into());
    }

    let output = tokio::task::spawn_blocking({
        let binary = binary.clone();
        let args = args.clone();
        move || {
            silent_command(&binary)
                .args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
        }
    })
    .await
    .map_err(|e| format!("Hermes CLI join error: {e}"))?
    .map_err(|e| format!("Failed to run hermes cron create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "hermes cron create failed: {}",
            if !stderr.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            }
        ));
    }

    tokio::time::sleep(Duration::from_millis(150)).await;
    if let Ok(client) = client_from_app(app) {
        if let Ok(jobs) = client.list_jobs(true).await {
            if let Some(job) = jobs.into_iter().find(|j| j.name == request.name) {
                return Ok(job);
            }
        }
    }

    Ok(HermesJob {
        id: String::new(),
        name: request.name.clone(),
        prompt: request.prompt.clone(),
        schedule_display: Some(request.schedule.clone()),
        enabled: true,
        state: Some("scheduled".into()),
        deliver: request.deliver.clone().or_else(|| Some("local".into())),
        skills: request.skills.clone().unwrap_or_default(),
        workdir: request.workdir.clone(),
        model: request.model.clone(),
        provider: request.provider.clone(),
        next_run_at: None,
        last_run_at: None,
        last_status: None,
        last_error: None,
        no_agent: request.no_agent.unwrap_or(false),
        raw: None,
        project_id: request.project_id.clone(),
        worktree_id: request.worktree_id.clone(),
        worktree_path: request.workdir.clone(),
        session_id: None,
        profile: None,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parse_version_finds_semver_token() {
        assert_eq!(
            parse_version(b"hermes-agent 1.2.3\n"),
            Some("1.2.3".to_string())
        );
        assert_eq!(parse_version(b"v0.9.1"), Some("0.9.1".to_string()));
    }
}

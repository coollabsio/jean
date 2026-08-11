//! Hermes gateway lifecycle: API server env + user service install so cron
//! keeps running without Jean.

use super::client::HermesClient;
use super::config::{
    binary_exists, connection_config_from_prefs, hermes_env_path, hermes_home_dir,
    is_loopback_base_url, patch_hermes_preferences, resolve_cli_binary,
};
use super::types::HermesConnectionConfig;
use crate::platform::silent_command;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

const GATEWAY_HEALTH_ATTEMPTS: u32 = 30;
const GATEWAY_HEALTH_DELAY_MS: u64 = 500;

/// Ensure `~/.hermes/.env` enables the API server and has a bearer key.
/// Returns the API key that Jean should store.
pub fn ensure_api_server_config(app: &AppHandle) -> Result<String, String> {
    let env_path = hermes_env_path();
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Hermes home: {e}"))?;
    }

    let existing = if env_path.exists() {
        std::fs::read_to_string(&env_path).unwrap_or_default()
    } else {
        String::new()
    };

    let mut lines: Vec<String> = existing.lines().map(|l| l.to_string()).collect();
    let key = env_value(&existing, "API_SERVER_KEY")
        .or_else(|| connection_config_from_prefs(app).api_key)
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| format!("jean-{}", uuid::Uuid::new_v4().simple()));

    set_env_line(&mut lines, "API_SERVER_ENABLED", "true");
    set_env_line(&mut lines, "API_SERVER_KEY", &key);
    set_env_line(&mut lines, "API_SERVER_HOST", "127.0.0.1");
    set_env_line(&mut lines, "API_SERVER_PORT", "8642");

    let content = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    std::fs::write(&env_path, content)
        .map_err(|e| format!("Failed to write {}: {e}", env_path.display()))?;

    // Keep Jean prefs in sync so HTTP client can authenticate.
    patch_hermes_preferences(app, Some(key.clone()), None)?;
    Ok(key)
}

fn env_value(contents: &str, key: &str) -> Option<String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn set_env_line(lines: &mut Vec<String>, key: &str, value: &str) {
    let prefix = format!("{key}=");
    if let Some(idx) = lines.iter().position(|l| {
        let t = l.trim();
        !t.starts_with('#') && t.starts_with(&prefix)
    }) {
        lines[idx] = format!("{key}={value}");
    } else {
        lines.push(format!("{key}={value}"));
    }
}

fn hermes_cmd(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let binary = resolve_cli_binary(app);
    if !binary_exists(&binary) {
        return Err(
            "Hermes CLI not found. Install Hermes first (Settings → Hermes Agent).".to_string(),
        );
    }
    Ok(binary)
}

fn profile_args(app: &AppHandle) -> Vec<String> {
    let profile = connection_config_from_prefs(app).profile;
    let profile = profile.trim();
    if profile.is_empty() || profile == "default" {
        Vec::new()
    } else {
        vec!["-p".into(), profile.to_string()]
    }
}

fn run_hermes(
    app: &AppHandle,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(bool, String, String), String> {
    let binary = hermes_cmd(app)?;
    let mut full_args: Vec<String> = profile_args(app);
    full_args.extend(args.iter().map(|s| (*s).to_string()));

    let output = silent_command(&binary)
        .args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("HERMES_HOME", hermes_home_dir())
        .output();

    // Note: std::process::Command has no built-in timeout on all platforms here;
    // gateway install is expected to return. Spawn_blocking used by callers for async.
    let _ = timeout_secs;
    let output = output.map_err(|e| format!("Failed to run hermes {}: {e}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((output.status.success(), stdout, stderr))
}

/// Install Hermes gateway as a user service and start it now.
/// Non-interactive: survives Jean quit so cron keeps firing.
pub fn install_gateway_service(app: &AppHandle) -> Result<(), String> {
    // Ensure API server is enabled before the service starts.
    ensure_api_server_config(app)?;

    // --start-now / --start-on-login when available; non-interactive defaults also start.
    let attempts: &[&[&str]] = &[
        &[
            "gateway",
            "install",
            "--force",
            "--start-now",
            "--start-on-login",
        ],
        &["gateway", "install", "--force"],
        &["gateway", "install"],
    ];

    let mut last_err = String::new();
    for args in attempts {
        match run_hermes(app, args, 120) {
            Ok((true, stdout, stderr)) => {
                log::info!(
                    "Hermes gateway install ok: {} {}",
                    stdout.chars().take(200).collect::<String>(),
                    stderr.chars().take(200).collect::<String>()
                );
                // Best-effort start in case install didn't.
                let _ = run_hermes(app, &["gateway", "start"], 60);
                return Ok(());
            }
            Ok((false, stdout, stderr)) => {
                last_err = if !stderr.is_empty() { stderr } else { stdout };
                // Continue trying simpler flags
            }
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "Failed to install Hermes gateway service: {last_err}. \
         You can run `hermes gateway install` manually so cron survives Jean quit."
    ))
}

pub fn start_gateway(app: &AppHandle) -> Result<(), String> {
    ensure_api_server_config(app)?;
    // Prefer service start; fall back to detached gateway run.
    if let Ok((true, _, _)) = run_hermes(app, &["gateway", "start"], 60) {
        return Ok(());
    }
    // Detached foreground fallback (less ideal for cron, but unblocks chat).
    let binary = hermes_cmd(app)?;
    let mut args = profile_args(app);
    args.extend(["gateway".into(), "run".into()]);
    let mut cmd = silent_command(&binary);
    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .env("HERMES_HOME", hermes_home_dir());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: detach from Jean process group so gateway outlives Jean when possible.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to spawn hermes gateway: {e}"))?;
    Ok(())
}

pub fn stop_gateway(app: &AppHandle) -> Result<(), String> {
    let (ok, stdout, stderr) = run_hermes(app, &["gateway", "stop"], 60)?;
    if ok {
        Ok(())
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

pub fn uninstall_gateway_service(app: &AppHandle) -> Result<(), String> {
    let _ = run_hermes(app, &["gateway", "stop"], 30);
    let (ok, stdout, stderr) = run_hermes(app, &["gateway", "uninstall"], 60)?;
    if ok {
        Ok(())
    } else {
        // Not fatal if never installed as a service.
        log::warn!(
            "hermes gateway uninstall: {}",
            if !stderr.is_empty() { stderr } else { stdout }
        );
        Ok(())
    }
}

pub fn gateway_status_text(app: &AppHandle) -> String {
    match run_hermes(app, &["gateway", "status"], 15) {
        Ok((_, stdout, stderr)) => {
            if !stdout.is_empty() {
                stdout
            } else {
                stderr
            }
        }
        Err(e) => e,
    }
}

/// Ensure local gateway is healthy when base URL is loopback.
///
/// Starts a service/process only if health fails. Prefer
/// [`ensure_gateway_always_on`] when creating cron jobs so the gateway is
/// installed as a user service and keeps running without Jean.
pub async fn ensure_gateway_running(app: &AppHandle) -> Result<(), String> {
    let config = connection_config_from_prefs(app);
    if !is_loopback_base_url(&config.base_url) {
        // Remote gateway: Jean never starts it.
        return wait_for_health(&config, 3).await;
    }

    if wait_for_health(&config, 1).await.is_ok() {
        return Ok(());
    }

    // Configure API + start service/process.
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        ensure_api_server_config(&app_clone)?;
        start_gateway(&app_clone)
    })
    .await
    .map_err(|e| format!("Gateway start join error: {e}"))??;

    // Refresh config after key may have been written.
    let config = connection_config_from_prefs(app);
    wait_for_health(&config, GATEWAY_HEALTH_ATTEMPTS).await
}

/// Ensure Hermes stays up for cron: install the user service when possible.
///
/// Cron jobs are owned by the Hermes gateway, not Jean. A detached `gateway run`
/// child is not enough — the service must survive Jean quit and reboots (when
/// Hermes supports login start). Remote base URLs are health-checked only.
pub async fn ensure_gateway_always_on(app: &AppHandle) -> Result<(), String> {
    let config = connection_config_from_prefs(app);
    if !is_loopback_base_url(&config.base_url) {
        return wait_for_health(&config, 5).await.map_err(|e| {
            format!(
                "{e} Cron requires a running Hermes gateway. Point Jean at a \
                 remote host that keeps `hermes gateway` installed as a service."
            )
        });
    }

    let already_healthy = wait_for_health(&config, 1).await.is_ok();

    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        ensure_api_server_config(&app_clone)?;
        // Prefer user service so cron outlives Jean (and survives Jean quit).
        match install_gateway_service(&app_clone) {
            Ok(()) => Ok(()),
            Err(install_err) => {
                if already_healthy {
                    // API is up (maybe already service-managed); don't fail job create.
                    log::warn!(
                        "Hermes gateway service install failed while healthy ({install_err}); \
                         leaving existing process running"
                    );
                    return Ok(());
                }
                log::warn!(
                    "Hermes gateway service install failed ({install_err}); falling back to start"
                );
                start_gateway(&app_clone).map_err(|start_err| {
                    format!(
                        "Could not install or start Hermes gateway for cron. \
                         Install error: {install_err}. Start error: {start_err}. \
                         Run `hermes gateway install` so scheduled jobs keep firing."
                    )
                })
            }
        }
    })
    .await
    .map_err(|e| format!("Gateway always-on join error: {e}"))??;

    if already_healthy {
        return Ok(());
    }

    let config = connection_config_from_prefs(app);
    wait_for_health(&config, GATEWAY_HEALTH_ATTEMPTS)
        .await
        .map_err(|e| {
            format!(
                "{e} Cron jobs need the Hermes gateway always running. \
                 Try Settings → Hermes Agent → Start gateway, or `hermes gateway install`."
            )
        })
}

async fn wait_for_health(config: &HermesConnectionConfig, attempts: u32) -> Result<(), String> {
    let mut last = "gateway not responding".to_string();
    for _ in 0..attempts {
        match HermesClient::new(config.clone()) {
            Ok(client) => match client.health().await {
                Ok(_) => return Ok(()),
                Err(e) => last = e,
            },
            Err(e) => last = e,
        }
        tokio::time::sleep(Duration::from_millis(GATEWAY_HEALTH_DELAY_MS)).await;
    }
    Err(format!(
        "Hermes gateway did not become healthy: {last}. \
         Ensure the gateway is installed (`hermes gateway install`) and API_SERVER_ENABLED=true."
    ))
}

pub fn hermes_home_exists() -> bool {
    Path::new(&hermes_home_dir()).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_env_line_updates_and_appends() {
        let mut lines = vec!["FOO=1".into(), "API_SERVER_ENABLED=false".into()];
        set_env_line(&mut lines, "API_SERVER_ENABLED", "true");
        set_env_line(&mut lines, "API_SERVER_KEY", "secret");
        assert!(lines.iter().any(|l| l == "API_SERVER_ENABLED=true"));
        assert!(lines.iter().any(|l| l == "API_SERVER_KEY=secret"));
        assert_eq!(
            lines
                .iter()
                .filter(|l| l.starts_with("API_SERVER_ENABLED"))
                .count(),
            1
        );
    }

    #[test]
    fn env_value_reads_key() {
        let contents = "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=abc123\n";
        assert_eq!(
            env_value(contents, "API_SERVER_KEY").as_deref(),
            Some("abc123")
        );
    }
}

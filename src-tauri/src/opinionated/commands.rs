use crate::platform::silent_command;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct PluginStatus {
    pub installed: bool,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn check_opinionated_plugin_status(plugin_name: String) -> Result<PluginStatus, String> {
    match plugin_name.as_str() {
        "rtk" => check_rtk_status().await,
        "caveman" => check_caveman_status().await,
        _ => Err(format!("Unknown plugin: {plugin_name}")),
    }
}

#[tauri::command]
pub async fn install_opinionated_plugin(
    app: AppHandle,
    plugin_name: String,
) -> Result<String, String> {
    match plugin_name.as_str() {
        "rtk" => install_rtk().await,
        "caveman" => install_caveman(&app).await,
        _ => Err(format!("Unknown plugin: {plugin_name}")),
    }
}

async fn check_rtk_status() -> Result<PluginStatus, String> {
    let result = tokio::task::spawn_blocking(|| silent_command("rtk").arg("--version").output())
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let version = extract_version(&stdout);
            Ok(PluginStatus {
                installed: true,
                version,
            })
        }
        _ => Ok(PluginStatus {
            installed: false,
            version: None,
        }),
    }
}

async fn check_caveman_status() -> Result<PluginStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;

    let found = tokio::task::spawn_blocking(move || {
        let plugins_cache = home.join(".claude").join("plugins").join("cache");
        if plugins_cache.exists() {
            if let Ok(entries) = std::fs::read_dir(&plugins_cache) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains("caveman") {
                        return true;
                    }
                }
            }
        }

        let skills_dir = home.join(".claude").join("skills");
        if skills_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&skills_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains("caveman") && entry.path().join("SKILL.md").exists() {
                        return true;
                    }
                }
            }
        }

        false
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(PluginStatus {
        installed: found,
        version: None,
    })
}

async fn install_rtk() -> Result<String, String> {
    // Try brew first on macOS
    let brew_result = tokio::task::spawn_blocking(|| {
        silent_command("brew")
            .args(["install", "rtk-ai/tap/rtk"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?;

    let install_ok = match brew_result {
        Ok(output) if output.status.success() => true,
        _ => {
            // Fallback to curl installer
            let curl_result = tokio::task::spawn_blocking(|| {
                silent_command("sh")
                    .args([
                        "-c",
                        "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
                    ])
                    .output()
            })
            .await
            .map_err(|e| e.to_string())?;

            match curl_result {
                Ok(output) if output.status.success() => true,
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("RTK installation failed: {stderr}"));
                }
                Err(e) => return Err(format!("Failed to run installer: {e}")),
            }
        }
    };

    if install_ok {
        // Run post-install setup
        let init_result =
            tokio::task::spawn_blocking(|| silent_command("rtk").args(["init", "-g"]).output())
                .await
                .map_err(|e| e.to_string())?;

        match init_result {
            Ok(output) if output.status.success() => {
                Ok("RTK installed and initialized successfully".to_string())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Ok(format!("RTK installed but init had warnings: {stderr}"))
            }
            Err(e) => Ok(format!("RTK installed but init failed: {e}")),
        }
    } else {
        Err("RTK installation failed".to_string())
    }
}

async fn install_caveman(app: &AppHandle) -> Result<String, String> {
    let binary_path = crate::claude_cli::resolve_cli_binary(app);

    if !binary_path.exists() {
        return Err("Claude CLI must be installed first to install Caveman".to_string());
    }

    let bin = binary_path.clone();
    let add_result = tokio::task::spawn_blocking(move || {
        silent_command(&bin)
            .args(["plugin", "marketplace", "add", "JuliusBrussee/caveman"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?;

    match add_result {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to add Caveman from marketplace: {stderr}"));
        }
        Err(e) => return Err(format!("Failed to run Claude CLI: {e}")),
        _ => {}
    }

    let bin = binary_path;
    let install_result = tokio::task::spawn_blocking(move || {
        silent_command(&bin)
            .args(["plugin", "install", "caveman@caveman"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?;

    match install_result {
        Ok(output) if output.status.success() => Ok("Caveman installed successfully".to_string()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Failed to install Caveman skill: {stderr}"))
        }
        Err(e) => Err(format!("Failed to run Claude CLI: {e}")),
    }
}

fn extract_version(s: &str) -> Option<String> {
    let re = regex::Regex::new(r"(\d+\.\d+(?:\.\d+)?)").ok()?;
    re.find(s).map(|m| m.as_str().to_string())
}

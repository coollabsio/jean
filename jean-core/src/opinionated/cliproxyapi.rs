//! Jean no longer integrates CLIProxyAPI: routing Claude/Codex subscription
//! OAuth through a third-party proxy risks account bans. This retires what an
//! earlier Jean version set up, including its install folder (OAuth logins).

use crate::platform::{is_process_alive, kill_process_tree};
use crate::{AppHandle, AppPreferences};
use std::path::Path;

const PROFILE_NAME: &str = "CLIProxyAPI";

/// Stop the old sidecar, delete its install folder, and drop the Jean-created
/// `CLIProxyAPI` providers.
/// Safe to run on every startup; it does nothing once retired.
pub(crate) async fn retire_on_startup(app: &AppHandle) {
    if let Some(dir) = dirs::home_dir()
        .map(|home| home.join(".jean/opinionated/cliproxyapi"))
        .filter(|dir| dir.is_dir())
    {
        stop_sidecar(&dir.join("cliproxyapi.pid"));
        remove_install_dir(&dir);
    }
    if let Ok(path) = crate::get_cli_profile_path(PROFILE_NAME) {
        if path.exists() {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!("Failed to delete {}: {error}", path.display());
            }
        }
    }
    if let Err(error) = detach_saved_profiles(app).await {
        log::warn!("Failed to remove CLIProxyAPI providers: {error}");
    }
}

async fn detach_saved_profiles(app: &AppHandle) -> Result<(), String> {
    let mut preferences = crate::load_preferences(app.clone()).await?;
    // PI reads providers from its own models.json, which Jean also wrote.
    if preferences
        .custom_pi_providers
        .iter()
        .any(|provider| provider.name == PROFILE_NAME)
    {
        if let Err(error) = crate::pi_cli::delete_pi_provider(PROFILE_NAME.to_string()).await {
            log::warn!("Failed to remove CLIProxyAPI from PI models.json: {error}");
        }
    }
    if detach_profiles(&mut preferences) {
        crate::save_preferences(app.clone(), preferences).await?;
    }
    Ok(())
}

/// Remove the `CLIProxyAPI` providers and clear every default or magic-prompt
/// override that names them. Returns whether anything changed.
fn detach_profiles(preferences: &mut AppPreferences) -> bool {
    let count = |p: &AppPreferences| {
        p.custom_cli_profiles.len() + p.custom_codex_providers.len() + p.custom_pi_providers.len()
    };
    let before = count(preferences);
    preferences
        .custom_cli_profiles
        .retain(|profile| profile.name != PROFILE_NAME);
    preferences
        .custom_codex_providers
        .retain(|profile| profile.name != PROFILE_NAME);
    preferences
        .custom_pi_providers
        .retain(|profile| profile.name != PROFILE_NAME);
    let mut changed = count(preferences) != before;

    for provider in [
        &mut preferences.default_provider,
        &mut preferences.default_codex_provider,
    ] {
        if provider.as_deref() == Some(PROFILE_NAME) {
            *provider = None;
            changed = true;
        }
    }

    // Each magic prompt has its own provider field; clear any that names the proxy.
    let Ok(serde_json::Value::Object(mut overrides)) =
        serde_json::to_value(&preferences.magic_prompt_providers)
    else {
        return changed;
    };
    let mut overrides_changed = false;
    for value in overrides.values_mut() {
        if *value == PROFILE_NAME {
            *value = serde_json::Value::Null;
            overrides_changed = true;
        }
    }
    if overrides_changed {
        if let Ok(cleared) = serde_json::from_value(overrides.into()) {
            preferences.magic_prompt_providers = cleared;
            changed = true;
        }
    }
    changed
}

/// Delete the Jean-made install folder (binary, config, OAuth logins). A
/// symlink is left alone so Jean never deletes outside its own folder.
fn remove_install_dir(dir: &Path) {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            log::warn!(
                "Not deleting {}: it is a symlink. Remove it by hand.",
                dir.display()
            );
        }
        Ok(_) => match std::fs::remove_dir_all(dir) {
            Ok(()) => log::info!("CLIProxyAPI support was removed. Deleted {}", dir.display()),
            Err(error) => log::warn!("Failed to delete {}: {error}", dir.display()),
        },
        Err(_) => {}
    }
}

/// Kill the process in the old pid file only when it is still the sidecar,
/// then drop the pid file so a reused pid is never checked again.
fn stop_sidecar(pid_path: &Path) {
    let Some(pid) = std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
    else {
        return;
    };
    if pid != 0 && is_process_alive(pid) && command_line(pid).contains("cli-proxy-api") {
        match kill_process_tree(pid) {
            Ok(()) => log::info!("Stopped the CLIProxyAPI sidecar (pid {pid})"),
            Err(error) => log::warn!("Failed to stop the CLIProxyAPI sidecar: {error}"),
        }
    }
    let _ = std::fs::remove_file(pid_path);
}

#[cfg(target_os = "linux")]
fn command_line(pid: u32) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn command_line(pid: u32) -> String {
    let pid = pid.to_string();
    let mut command = if cfg!(windows) {
        let mut command = crate::platform::silent_command("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        command
    } else {
        let mut command = crate::platform::silent_command("ps");
        command.args(["-o", "command=", "-p", &pid]);
        command
    };
    command
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remove_install_dir_deletes_folder_but_not_a_symlink_target() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("cliproxyapi");
        std::fs::create_dir_all(install.join("auths")).unwrap();
        std::fs::write(install.join("auths/claude.json"), "{}").unwrap();
        remove_install_dir(&install);
        assert!(!install.exists());

        #[cfg(unix)]
        {
            let target = temp.path().join("elsewhere");
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("keep.txt"), "x").unwrap();
            std::os::unix::fs::symlink(&target, &install).unwrap();
            remove_install_dir(&install);
            assert!(install.exists());
            assert!(target.join("keep.txt").exists());
        }

        remove_install_dir(&temp.path().join("missing"));
    }

    fn preferences_with_proxy() -> AppPreferences {
        let mut value = serde_json::to_value(AppPreferences::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert(
            "custom_cli_profiles".into(),
            json!([
                { "name": "CLIProxyAPI", "settings_json": "{}" },
                { "name": "OpenRouter", "settings_json": "{}" }
            ]),
        );
        object.insert(
            "custom_codex_providers".into(),
            json!([
                { "name": "CLIProxyAPI", "provider_id": "cliproxyapi", "base_url": "http://127.0.0.1:8317/v1", "env_key": "CLIPROXYAPI_API_KEY" },
                { "name": "QwenCloud", "provider_id": "qwencloud", "base_url": "https://example.com", "env_key": "QWEN_KEY" }
            ]),
        );
        object.insert(
            "custom_pi_providers".into(),
            json!([
                { "name": "CLIProxyAPI", "base_url": "http://127.0.0.1:8317/v1", "api": "openai-completions" },
                { "name": "ollama", "base_url": "http://localhost:11434/v1", "api": "openai-completions" }
            ]),
        );
        object.insert("default_provider".into(), json!("CLIProxyAPI"));
        object.insert("default_codex_provider".into(), json!("CLIProxyAPI"));
        object.insert(
            "magic_prompt_providers".into(),
            json!({
                "investigate_issue_provider": "CLIProxyAPI",
                "commit_message_provider": "OpenRouter"
            }),
        );
        serde_json::from_value(value).unwrap()
    }

    fn names<T>(items: &[T], name: impl Fn(&T) -> &str) -> Vec<&str> {
        items.iter().map(name).collect()
    }

    #[test]
    fn detach_profiles_removes_proxy_and_keeps_other_providers() {
        let mut preferences = preferences_with_proxy();

        assert!(detach_profiles(&mut preferences));

        assert_eq!(
            names(&preferences.custom_cli_profiles, |p| &p.name),
            ["OpenRouter"]
        );
        assert_eq!(
            names(&preferences.custom_codex_providers, |p| &p.name),
            ["QwenCloud"]
        );
        assert_eq!(
            names(&preferences.custom_pi_providers, |p| &p.name),
            ["ollama"]
        );
        assert_eq!(preferences.default_provider, None);
        assert_eq!(preferences.default_codex_provider, None);
        let overrides = &preferences.magic_prompt_providers;
        assert_eq!(overrides.investigate_issue_provider, None);
        assert_eq!(
            overrides.commit_message_provider.as_deref(),
            Some("OpenRouter")
        );
    }

    #[test]
    fn detach_profiles_keeps_defaults_that_name_other_providers() {
        let mut preferences = preferences_with_proxy();
        preferences.default_provider = Some("OpenRouter".into());
        preferences.default_codex_provider = Some("QwenCloud".into());

        detach_profiles(&mut preferences);

        assert_eq!(preferences.default_provider.as_deref(), Some("OpenRouter"));
        assert_eq!(
            preferences.default_codex_provider.as_deref(),
            Some("QwenCloud")
        );
    }

    #[test]
    fn detach_profiles_second_run_is_a_no_op() {
        let mut preferences = preferences_with_proxy();
        detach_profiles(&mut preferences);
        let first = serde_json::to_value(&preferences).unwrap();

        assert!(!detach_profiles(&mut preferences));
        assert_eq!(serde_json::to_value(&preferences).unwrap(), first);
    }

    #[test]
    fn detach_profiles_leaves_preferences_without_proxy_unchanged() {
        let mut preferences = AppPreferences::default();
        assert!(!detach_profiles(&mut preferences));
    }

    #[test]
    fn stop_sidecar_removes_a_stale_pid_file() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("cliproxyapi.pid");
        // The test process is alive but is not the sidecar, so it must survive.
        std::fs::write(&pid_path, std::process::id().to_string()).unwrap();

        stop_sidecar(&pid_path);

        assert!(!pid_path.exists());
        assert!(is_process_alive(std::process::id()));
    }
}

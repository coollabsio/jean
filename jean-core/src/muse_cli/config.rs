use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "muse-cli";
/// The official installer writes a bash launcher named `muse` next to the
/// versioned `muse-bin-<version>` binary; the launcher is the stable entrypoint.
pub const MANAGED_CLI_BINARY_NAME: &str = "muse";
/// Overrides the serve/exec provider (for example `echo`) so the whole app can
/// be smoke-tested offline.
pub const PROVIDER_ENV: &str = "JEAN_MUSE_PROVIDER";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcePreference {
    Jean,
    Path,
    Missing,
}

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CLI_DIR_NAME))
        .map_err(|error| format!("Failed to get app data directory: {error}"))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create Muse CLI directory: {error}"))?;
    Ok(dir)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(MANAGED_CLI_BINARY_NAME))
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| value.get("muse_cli_source").cloned())
        .map(|value| {
            if value.as_str() == Some("path") {
                SourcePreference::Path
            } else {
                SourcePreference::Jean
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

/// `muse` on PATH, else the installer's default `~/.local/bin/muse`.
pub fn find_system_muse_binary(app: &AppHandle) -> Option<PathBuf> {
    let managed = get_cli_binary_path(app)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    crate::platform::detect_cli_in_path("muse", managed.as_deref(), None)
        .path
        .map(PathBuf::from)
        .or_else(|| {
            dirs::home_dir()
                .map(|home| home.join(".local").join("bin").join("muse"))
                .filter(|path| path.is_file())
        })
}

pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "muse", None)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("muse"));
    }
    let managed = get_cli_binary_path(app).ok().filter(|path| path.exists());
    let system = find_system_muse_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| PathBuf::from("muse")),
        SourcePreference::Missing if system.is_some() => system.unwrap_or_default(),
        SourcePreference::Jean | SourcePreference::Missing => {
            managed.unwrap_or_else(|| PathBuf::from("muse"))
        }
    }
}

pub fn binary_exists(path: &Path) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        which::which(path).is_ok()
    }
}

/// `$XDG_CONFIG_HOME/muse`, default `~/.config/muse`.
pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .map(|base| base.join("muse"))
}

pub fn settings_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("settings.json"))
}

pub fn auth_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("auth.json"))
}

pub fn provider_override() -> Option<String> {
    std::env::var(PROVIDER_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Strip the `muse/` prefix; `muse/default` (or empty) means the server default.
pub fn muse_model(model: Option<&str>) -> Option<&str> {
    model
        .and_then(|value| value.strip_prefix("muse/").or(Some(value)))
        .filter(|value| !value.is_empty() && *value != "default")
}

/// Jean effort values pass through only when Muse's closed tier vocabulary has them.
pub fn muse_reasoning_effort(effort: Option<&str>) -> Option<&str> {
    effort.filter(|value| {
        matches!(
            *value,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
    })
}

/// How one Jean execution mode maps onto `muse serve` and MSP session params.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MuseMode {
    pub permission_profile: &'static str,
    pub approval_mode: Option<&'static str>,
    pub disable_sandbox: bool,
    /// Auto-approve `approval/request`; plan mode denies instead.
    pub auto_approve: bool,
}

pub fn muse_mode(mode: Option<&str>) -> MuseMode {
    match mode.unwrap_or("build") {
        "yolo" => MuseMode {
            permission_profile: ":unrestricted",
            approval_mode: None,
            disable_sandbox: true,
            auto_approve: true,
        },
        "build" | "auto" | "supervised" => MuseMode {
            permission_profile: ":ask-me",
            approval_mode: Some("allowAll"),
            disable_sandbox: false,
            auto_approve: true,
        },
        _ => MuseMode {
            permission_profile: ":read-only",
            approval_mode: None,
            disable_sandbox: false,
            auto_approve: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_jean_modes_to_muse_profiles() {
        let missing = muse_mode(None);
        assert_eq!(missing.permission_profile, ":ask-me");
        assert_eq!(missing.approval_mode, Some("allowAll"));
        assert!(!missing.disable_sandbox);
        assert!(missing.auto_approve);

        let plan = muse_mode(Some("plan"));
        assert_eq!(plan.permission_profile, ":read-only");
        assert_eq!(plan.approval_mode, None);
        assert!(!plan.disable_sandbox);
        assert!(!plan.auto_approve);

        let build = muse_mode(Some("build"));
        assert_eq!(build.permission_profile, ":ask-me");
        assert_eq!(build.approval_mode, Some("allowAll"));
        assert!(!build.disable_sandbox);
        assert!(build.auto_approve);

        let yolo = muse_mode(Some("yolo"));
        assert_eq!(yolo.permission_profile, ":unrestricted");
        assert_eq!(yolo.approval_mode, None);
        assert!(yolo.disable_sandbox);
        assert!(yolo.auto_approve);
    }

    #[test]
    fn strips_prefix_and_omits_default_model() {
        assert_eq!(
            muse_model(Some("muse/muse-spark-1.2")),
            Some("muse-spark-1.2")
        );
        assert_eq!(muse_model(Some("muse/default")), None);
        assert_eq!(muse_model(None), None);
    }

    #[test]
    fn passes_only_known_effort_tiers() {
        assert_eq!(muse_reasoning_effort(Some("xhigh")), Some("xhigh"));
        assert_eq!(muse_reasoning_effort(Some("ultra")), Some("ultra"));
        assert_eq!(muse_reasoning_effort(Some("ultracode")), None);
        assert_eq!(muse_reasoning_effort(Some("off")), None);
        assert_eq!(muse_reasoning_effort(None), None);
    }
}

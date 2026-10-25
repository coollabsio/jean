//! Named provider accounts.
//!
//! Jean stores one isolated config directory per account under the app data
//! dir. A session points at an account id. Claude runs with `CLAUDE_CONFIG_DIR`
//! and Codex runs with `CODEX_HOME`, so personal and work logins can stay
//! side by side instead of replacing `~/.claude` / `~/.codex`.
//!
//! Accounts with no selection keep the CLI's own login.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub const CLAUDE_BACKEND: &str = "claude";
pub const CODEX_BACKEND: &str = "codex";

const ACCOUNT_ID_MAX: usize = 80;
const LABEL_MAX: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccount {
    pub id: String,
    pub backend: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexHomeSwitch {
    Keep,
    Spawn,
    Restart,
}

pub fn supported_backend(backend: &str) -> Result<&'static str, String> {
    match backend {
        CLAUDE_BACKEND => Ok(CLAUDE_BACKEND),
        CODEX_BACKEND => Ok(CODEX_BACKEND),
        other => Err(format!(
            "Provider accounts are available for Claude and Codex (got {other})"
        )),
    }
}

pub fn config_home_env_key(backend: &str) -> Option<&'static str> {
    match backend {
        CLAUDE_BACKEND => Some("CLAUDE_CONFIG_DIR"),
        CODEX_BACKEND => Some("CODEX_HOME"),
        _ => None,
    }
}

pub fn normalize_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Account name is required".to_string());
    }
    if label.chars().count() > LABEL_MAX {
        return Err(format!(
            "Account name must be {LABEL_MAX} characters or fewer"
        ));
    }
    if label
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':' | '\0'))
    {
        return Err("Account name cannot include path characters".to_string());
    }
    Ok(label.to_string())
}

fn valid_account_id(id: &str) -> bool {
    let len = id.len();
    (8..=ACCOUNT_ID_MAX).contains(&len)
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

pub fn create_account(
    accounts: &mut Vec<ProviderAccount>,
    backend: &str,
    label: &str,
) -> Result<ProviderAccount, String> {
    let backend = supported_backend(backend)?.to_string();
    let label = normalize_label(label)?;
    if accounts
        .iter()
        .any(|account| account.backend == backend && account.label.eq_ignore_ascii_case(&label))
    {
        return Err(format!(
            "A {backend} account named \"{label}\" already exists"
        ));
    }
    let account = ProviderAccount {
        id: uuid::Uuid::new_v4().to_string(),
        backend,
        label,
    };
    accounts.push(account.clone());
    Ok(account)
}

pub fn remove_account(
    accounts: &mut Vec<ProviderAccount>,
    defaults: &mut HashMap<String, String>,
    id: &str,
) -> Result<ProviderAccount, String> {
    let index = accounts
        .iter()
        .position(|account| account.id == id)
        .ok_or_else(|| "Provider account not found".to_string())?;
    let account = accounts.remove(index);
    defaults.retain(|_, value| value != id);
    Ok(account)
}

pub fn select_account<'a>(
    accounts: &'a [ProviderAccount],
    backend: &str,
    account_id: Option<&str>,
) -> Result<Option<&'a ProviderAccount>, String> {
    let Some(account_id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let backend = supported_backend(backend)?;
    let account = accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "That provider account no longer exists".to_string())?;
    if account.backend != backend {
        return Err(format!(
            "Account \"{}\" belongs to {} and cannot be used for {backend}",
            account.label, account.backend
        ));
    }
    Ok(Some(account))
}

pub fn default_account_id_for(
    accounts: &[ProviderAccount],
    defaults: &HashMap<String, String>,
    backend: &str,
) -> Option<String> {
    let backend = supported_backend(backend).ok()?;
    let id = defaults.get(backend)?;
    select_account(accounts, backend, Some(id))
        .ok()
        .flatten()
        .map(|account| account.id.clone())
}

pub fn account_dir(root: &Path, account: &ProviderAccount) -> Result<PathBuf, String> {
    let backend = supported_backend(&account.backend)?;
    if !valid_account_id(&account.id) {
        return Err("Provider account id is not valid".to_string());
    }
    Ok(root
        .join("provider-accounts")
        .join(backend)
        .join(&account.id))
}

pub fn accounts_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to get app data directory: {error}"))
}

pub fn ensure_account_dir(root: &Path, account: &ProviderAccount) -> Result<PathBuf, String> {
    let dir = account_dir(root, account)?;
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "Failed to create provider account directory {}: {error}",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// Decide whether a running Codex app-server can serve this account.
///
/// `wanted_home == None` is the user's own Codex login. A live server on a
/// different home is restarted only when nothing is mid-turn.
pub fn codex_home_switch_action(
    server_alive: bool,
    running_home: Option<&Path>,
    wanted_home: Option<&Path>,
    busy: bool,
) -> Result<CodexHomeSwitch, String> {
    if !server_alive {
        return Ok(CodexHomeSwitch::Spawn);
    }
    if homes_equal(running_home, wanted_home) {
        return Ok(CodexHomeSwitch::Keep);
    }
    if busy {
        return Err(
            "Codex is using a different account. Wait for the current Codex turn to finish, then try again."
                .to_string(),
        );
    }
    Ok(CodexHomeSwitch::Restart)
}

fn homes_equal(left: Option<&Path>, right: Option<&Path>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

pub fn config_env(backend: &str, home: &Path) -> Result<(&'static str, String), String> {
    let key = config_home_env_key(backend)
        .ok_or_else(|| format!("No config directory override for {backend}"))?;
    let value = home
        .to_str()
        .ok_or_else(|| "Provider account path is not valid UTF-8".to_string())?
        .to_string();
    Ok((key, value))
}

fn copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    std::fs::copy(source, dest).map(|_| ()).map_err(|error| {
        format!(
            "Failed to copy {} to {}: {error}",
            source.display(),
            dest.display()
        )
    })
}

fn write_text(dest: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    std::fs::write(dest, contents)
        .map_err(|error| format!("Failed to write {}: {error}", dest.display()))
}

/// Copy the current CLI login into an account directory.
///
/// Codex auth is stored as `auth.json` inside `CODEX_HOME`. Claude credentials
/// are stored as `.credentials.json` inside `CLAUDE_CONFIG_DIR`. Optional
/// config files are copied when they exist. Missing optional files are skipped.
pub fn capture_auth_snapshot(
    backend: &str,
    user_home: &Path,
    dest_dir: &Path,
) -> Result<Vec<String>, String> {
    let backend = supported_backend(backend)?;
    std::fs::create_dir_all(dest_dir).map_err(|error| {
        format!(
            "Failed to create provider account directory {}: {error}",
            dest_dir.display()
        )
    })?;

    let mut copied = Vec::new();
    match backend {
        CODEX_BACKEND => {
            let auth = codex_auth_source(user_home).ok_or_else(|| {
                "No Codex login found. Sign in from Settings → General, then save this account."
                    .to_string()
            })?;
            copy_file(&auth, &dest_dir.join("auth.json"))?;
            copied.push("auth.json".to_string());
            let config = user_home.join(".codex").join("config.toml");
            if config.is_file() {
                copy_file(&config, &dest_dir.join("config.toml"))?;
                copied.push("config.toml".to_string());
            }
        }
        CLAUDE_BACKEND => {
            let credentials = dest_dir.join(".credentials.json");
            let file = user_home.join(".claude").join(".credentials.json");
            if file.is_file() {
                copy_file(&file, &credentials)?;
            } else if let Some(raw) = claude_keychain_credentials() {
                write_text(&credentials, &raw)?;
            } else {
                return Err(
                    "No Claude login found. Sign in from Settings → General, then save this account."
                        .to_string(),
                );
            }
            copied.push(".credentials.json".to_string());
            let settings = user_home.join(".claude").join("settings.json");
            if settings.is_file() {
                copy_file(&settings, &dest_dir.join("settings.json"))?;
                copied.push("settings.json".to_string());
            }
        }
        _ => unreachable!("supported_backend limits the match"),
    }
    Ok(copied)
}

fn codex_auth_source(user_home: &Path) -> Option<PathBuf> {
    let candidates = [
        user_home.join(".codex").join("auth.json"),
        user_home.join(".config").join("codex").join("auth.json"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn claude_keychain_credentials() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = crate::platform::silent_command("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if raw.starts_with('{') {
            return Some(raw);
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub fn account_config_home(
    app: &AppHandle,
    accounts: &[ProviderAccount],
    backend: &str,
    account_id: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(account) = select_account(accounts, backend, account_id)? else {
        return Ok(None);
    };
    let root = accounts_root(app)?;
    ensure_account_dir(&root, account).map(Some)
}

pub fn account_config_home_for_session(
    app: &AppHandle,
    backend: &str,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let metadata = crate::chat::storage::load_metadata(app, session_id)?;
    let account_id = metadata
        .as_ref()
        .and_then(|metadata| metadata.provider_account_id.as_deref());
    let preferences = crate::load_preferences_sync(app)?;
    account_config_home(app, &preferences.provider_accounts, backend, account_id)
}

pub async fn create_provider_account(
    app: AppHandle,
    backend: String,
    label: String,
) -> Result<ProviderAccount, String> {
    let mut preferences = crate::load_preferences(app.clone()).await?;
    let account = create_account(&mut preferences.provider_accounts, &backend, &label)?;
    let root = accounts_root(&app)?;
    ensure_account_dir(&root, &account)?;
    crate::save_preferences(app, preferences).await?;
    Ok(account)
}

pub async fn delete_provider_account(app: AppHandle, id: String) -> Result<(), String> {
    let mut preferences = crate::load_preferences(app.clone()).await?;
    let account = remove_account(
        &mut preferences.provider_accounts,
        &mut preferences.default_provider_accounts,
        &id,
    )?;
    if let Ok(root) = accounts_root(&app) {
        if let Ok(dir) = account_dir(&root, &account) {
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|error| {
                    format!(
                        "Failed to remove provider account directory {}: {error}",
                        dir.display()
                    )
                })?;
            }
        }
    }
    crate::save_preferences(app, preferences).await?;
    Ok(())
}

pub async fn capture_provider_account_auth(
    app: AppHandle,
    id: String,
) -> Result<Vec<String>, String> {
    let preferences = crate::load_preferences(app.clone()).await?;
    let account = preferences
        .provider_accounts
        .iter()
        .find(|account| account.id == id)
        .cloned()
        .ok_or_else(|| "Provider account not found".to_string())?;
    let user_home = dirs::home_dir().ok_or_else(|| "No home directory found".to_string())?;
    let root = accounts_root(&app)?;
    let dest = ensure_account_dir(&root, &account)?;
    capture_auth_snapshot(&account.backend, &user_home, &dest)
}

pub async fn set_session_provider_account(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    account_id: Option<String>,
) -> Result<(), String> {
    let preferences = crate::load_preferences_sync(&app)?;
    crate::chat::with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let backend = match &session.backend {
            crate::chat::types::Backend::Codex => CODEX_BACKEND,
            crate::chat::types::Backend::Claude => CLAUDE_BACKEND,
            _ => {
                return Err(
                    "Provider accounts are available for Claude and Codex sessions".to_string(),
                );
            }
        };
        let selected = select_account(
            &preferences.provider_accounts,
            backend,
            account_id.as_deref(),
        )?;
        session.provider_account_id = selected.map(|account| account.id.clone());
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, backend: &str, label: &str) -> ProviderAccount {
        ProviderAccount {
            id: id.to_string(),
            backend: backend.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn create_account_rejects_duplicates_and_keeps_distinct_backends() {
        let mut accounts = Vec::new();
        let work = create_account(&mut accounts, "codex", " Work ").unwrap();
        assert_eq!(work.label, "Work");
        assert_eq!(work.backend, "codex");
        assert!(valid_account_id(&work.id));
        assert!(create_account(&mut accounts, "codex", "work").is_err());
        assert!(create_account(&mut accounts, "claude", "Work").is_ok());
        assert!(create_account(&mut accounts, "pi", "Work").is_err());
    }

    #[test]
    fn select_account_checks_backend_and_missing_ids() {
        let accounts = vec![
            account("work-acct", "codex", "Work"),
            account("personal1", "claude", "Personal"),
        ];
        assert!(select_account(&accounts, "codex", None).unwrap().is_none());
        assert_eq!(
            select_account(&accounts, "codex", Some("work-acct"))
                .unwrap()
                .unwrap()
                .label,
            "Work"
        );
        assert!(select_account(&accounts, "claude", Some("work-acct")).is_err());
        assert!(select_account(&accounts, "codex", Some("missing-id")).is_err());
    }

    #[test]
    fn default_account_ignores_dangling_and_cross_backend_ids() {
        let accounts = vec![account("work-acct", "codex", "Work")];
        let mut defaults = HashMap::from([
            ("codex".to_string(), "work-acct".to_string()),
            ("claude".to_string(), "missing".to_string()),
        ]);
        assert_eq!(
            default_account_id_for(&accounts, &defaults, "codex").as_deref(),
            Some("work-acct")
        );
        assert!(default_account_id_for(&accounts, &defaults, "claude").is_none());
        remove_account(&mut accounts.clone(), &mut defaults, "work-acct").unwrap();
        assert!(defaults.get("codex").is_none());
    }

    #[test]
    fn account_dir_stays_inside_the_accounts_root() {
        let root = PathBuf::from("/tmp/jean");
        let dir = account_dir(&root, &account("work-acct", "codex", "Work")).unwrap();
        assert_eq!(
            dir,
            root.join("provider-accounts")
                .join("codex")
                .join("work-acct")
        );
        assert!(account_dir(&root, &account("../escape", "codex", "Work")).is_err());
        assert!(account_dir(&root, &account("work-acct", "pi", "Work")).is_err());
    }

    #[test]
    fn capture_copies_codex_xdg_auth_and_skips_missing_config() {
        let temp =
            std::env::temp_dir().join(format!("jean-provider-accounts-{}", uuid::Uuid::new_v4()));
        let home = temp.join("home");
        let dest = temp.join("account");
        std::fs::create_dir_all(home.join(".config").join("codex")).unwrap();
        std::fs::write(
            home.join(".config").join("codex").join("auth.json"),
            "{\"tokens\":{}}",
        )
        .unwrap();

        let copied = capture_auth_snapshot("codex", &home, &dest).unwrap();
        assert_eq!(copied, vec!["auth.json".to_string()]);
        assert_eq!(
            std::fs::read_to_string(dest.join("auth.json")).unwrap(),
            "{\"tokens\":{}}"
        );
        assert!(!dest.join("config.toml").exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn capture_prefers_codex_home_auth_and_copies_config() {
        let temp =
            std::env::temp_dir().join(format!("jean-provider-accounts-{}", uuid::Uuid::new_v4()));
        let home = temp.join("home");
        let dest = temp.join("account");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".config").join("codex")).unwrap();
        std::fs::write(home.join(".codex").join("auth.json"), "primary").unwrap();
        std::fs::write(home.join(".config").join("codex").join("auth.json"), "xdg").unwrap();
        std::fs::write(home.join(".codex").join("config.toml"), "model = \"x\"").unwrap();

        let copied = capture_auth_snapshot("codex", &home, &dest).unwrap();
        assert_eq!(
            copied,
            vec!["auth.json".to_string(), "config.toml".to_string()]
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("auth.json")).unwrap(),
            "primary"
        );
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn capture_claude_credentials_file() {
        let temp =
            std::env::temp_dir().join(format!("jean-provider-accounts-{}", uuid::Uuid::new_v4()));
        let home = temp.join("home");
        let dest = temp.join("account");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude").join(".credentials.json"),
            "{\"claudeAiOauth\":{}}",
        )
        .unwrap();

        let copied = capture_auth_snapshot("claude", &home, &dest).unwrap();
        assert_eq!(copied, vec![".credentials.json".to_string()]);
        let (key, value) = config_env("claude", &dest).unwrap();
        assert_eq!(key, "CLAUDE_CONFIG_DIR");
        assert_eq!(value, dest.to_string_lossy());
        let (key, _) = config_env("codex", &dest).unwrap();
        assert_eq!(key, "CODEX_HOME");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn capture_reports_a_missing_login() {
        let temp =
            std::env::temp_dir().join(format!("jean-provider-accounts-{}", uuid::Uuid::new_v4()));
        let error =
            capture_auth_snapshot("codex", &temp.join("home"), &temp.join("dest")).unwrap_err();
        assert!(error.contains("No Codex login"));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn codex_switch_keeps_matches_and_restarts_only_when_idle() {
        let work = Path::new("/tmp/jean/provider-accounts/codex/work");
        assert_eq!(
            codex_home_switch_action(false, None, Some(work), true).unwrap(),
            CodexHomeSwitch::Spawn
        );
        assert_eq!(
            codex_home_switch_action(true, Some(work), Some(work), true).unwrap(),
            CodexHomeSwitch::Keep
        );
        assert_eq!(
            codex_home_switch_action(true, None, None, false).unwrap(),
            CodexHomeSwitch::Keep
        );
        assert_eq!(
            codex_home_switch_action(true, None, Some(work), false).unwrap(),
            CodexHomeSwitch::Restart
        );
        assert!(codex_home_switch_action(true, None, Some(work), true).is_err());
    }
}

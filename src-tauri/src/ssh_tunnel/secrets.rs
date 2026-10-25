//! SSH profile tokens live outside browser localStorage.
//!
//! macOS uses Keychain and Windows uses Credential Manager. Linux writes a
//! user-only file under the app data directory, because the current Secret
//! Service crates need a newer Rust edition than this crate's other targets.
//! If the OS store fails on macOS or Windows, the same file is the fallback.
//! Tokens are never logged.

use super::hostkey::write_private_file;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(any(target_os = "macos", target_os = "windows"))]
const SERVICE: &str = "coollabs.jean";

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone)]
pub struct SecretStore {
    dir: PathBuf,
    prefer_os: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretFile {
    profiles: BTreeMap<String, String>,
}

impl SecretStore {
    pub fn with_os_fallback(dir: PathBuf) -> Self {
        Self {
            dir,
            prefer_os: true,
        }
    }

    /// Test store. Does not touch the OS credential store.
    #[cfg(test)]
    pub fn file_only(dir: PathBuf) -> Self {
        Self {
            dir,
            prefer_os: false,
        }
    }

    pub fn set(&self, profile_id: &str, token: &str) -> Result<(), String> {
        validate_profile_id(profile_id)?;
        validate_token(token)?;
        if self.prefer_os && keyring_set(profile_id, token).is_ok() {
            let _ = self.file_delete(profile_id);
            return Ok(());
        }
        if self.prefer_os && cfg!(any(target_os = "macos", target_os = "windows")) {
            log::warn!(
                "OS credential store unavailable for SSH tunnel token; using the app data file."
            );
        }
        self.file_set(profile_id, token)
    }

    pub fn get(&self, profile_id: &str) -> Result<Option<String>, String> {
        validate_profile_id(profile_id)?;
        if self.prefer_os {
            match keyring_get(profile_id) {
                Ok(Some(token)) => return Ok(Some(token)),
                Ok(None) => {}
                Err(()) => {
                    if cfg!(any(target_os = "macos", target_os = "windows")) {
                        log::warn!(
                            "OS credential store unavailable while reading an SSH tunnel token."
                        );
                    }
                }
            }
        }
        self.file_get(profile_id)
    }

    pub fn delete(&self, profile_id: &str) -> Result<(), String> {
        validate_profile_id(profile_id)?;
        if self.prefer_os {
            let _ = keyring_delete(profile_id);
        }
        self.file_delete(profile_id)
    }

    fn file_path(&self) -> PathBuf {
        self.dir.join("secrets.json")
    }

    fn file_set(&self, profile_id: &str, token: &str) -> Result<(), String> {
        let _guard = FILE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        file.profiles
            .insert(profile_id.to_string(), token.to_string());
        self.write_file(&file)
    }

    fn file_get(&self, profile_id: &str) -> Result<Option<String>, String> {
        let _guard = FILE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let file = self.read_file()?;
        Ok(file.profiles.get(profile_id).cloned())
    }

    fn file_delete(&self, profile_id: &str) -> Result<(), String> {
        let _guard = FILE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        if file.profiles.remove(profile_id).is_none() {
            return Ok(());
        }
        self.write_file(&file)
    }

    fn read_file(&self) -> Result<SecretFile, String> {
        let path = self.file_path();
        if !path.exists() {
            return Ok(SecretFile::default());
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("Could not read SSH token store: {error}"))?;
        serde_json::from_str(&text).map_err(|_| "SSH token store is unreadable.".to_string())
    }

    fn write_file(&self, file: &SecretFile) -> Result<(), String> {
        let body = serde_json::to_string(file)
            .map_err(|_| "Could not encode the SSH token store.".to_string())?;
        write_private_file(&self.file_path(), &body)
    }
}

pub fn validate_profile_id(id: &str) -> Result<(), String> {
    if (8..=80).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err("Invalid SSH profile id.".to_string())
    }
}

pub fn validate_token(token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Access token is required.".to_string());
    }
    if token.len() > 4096 {
        return Err("Access token is too long.".to_string());
    }
    if token.chars().any(|c| c.is_control()) {
        return Err("Access token contains invalid characters.".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn account(profile_id: &str) -> String {
    format!("ssh-tunnel-{profile_id}")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_set(profile_id: &str, token: &str) -> Result<(), ()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id)).map_err(|_| ())?;
    entry.set_password(token).map_err(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_set(_profile_id: &str, _token: &str) -> Result<(), ()> {
    Err(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_get(profile_id: &str) -> Result<Option<String>, ()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id)).map_err(|_| ())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_get(_profile_id: &str) -> Result<Option<String>, ()> {
    Err(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_delete(profile_id: &str) -> Result<(), ()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id)).map_err(|_| ())?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_delete(_profile_id: &str) -> Result<(), ()> {
    Err(())
}

pub fn identity_file_path(raw: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.contains(['\n', '\r', '\0']) {
        return Err("Identity file path is invalid.".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err("Identity file does not exist.".to_string());
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trip_does_not_require_os_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::file_only(dir.path().to_path_buf());
        let id = "11111111-2222-4333-8444-555555555555";
        store.set(id, "token-value-1").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("token-value-1"));
        store.set(id, "token-value-2").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("token-value-2"));
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);

        let on_disk = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap_or_default();
        assert!(!on_disk.contains("token-value-1"));
    }

    #[test]
    fn rejects_unsafe_ids_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::file_only(dir.path().to_path_buf());
        assert!(store.set("../etc", "token-value").is_err());
        assert!(store.set("profile-1", "line\nbreak").is_err());
        assert!(store.set("profile-1", "   ").is_err());
    }
}

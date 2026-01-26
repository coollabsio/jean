use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::types::ClaudeCredentials;

/// Get the OAuth access token from Claude Code credentials
///
/// On macOS: Reads from Keychain using `security` CLI
/// On other platforms: Falls back to ~/.claude/.credentials.json file
pub async fn get_oauth_token() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // Try Keychain first on macOS
        match get_macos_keychain_token().await {
            Ok(token) => return Ok(token),
            Err(_) => {
                // Fall back to file-based credentials
            }
        }
    }

    // Try file-based credentials
    get_file_credentials().await
}

/// Get OAuth token from macOS Keychain
#[cfg(target_os = "macos")]
async fn get_macos_keychain_token() -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("Failed to execute security command: {e}"))?;

    if !output.status.success() {
        return Err("Keychain item not found".to_string());
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 in keychain data: {e}"))?;

    parse_credentials_json(&json_str)
}

/// Get OAuth token from credentials file
async fn get_file_credentials() -> Result<String, String> {
    let credentials_path = get_credentials_file_path()?;

    if !credentials_path.exists() {
        return Err(format!(
            "Credentials file not found at {}",
            credentials_path.display()
        ));
    }

    let content = fs::read_to_string(&credentials_path)
        .map_err(|e| format!("Failed to read credentials file: {e}"))?;

    parse_credentials_json(&content)
}

/// Parse credentials JSON and extract access token
fn parse_credentials_json(json_str: &str) -> Result<String, String> {
    let creds: ClaudeCredentials =
        serde_json::from_str(json_str.trim()).map_err(|e| format!("Failed to parse credentials JSON: {e}"))?;

    creds
        .claude_ai_oauth
        .map(|oauth| oauth.access_token)
        .ok_or_else(|| "No OAuth credentials found in credentials".to_string())
}

/// Get the path to the credentials file
fn get_credentials_file_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".claude").join(".credentials.json"))
}

/// Check if OAuth credentials are available (without returning the token)
pub async fn has_oauth_credentials() -> bool {
    get_oauth_token().await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_credentials_json() {
        let json = r#"{
            "claudeAiOauth": {
                "accessToken": "test-token-123",
                "refreshToken": "refresh-456",
                "expiresAt": 1234567890
            }
        }"#;

        let result = parse_credentials_json(json);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test-token-123");
    }

    #[test]
    fn test_parse_credentials_json_missing_oauth() {
        let json = r#"{}"#;
        let result = parse_credentials_json(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_credentials_file_path() {
        let path = get_credentials_file_path();
        assert!(path.is_ok());
        let path = path.unwrap();
        assert!(path.to_string_lossy().contains(".claude"));
        assert!(path.to_string_lossy().contains(".credentials.json"));
    }
}

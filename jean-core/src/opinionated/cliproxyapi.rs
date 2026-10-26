//! Jean-managed CLIProxyAPI sidecar.
//!
//! CLIProxyAPI (MIT, https://github.com/router-for-me/CLIProxyAPI) owns
//! multi-account pooling and round-robin. Jean only downloads the official
//! release binary, supervises it on localhost, and points Claude/Codex at
//! `http://127.0.0.1:8317` through the existing provider profiles.
//!
//! Subscription login is CLIProxyAPI's own `-claude-login` / `-codex-login`.
//! Jean can launch those against the managed binary and config. Tokens stay in
//! CLIProxyAPI's auth directory. Jean does not store them or switch accounts.

use crate::platform::{is_process_alive, kill_process_tree, silent_command, write_binary_file};
use crate::{CodexProviderProfile, CustomCliProfile};
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const PLUGIN_ID: &str = "cliproxyapi";
pub const PROFILE_NAME: &str = "CLIProxyAPI";
pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8317;
pub const CLAUDE_BASE_URL: &str = "http://127.0.0.1:8317";
pub const CODEX_BASE_URL: &str = "http://127.0.0.1:8317/v1";
pub const CODEX_PROVIDER_ID: &str = "cliproxyapi";
pub const CODEX_ENV_KEY: &str = "CLIPROXYAPI_API_KEY";
pub const RELEASE_API: &str =
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
pub const GITHUB_URL: &str = "https://github.com/router-for-me/CLIProxyAPI";
pub const LICENSE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE";
const PANEL_REPOSITORY: &str = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center";
const MAX_ARCHIVE_BYTES: usize = 80 * 1024 * 1024;
const BINARY_NAME: &str = if cfg!(windows) {
    "cli-proxy-api.exe"
} else {
    "cli-proxy-api"
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveFormat {
    TarGz,
    Zip,
}

#[derive(Debug)]
struct ReleaseAsset {
    name: String,
    download_url: String,
    format: ArchiveFormat,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Manifest {
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub host: String,
    pub port: u16,
    pub loopback_only: bool,
}

pub struct InstallLayout {
    pub dir: PathBuf,
    pub binary: PathBuf,
    pub config: PathBuf,
    pub manifest: PathBuf,
    pub pid: PathBuf,
    pub log: PathBuf,
    pub client_key: PathBuf,
    pub management_key: PathBuf,
    pub auth_dir: PathBuf,
}

pub fn layout(home: &Path) -> InstallLayout {
    let dir = home.join(".jean").join("opinionated").join("cliproxyapi");
    InstallLayout {
        binary: dir.join(BINARY_NAME),
        config: dir.join("config.yaml"),
        manifest: dir.join("manifest.json"),
        pid: dir.join("cliproxyapi.pid"),
        log: dir.join("cliproxyapi.log"),
        client_key: dir.join("client-key"),
        management_key: dir.join("management-key"),
        auth_dir: dir.join("auths"),
        dir,
    }
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

pub fn claude_settings_json(client_key: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "env": {
            "ANTHROPIC_BASE_URL": CLAUDE_BASE_URL,
            "ANTHROPIC_AUTH_TOKEN": client_key,
            "ANTHROPIC_API_KEY": client_key,
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
            "API_TIMEOUT_MS": "600000"
        }
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

pub fn codex_provider() -> CodexProviderProfile {
    CodexProviderProfile {
        name: PROFILE_NAME.to_string(),
        provider_id: CODEX_PROVIDER_ID.to_string(),
        base_url: CODEX_BASE_URL.to_string(),
        env_key: CODEX_ENV_KEY.to_string(),
        wire_api: Some("responses".to_string()),
    }
}

/// Insert or refresh the Jean-managed Claude and Codex profiles.
/// Does not change the user's default provider.
pub fn upsert_provider_profiles(
    claude: &mut Vec<CustomCliProfile>,
    codex: &mut Vec<CodexProviderProfile>,
    client_key: &str,
) {
    let settings_json = claude_settings_json(client_key);
    if let Some(profile) = claude
        .iter_mut()
        .find(|profile| profile.name == PROFILE_NAME)
    {
        profile.settings_json = settings_json;
        profile.supports_thinking = Some(true);
    } else {
        claude.push(CustomCliProfile {
            name: PROFILE_NAME.to_string(),
            settings_json,
            file_path: String::new(),
            supports_thinking: Some(true),
        });
    }

    let provider = codex_provider();
    if let Some(existing) = codex
        .iter_mut()
        .find(|profile| profile.name == PROFILE_NAME)
    {
        *existing = provider;
    } else {
        codex.push(provider);
    }
}

/// Drop the Jean-managed profiles and clear them if they were the default.
pub fn detach_provider_profiles(
    claude: &mut Vec<CustomCliProfile>,
    codex: &mut Vec<CodexProviderProfile>,
    default_provider: &mut Option<String>,
    default_codex_provider: &mut Option<String>,
) -> bool {
    let before = claude.len() + codex.len();
    claude.retain(|profile| profile.name != PROFILE_NAME);
    codex.retain(|profile| profile.name != PROFILE_NAME);
    let mut changed = claude.len() + codex.len() != before;
    if default_provider.as_deref() == Some(PROFILE_NAME) {
        *default_provider = None;
        changed = true;
    }
    if default_codex_provider.as_deref() == Some(PROFILE_NAME) {
        *default_codex_provider = None;
        changed = true;
    }
    changed
}

pub fn render_config(
    client_key: &str,
    management_key: &str,
    auth_dir: &Path,
) -> Result<String, String> {
    let auth_dir = auth_dir
        .to_str()
        .ok_or_else(|| "CLIProxyAPI auth directory is not valid UTF-8".to_string())?;
    let value = serde_json::json!({
        "config-version": 8,
        "server": {
            "host": DEFAULT_HOST,
            "port": DEFAULT_PORT,
            "discovery": { "enabled": false }
        },
        "management": {
            "allow-remote": false,
            "secret-key": management_key,
            "disable-control-panel": false,
            "panel-github-repository": PANEL_REPOSITORY
        },
        "access": {
            "api-keys": [client_key]
        },
        "routing": {
            "strategy": "round-robin"
        },
        "oauth": {
            "auth-dir": auth_dir
        }
    });
    let yaml = serde_yaml::to_string(&value).map_err(|error| error.to_string())?;
    let mut rendered = String::from(
        "# Jean-managed CLIProxyAPI. Pooling stays in CLIProxyAPI (MIT).\n\
         # Jean only points Claude and Codex at this process.\n\
         # Localhost only. Change server.host yourself if you intentionally want LAN access.\n",
    );
    rendered.push_str(&yaml);
    Ok(rendered)
}

pub fn listener_from_yaml(yaml: &str) -> Option<Listener> {
    let value: serde_yaml::Value = serde_yaml::from_str(yaml).ok()?;
    let host = value
        .get("server")
        .and_then(|server| server.get("host"))
        .and_then(|host| host.as_str())
        .or_else(|| value.get("host").and_then(|host| host.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    let port = value
        .get("server")
        .and_then(|server| server.get("port"))
        .and_then(yaml_port)
        .or_else(|| value.get("port").and_then(yaml_port))
        .unwrap_or(DEFAULT_PORT);
    let loopback_only = is_loopback_host(&host);
    Some(Listener {
        host,
        port,
        loopback_only,
    })
}

fn yaml_port(value: &serde_yaml::Value) -> Option<u16> {
    value
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| value.as_str().and_then(|port| port.parse().ok()))
}

pub fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

pub fn management_url(port: u16) -> String {
    format!("http://{DEFAULT_HOST}:{port}/management.html")
}

pub fn endpoint_url(port: u16) -> String {
    format!("http://{DEFAULT_HOST}:{port}")
}

/// Env passed to Codex so `env_key = CLIPROXYAPI_API_KEY` resolves.
/// Empty when the sidecar has not generated a client key.
pub fn codex_process_env() -> Vec<(String, String)> {
    let Ok(home) = home_dir() else {
        return Vec::new();
    };
    codex_process_env_from_home(&home)
}

pub fn codex_process_env_from_home(home: &Path) -> Vec<(String, String)> {
    let key_path = layout(home).client_key;
    let Ok(key) = std::fs::read_to_string(&key_path) else {
        return Vec::new();
    };
    let key = key.trim();
    if key.is_empty() {
        return Vec::new();
    }
    vec![(CODEX_ENV_KEY.to_string(), key.to_string())]
}

pub fn export_client_key_to_process() {
    for (key, value) in codex_process_env() {
        std::env::set_var(key, value);
    }
}

fn asset_suffix(os: &str, arch: &str, musl: bool) -> Result<(String, ArchiveFormat), String> {
    let asset_arch = match arch {
        "x86_64" | "amd64" => "amd64",
        "aarch64" | "arm64" => "aarch64",
        other => {
            return Err(format!(
                "CLIProxyAPI has no official release for {os}/{other}. See {GITHUB_URL}/releases"
            ));
        }
    };
    match os {
        "linux" if musl => Ok((
            format!("linux_{asset_arch}_no-plugin.tar.gz"),
            ArchiveFormat::TarGz,
        )),
        "linux" => Ok((format!("linux_{asset_arch}.tar.gz"), ArchiveFormat::TarGz)),
        "macos" | "darwin" => Ok((format!("darwin_{asset_arch}.tar.gz"), ArchiveFormat::TarGz)),
        "windows" => Ok((format!("windows_{asset_arch}.zip"), ArchiveFormat::Zip)),
        other => Err(format!(
            "CLIProxyAPI has no official release Jean can install for {other}/{asset_arch}. See {GITHUB_URL}/releases"
        )),
    }
}

pub fn current_install_unsupported_reason() -> Option<String> {
    asset_suffix(std::env::consts::OS, std::env::consts::ARCH, false).err()
}

fn select_release_asset(
    assets: &[GitHubAsset],
    os: &str,
    arch: &str,
    musl: bool,
) -> Result<ReleaseAsset, String> {
    let (suffix, format) = asset_suffix(os, arch, musl)?;
    let marker = format!("_{suffix}");
    let asset = assets
        .iter()
        .find(|asset| asset.name.starts_with("CLIProxyAPI_") && asset.name.ends_with(&marker));
    let Some(asset) = asset else {
        return Err(format!(
            "CLIProxyAPI release is missing an asset ending in {marker}"
        ));
    };
    trusted_release_url(&asset.browser_download_url)?;
    Ok(ReleaseAsset {
        name: asset.name.clone(),
        download_url: asset.browser_download_url.clone(),
        format,
    })
}

fn trusted_release_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("Invalid release URL: {error}"))?;
    let host = parsed.host_str().unwrap_or("");
    let trusted = matches!(
        host,
        "github.com"
            | "objects.githubusercontent.com"
            | "release-assets.githubusercontent.com"
            | "github-releases.githubusercontent.com"
    );
    if parsed.scheme() != "https" || !trusted {
        return Err(format!("Refusing to download CLIProxyAPI from {url}"));
    }
    Ok(())
}

pub async fn check_status() -> Result<crate::opinionated::commands::PluginStatus, String> {
    let unsupported_reason = current_install_unsupported_reason();
    let home = home_dir()?;
    let paths = layout(&home);
    let installed = paths.binary.is_file();
    let manifest = read_manifest(&paths.manifest);
    let listener = std::fs::read_to_string(&paths.config)
        .ok()
        .as_deref()
        .and_then(listener_from_yaml);
    let port = listener
        .as_ref()
        .map(|item| item.port)
        .unwrap_or(DEFAULT_PORT);
    let running = installed && pid_is_cliproxy(&paths.pid);
    let lan_exposed = listener.as_ref().map(|item| !item.loopback_only);
    Ok(crate::opinionated::commands::PluginStatus {
        installed,
        version: manifest.and_then(|item| item.version),
        install_supported: unsupported_reason.is_none(),
        unsupported_reason,
        backends: None,
        running: Some(running),
        endpoint: Some(endpoint_url(port)),
        management_url: Some(management_url(port)),
        lan_exposed,
        auth_file_count: Some(count_auth_files(&paths.auth_dir)),
    })
}

pub struct InstallOutcome {
    pub message: String,
    pub client_key: String,
    pub running: bool,
}

pub async fn install() -> Result<InstallOutcome, String> {
    if let Some(reason) = current_install_unsupported_reason() {
        return Err(reason);
    }
    let home = home_dir()?;
    let paths = layout(&home);
    let musl = cfg!(target_os = "linux") && linux_uses_musl();
    let (archive, checksums, asset, version) = download_latest(musl).await?;
    verify_checksum(&archive, &checksums, &asset.name)?;
    if paths.binary.is_file() {
        let home_for_stop = home.clone();
        let _ = tokio::task::spawn_blocking(move || stop_in_home(&home_for_stop)).await;
    }
    std::fs::create_dir_all(&paths.dir)
        .map_err(|error| format!("Failed to create CLIProxyAPI directory: {error}"))?;
    std::fs::create_dir_all(&paths.auth_dir)
        .map_err(|error| format!("Failed to create CLIProxyAPI auth directory: {error}"))?;
    refuse_symlink(&paths.binary)?;
    let binary = extract_binary(&archive, asset.format, BINARY_NAME)?;
    write_binary_file(&paths.binary, &binary)
        .map_err(|error| format!("Failed to write CLIProxyAPI binary: {error}"))?;
    set_mode(&paths.binary, 0o755)?;
    let client_key = ensure_secret(&paths.client_key)?;
    let management_key = ensure_secret(&paths.management_key)?;
    ensure_config(&paths, &client_key, &management_key)?;
    write_manifest(
        &paths.manifest,
        &Manifest {
            enabled: true,
            version: Some(version.clone()),
        },
    )?;
    export_client_key_to_process();
    let login = login_hint(&paths);
    let home_for_start = home.clone();
    let started = tokio::task::spawn_blocking(move || start_in_home(&home_for_start))
        .await
        .map_err(|error| format!("Failed to start CLIProxyAPI: {error}"))?;
    let (running, message) = match started {
        Ok(()) => (
            true,
            format!(
                "CLIProxyAPI {version} installed at {}. Listening on {} (localhost only). Select the CLIProxyAPI provider for Claude or Codex. Pooling stays in CLIProxyAPI, not Jean. Restart Jean if Codex was already running so it receives {CODEX_ENV_KEY}. {login} License: {LICENSE_URL}",
                paths.binary.display(),
                endpoint_url(DEFAULT_PORT)
            ),
        ),
        Err(error) => (
            false,
            format!(
                "CLIProxyAPI {version} installed at {} but did not stay running: {error}. {login}",
                paths.binary.display()
            ),
        ),
    };
    Ok(InstallOutcome {
        message,
        client_key,
        running,
    })
}

pub async fn uninstall() -> Result<String, String> {
    let home = home_dir()?;
    let home_for_stop = home.clone();
    let _ = tokio::task::spawn_blocking(move || stop_in_home(&home_for_stop))
        .await
        .map_err(|error| format!("Failed to stop CLIProxyAPI: {error}"))?;
    let paths = layout(&home);
    if paths.dir.exists() {
        refuse_symlink(&paths.dir)?;
        std::fs::remove_dir_all(&paths.dir)
            .map_err(|error| format!("Failed to remove CLIProxyAPI directory: {error}"))?;
    }
    Ok(
        "CLIProxyAPI uninstalled. Jean removed the localhost sidecar and its OAuth auth directory."
            .to_string(),
    )
}

pub async fn start() -> Result<String, String> {
    let home = home_dir()?;
    let paths = layout(&home);
    if !paths.binary.is_file() {
        return Err("CLIProxyAPI is not installed".to_string());
    }
    let mut manifest = read_manifest(&paths.manifest).unwrap_or(Manifest {
        enabled: true,
        version: None,
    });
    manifest.enabled = true;
    write_manifest(&paths.manifest, &manifest)?;
    let home_for_start = home.clone();
    tokio::task::spawn_blocking(move || start_in_home(&home_for_start))
        .await
        .map_err(|error| format!("Failed to start CLIProxyAPI: {error}"))??;
    let port = configured_port(&paths);
    Ok(format!("CLIProxyAPI is running at {}", endpoint_url(port)))
}

pub async fn stop() -> Result<String, String> {
    let home = home_dir()?;
    tokio::task::spawn_blocking(move || stop_in_home(&home))
        .await
        .map_err(|error| format!("Failed to stop CLIProxyAPI: {error}"))??;
    Ok("CLIProxyAPI stopped".to_string())
}

/// Launch spec for CLIProxyAPI's own OAuth login. Jean does not receive the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AccountLoginLaunch {
    pub provider: String,
    pub binary: String,
    pub args: Vec<String>,
    /// True when this call started a stopped sidecar before opening login.
    pub started_proxy: bool,
    pub message: String,
}

pub fn account_login_flag(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok("-claude-login"),
        "codex" => Ok("-codex-login"),
        other => Err(format!(
            "CLIProxyAPI account login supports claude or codex, not {other}"
        )),
    }
}

pub fn account_login_args(config: &Path, provider: &str) -> Result<Vec<String>, String> {
    let flag = account_login_flag(provider)?;
    let config = config
        .to_str()
        .ok_or_else(|| "CLIProxyAPI config path is not valid UTF-8".to_string())?;
    Ok(vec![
        "--config".to_string(),
        config.to_string(),
        flag.to_string(),
    ])
}

#[derive(Debug)]
struct AccountLoginPlan {
    binary: PathBuf,
    auth_dir: PathBuf,
    args: Vec<String>,
    needs_start: bool,
    flag: &'static str,
}

fn plan_account_login(home: &Path, provider: &str) -> Result<AccountLoginPlan, String> {
    let flag = account_login_flag(provider)?;
    let paths = layout(home);
    if !paths.binary.is_file() {
        return Err(
            "CLIProxyAPI is not installed. Install it from Preferences → Opinionated.".to_string(),
        );
    }
    if !paths.config.is_file() {
        return Err(
            "CLIProxyAPI config.yaml is missing. Reinstall it from Preferences → Opinionated."
                .to_string(),
        );
    }
    refuse_symlink(&paths.binary)?;
    refuse_symlink(&paths.config)?;
    Ok(AccountLoginPlan {
        binary: paths.binary,
        auth_dir: paths.auth_dir,
        args: account_login_args(&paths.config, provider)?,
        needs_start: !pid_is_cliproxy(&paths.pid),
        flag,
    })
}

/// Ensure the managed sidecar is installed and running, then return the
/// CLIProxyAPI login argv. The caller runs that process; Jean never reads the
/// OAuth token.
pub async fn prepare_account_login(provider: &str) -> Result<AccountLoginLaunch, String> {
    let home = home_dir()?;
    let plan = plan_account_login(&home, provider)?;
    if plan.needs_start {
        start().await?;
    }
    let binary = plan
        .binary
        .to_str()
        .ok_or_else(|| "CLIProxyAPI binary path is not valid UTF-8".to_string())?;
    let provider_label = match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        _ => "subscription",
    };
    let flag = plan.flag;
    let started_note = if plan.needs_start {
        "CLIProxyAPI was stopped, so Jean started it."
    } else {
        "CLIProxyAPI is already running."
    };
    Ok(AccountLoginLaunch {
        provider: provider.to_string(),
        binary: binary.to_string(),
        args: plan.args,
        started_proxy: plan.needs_start,
        message: format!(
            "{started_note} Opening {provider_label} subscription login ({flag}). CLIProxyAPI stores the account in {}. Jean does not keep a copy and does not switch accounts.",
            plan.auth_dir.display()
        ),
    })
}

/// Start the sidecar again when the user left it enabled. Never enables it.
pub fn resume_if_enabled() {
    let Ok(home) = home_dir() else {
        return;
    };
    let paths = layout(&home);
    let Some(manifest) = read_manifest(&paths.manifest) else {
        return;
    };
    if !manifest.enabled || !paths.binary.is_file() || pid_is_cliproxy(&paths.pid) {
        return;
    }
    if let Err(error) = start_in_home(&home) {
        log::warn!("CLIProxyAPI did not resume: {error}");
    }
}

async fn download_latest(musl: bool) -> Result<(Vec<u8>, String, ReleaseAsset, String), String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let release: GitHubRelease = client
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Failed to fetch CLIProxyAPI release: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to fetch CLIProxyAPI release: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse CLIProxyAPI release: {error}"))?;
    let asset = select_release_asset(
        &release.assets,
        std::env::consts::OS,
        std::env::consts::ARCH,
        musl,
    )?;
    let checksums_url = release
        .assets
        .iter()
        .find(|item| item.name == "checksums.txt")
        .map(|item| item.browser_download_url.clone())
        .ok_or_else(|| "CLIProxyAPI release is missing checksums.txt".to_string())?;
    trusted_release_url(&checksums_url)?;
    let archive = download_bytes(&client, &asset.download_url, "CLIProxyAPI archive").await?;
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "CLIProxyAPI archive is larger than {MAX_ARCHIVE_BYTES} bytes"
        ));
    }
    let checksums = client
        .get(&checksums_url)
        .send()
        .await
        .map_err(|error| format!("Failed to download CLIProxyAPI checksums: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download CLIProxyAPI checksums: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Failed to read CLIProxyAPI checksums: {error}"))?;
    Ok((archive, checksums, asset, release.tag_name))
}

async fn download_bytes(
    client: &reqwest::Client,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    trusted_release_url(url)?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download {label}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download {label}: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Failed to read {label}: {error}"))?;
    Ok(bytes.to_vec())
}

fn verify_checksum(archive: &[u8], checksums: &str, asset_name: &str) -> Result<(), String> {
    let expected = checksums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let checksum = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (name == asset_name).then_some(checksum)
        })
        .ok_or_else(|| format!("Checksum for {asset_name} not found"))?;
    let actual = format!("{:x}", Sha256::digest(archive));
    if !expected.eq_ignore_ascii_case(&actual) {
        return Err(format!(
            "CLIProxyAPI checksum mismatch for {asset_name}: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn extract_binary(
    archive: &[u8],
    format: ArchiveFormat,
    binary_name: &str,
) -> Result<Vec<u8>, String> {
    match format {
        ArchiveFormat::Zip => extract_zip_binary(archive, binary_name),
        ArchiveFormat::TarGz => extract_tar_gz_binary(archive, binary_name),
    }
}

fn extract_zip_binary(archive: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|error| format!("Failed to open CLIProxyAPI zip: {error}"))?;
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|error| format!("Failed to read CLIProxyAPI zip entry: {error}"))?;
        if !file.is_file() {
            continue;
        }
        let Some(name) = file.enclosed_name().and_then(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        }) else {
            continue;
        };
        if name == binary_name {
            let mut binary = Vec::new();
            file.read_to_end(&mut binary)
                .map_err(|error| format!("Failed to read CLIProxyAPI binary from zip: {error}"))?;
            return Ok(binary);
        }
    }
    Err(format!("CLIProxyAPI binary {binary_name} not found in zip"))
}

fn extract_tar_gz_binary(archive: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(archive));
    let mut tar = tar::Archive::new(decoder);
    for entry in tar
        .entries()
        .map_err(|error| format!("Failed to read CLIProxyAPI tar entries: {error}"))?
    {
        let mut entry =
            entry.map_err(|error| format!("Failed to read CLIProxyAPI tar entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Failed to read CLIProxyAPI tar path: {error}"))?;
        if path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name == binary_name {
            let mut binary = Vec::new();
            entry
                .read_to_end(&mut binary)
                .map_err(|error| format!("Failed to read CLIProxyAPI binary from tar: {error}"))?;
            return Ok(binary);
        }
    }
    Err(format!(
        "CLIProxyAPI binary {binary_name} not found in tar.gz"
    ))
}

fn ensure_secret(path: &Path) -> Result<String, String> {
    refuse_symlink(path)?;
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    let secret = generate_secret();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    std::fs::write(path, &secret)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    set_mode(path, 0o600)?;
    Ok(secret)
}

fn generate_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ensure_config(
    paths: &InstallLayout,
    client_key: &str,
    management_key: &str,
) -> Result<(), String> {
    refuse_symlink(&paths.config)?;
    if paths.config.is_file() {
        return Ok(());
    }
    let rendered = render_config(client_key, management_key, &paths.auth_dir)?;
    std::fs::write(&paths.config, rendered)
        .map_err(|error| format!("Failed to write CLIProxyAPI config: {error}"))?;
    set_mode(&paths.config, 0o600)?;
    Ok(())
}

fn start_in_home(home: &Path) -> Result<(), String> {
    let paths = layout(home);
    if !paths.binary.is_file() {
        return Err("CLIProxyAPI binary is missing".to_string());
    }
    if !paths.config.is_file() {
        return Err("CLIProxyAPI config.yaml is missing".to_string());
    }
    if pid_is_cliproxy(&paths.pid) {
        return Ok(());
    }
    let port = configured_port(&paths);
    if port_is_open(port) {
        return Err(format!(
            "127.0.0.1:{port} is already in use. Jean will not take over a process it did not start."
        ));
    }
    let _ = std::fs::remove_file(&paths.pid);
    let pid = spawn_proxy(&paths)?;
    std::fs::write(&paths.pid, pid.to_string())
        .map_err(|error| format!("Failed to write CLIProxyAPI pid file: {error}"))?;
    std::thread::sleep(std::time::Duration::from_millis(400));
    if !pid_is_cliproxy(&paths.pid) {
        let _ = std::fs::remove_file(&paths.pid);
        return Err(format!(
            "process exited. {}",
            log_tail(&paths.log).unwrap_or_else(|| "No log output.".to_string())
        ));
    }
    Ok(())
}

fn stop_in_home(home: &Path) -> Result<(), String> {
    let paths = layout(home);
    if let Some(mut manifest) = read_manifest(&paths.manifest) {
        manifest.enabled = false;
        write_manifest(&paths.manifest, &manifest)?;
    }
    if let Some(pid) = read_pid(&paths.pid) {
        if pid_is_cliproxy(&paths.pid) {
            kill_process_tree(pid)
                .map_err(|error| format!("Failed to stop CLIProxyAPI: {error}"))?;
        }
    }
    let _ = std::fs::remove_file(&paths.pid);
    Ok(())
}

fn spawn_proxy(paths: &InstallLayout) -> Result<u32, String> {
    if let Some(parent) = paths.log.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create CLIProxyAPI log directory: {error}"))?;
    }
    let config = paths
        .config
        .to_str()
        .ok_or_else(|| "CLIProxyAPI config path is not valid UTF-8".to_string())?
        .to_string();
    #[cfg(unix)]
    {
        let args = vec!["--config".to_string(), config];
        crate::chat::detached::spawn_detached_process_with_env(
            &paths.binary,
            &args,
            &paths.log,
            &paths.dir,
            &[],
        )
    }
    #[cfg(not(unix))]
    {
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log)
            .map_err(|error| format!("Failed to open CLIProxyAPI log: {error}"))?;
        let stderr = log_file
            .try_clone()
            .map_err(|error| format!("Failed to duplicate CLIProxyAPI log: {error}"))?;
        let mut command = silent_command(&paths.binary);
        command
            .args(["--config", &config])
            .current_dir(&paths.dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(stderr));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            const DETACHED_PROCESS: u32 = 0x00000008;
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Failed to start CLIProxyAPI: {error}"))?;
        Ok(child.id())
    }
}

fn configured_port(paths: &InstallLayout) -> u16 {
    std::fs::read_to_string(&paths.config)
        .ok()
        .as_deref()
        .and_then(listener_from_yaml)
        .map(|listener| listener.port)
        .unwrap_or(DEFAULT_PORT)
}

fn port_is_open(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(200)).is_ok()
}

fn pid_is_cliproxy(pid_path: &Path) -> bool {
    let Some(pid) = read_pid(pid_path) else {
        return false;
    };
    if pid == 0 || !is_process_alive(pid) {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(bytes) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        String::from_utf8_lossy(&bytes).contains("cli-proxy-api")
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

fn read_manifest(path: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create CLIProxyAPI manifest directory: {error}"))?;
    }
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to encode CLIProxyAPI manifest: {error}"))?;
    std::fs::write(path, json)
        .map_err(|error| format!("Failed to write CLIProxyAPI manifest: {error}"))?;
    Ok(())
}

fn login_hint(paths: &InstallLayout) -> String {
    format!(
        "Add Claude or Codex subscription accounts from Preferences → Opinionated → CLIProxyAPI. Jean runs `{} --config {} -claude-login` or `-codex-login` and does not store those logins. Tokens stay in {}. Management page: {} (key file: {}).",
        paths.binary.display(),
        paths.config.display(),
        paths.auth_dir.display(),
        management_url(configured_port(paths)),
        paths.management_key.display()
    )
}

/// Count CLIProxyAPI auth files by name. Does not open them.
fn count_auth_files(dir: &Path) -> u32 {
    let Ok(metadata) = std::fs::symlink_metadata(dir) else {
        return 0;
    };
    if !metadata.file_type().is_dir() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return false;
            };
            metadata.file_type().is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        })
        .count() as u32
}

fn log_tail(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let tail = trimmed.chars().rev().take(400).collect::<String>();
    let tail = tail.chars().rev().collect::<String>();
    Some(tail)
}

fn refuse_symlink(path: &Path) -> Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{} is a symlink; Jean will not follow it",
            path.display()
        ));
    }
    Ok(())
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .map_err(|error| format!("Failed to read permissions for {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(mode);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to set permissions on {}: {error}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn linux_uses_musl() -> bool {
    if Path::new("/lib/ld-musl-x86_64.so.1").exists()
        || Path::new("/lib/ld-musl-aarch64.so.1").exists()
    {
        return true;
    }
    let Ok(output) = silent_command("ldd").arg("--version").output() else {
        return false;
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.to_ascii_lowercase().contains("musl")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_assets() -> Vec<GitHubAsset> {
        [
            "CLIProxyAPI_8.0.43_linux_amd64.tar.gz",
            "CLIProxyAPI_8.0.43_linux_amd64_no-plugin.tar.gz",
            "CLIProxyAPI_8.0.43_linux_aarch64.tar.gz",
            "CLIProxyAPI_8.0.43_darwin_aarch64.tar.gz",
            "CLIProxyAPI_8.0.43_darwin_amd64.tar.gz",
            "CLIProxyAPI_8.0.43_windows_amd64.zip",
            "CLIProxyAPI_8.0.43_windows_aarch64.zip",
        ]
        .into_iter()
        .map(|name| GitHubAsset {
            browser_download_url: format!(
                "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.43/{name}"
            ),
            name: name.to_string(),
        })
        .collect()
    }

    #[test]
    fn selects_official_archive_without_the_musl_build_on_glibc() {
        let asset =
            select_release_asset(&sample_assets(), "linux", "x86_64", false).expect("asset");
        assert_eq!(asset.name, "CLIProxyAPI_8.0.43_linux_amd64.tar.gz");
        assert_eq!(asset.format, ArchiveFormat::TarGz);
    }

    #[test]
    fn selects_no_plugin_archive_for_musl() {
        let asset = select_release_asset(&sample_assets(), "linux", "aarch64", true);
        assert!(asset.is_err());
        let asset = select_release_asset(&sample_assets(), "linux", "x86_64", true).expect("asset");
        assert_eq!(
            asset.name,
            "CLIProxyAPI_8.0.43_linux_amd64_no-plugin.tar.gz"
        );
    }

    #[test]
    fn selects_darwin_and_windows_archives() {
        assert_eq!(
            select_release_asset(&sample_assets(), "macos", "aarch64", false)
                .expect("mac")
                .name,
            "CLIProxyAPI_8.0.43_darwin_aarch64.tar.gz"
        );
        assert_eq!(
            select_release_asset(&sample_assets(), "windows", "x86_64", false)
                .expect("windows")
                .name,
            "CLIProxyAPI_8.0.43_windows_amd64.zip"
        );
    }

    #[test]
    fn refuses_untrusted_download_urls() {
        let mut assets = sample_assets();
        assets[0].browser_download_url = "http://example.com/cli-proxy-api.tar.gz".to_string();
        let error = select_release_asset(&assets, "linux", "x86_64", false).expect_err("reject");
        assert!(error.contains("Refusing"));
    }

    #[test]
    fn config_binds_localhost_and_keeps_management_local() {
        let yaml = render_config(
            "client-secret",
            "management-secret",
            Path::new("/tmp/jean-auths"),
        )
        .expect("yaml");
        let listener = listener_from_yaml(&yaml).expect("listener");
        assert_eq!(listener.host, "127.0.0.1");
        assert_eq!(listener.port, 8317);
        assert!(listener.loopback_only);
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("parse");
        assert_eq!(
            value["server"]["discovery"]["enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(value["management"]["allow-remote"].as_bool(), Some(false));
        assert_eq!(value["routing"]["strategy"].as_str(), Some("round-robin"));
        assert_eq!(
            value["access"]["api-keys"][0].as_str(),
            Some("client-secret")
        );
        assert!(!yaml.contains("0.0.0.0"));
        assert_eq!(
            management_url(listener.port),
            "http://127.0.0.1:8317/management.html"
        );
    }

    #[test]
    fn empty_or_wildcard_host_is_not_treated_as_localhost() {
        let wildcard = listener_from_yaml("server:\n  host: \"\"\n  port: 8317\n").expect("parse");
        assert!(!wildcard.loopback_only);
        let all = listener_from_yaml("host: 0.0.0.0\nport: 8317\n").expect("legacy");
        assert!(!all.loopback_only);
        assert_eq!(all.port, 8317);
    }

    #[test]
    fn existing_config_is_left_in_place() {
        let temp = tempfile::tempdir().expect("temp");
        let home = temp.path();
        let paths = layout(home);
        std::fs::create_dir_all(&paths.dir).expect("dir");
        std::fs::write(&paths.config, "server:\n  host: 0.0.0.0\n  port: 8317\n").expect("config");
        ensure_config(&paths, "new-client", "new-management").expect("keep");
        let text = std::fs::read_to_string(&paths.config).expect("read");
        assert!(text.contains("0.0.0.0"));
        assert!(!text.contains("new-client"));
    }

    #[test]
    fn claude_profile_points_at_localhost_without_permission_bypass() {
        let json = claude_settings_json("local-key");
        let value: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(
            value["env"]["ANTHROPIC_BASE_URL"].as_str(),
            Some(CLAUDE_BASE_URL)
        );
        assert_eq!(
            value["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
            Some("local-key")
        );
        assert!(!json.contains("bypassPermissions"));
        let provider = codex_provider();
        assert_eq!(provider.base_url, CODEX_BASE_URL);
        assert_eq!(provider.wire_api.as_deref(), Some("responses"));
        assert_eq!(provider.env_key, CODEX_ENV_KEY);
    }

    #[test]
    fn upsert_refreshes_profiles_without_duplicating_or_changing_defaults() {
        let mut claude = vec![CustomCliProfile {
            name: "OpenRouter".to_string(),
            settings_json: "{}".to_string(),
            file_path: String::new(),
            supports_thinking: Some(true),
        }];
        let mut codex = Vec::new();
        upsert_provider_profiles(&mut claude, &mut codex, "key-a");
        upsert_provider_profiles(&mut claude, &mut codex, "key-b");
        assert_eq!(claude.len(), 2);
        assert_eq!(codex.len(), 1);
        assert!(claude
            .iter()
            .find(|profile| profile.name == PROFILE_NAME)
            .expect("profile")
            .settings_json
            .contains("key-b"));
        assert_eq!(codex[0].provider_id, CODEX_PROVIDER_ID);
    }

    #[test]
    fn detach_removes_only_the_cliproxy_profiles_and_defaults() {
        let mut claude = vec![
            CustomCliProfile {
                name: PROFILE_NAME.to_string(),
                settings_json: "{}".to_string(),
                file_path: String::new(),
                supports_thinking: Some(true),
            },
            CustomCliProfile {
                name: "OpenRouter".to_string(),
                settings_json: "{}".to_string(),
                file_path: String::new(),
                supports_thinking: Some(true),
            },
        ];
        let mut codex = vec![codex_provider()];
        let mut default_provider = Some(PROFILE_NAME.to_string());
        let mut default_codex = Some(PROFILE_NAME.to_string());
        assert!(detach_provider_profiles(
            &mut claude,
            &mut codex,
            &mut default_provider,
            &mut default_codex
        ));
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].name, "OpenRouter");
        assert!(codex.is_empty());
        assert!(default_provider.is_none());
        assert!(default_codex.is_none());
    }

    #[test]
    fn checksum_must_match_the_archive_name() {
        let archive = b"not-a-real-archive";
        let actual = format!("{:x}", Sha256::digest(archive));
        verify_checksum(
            archive,
            &format!("{actual}  CLIProxyAPI_8.0.43_linux_amd64.tar.gz\n"),
            "CLIProxyAPI_8.0.43_linux_amd64.tar.gz",
        )
        .expect("match");
        let error = verify_checksum(
            archive,
            "deadbeef  CLIProxyAPI_8.0.43_linux_amd64.tar.gz\n",
            "CLIProxyAPI_8.0.43_linux_amd64.tar.gz",
        )
        .expect_err("mismatch");
        assert!(error.contains("checksum mismatch"));
    }

    #[test]
    fn extracts_the_named_binary_from_a_tar_gz() {
        let archive = tar_gz_with_file("cli-proxy-api", b"#!/bin/sh\necho cliproxy\n");
        let binary =
            extract_binary(&archive, ArchiveFormat::TarGz, "cli-proxy-api").expect("binary");
        assert!(binary.starts_with(b"#!/bin/sh"));
    }

    #[test]
    fn codex_env_reads_the_client_key_file() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = layout(temp.path());
        std::fs::create_dir_all(&paths.dir).expect("dir");
        std::fs::write(&paths.client_key, "abc123\n").expect("key");
        assert_eq!(
            codex_process_env_from_home(temp.path()),
            vec![("CLIPROXYAPI_API_KEY".to_string(), "abc123".to_string())]
        );
    }

    #[test]
    fn install_layout_lives_under_jean_opinionated() {
        let paths = layout(Path::new("/home/ada"));
        assert_eq!(
            paths.dir,
            PathBuf::from("/home/ada/.jean/opinionated/cliproxyapi")
        );
        assert_eq!(paths.config, paths.dir.join("config.yaml"));
        assert_eq!(paths.auth_dir, paths.dir.join("auths"));
    }

    #[test]
    fn account_login_flags_are_only_claude_and_codex() {
        assert_eq!(
            account_login_flag("claude").expect("claude"),
            "-claude-login"
        );
        assert_eq!(account_login_flag("codex").expect("codex"), "-codex-login");
        let error = account_login_flag("gemini").expect_err("reject");
        assert!(error.contains("claude or codex"));
    }

    #[test]
    fn account_login_args_point_at_the_managed_config() {
        let config = Path::new("/home/ada/.jean/opinionated/cliproxyapi/config.yaml");
        let args = account_login_args(config, "codex").expect("args");
        assert_eq!(
            args,
            vec![
                "--config".to_string(),
                config.to_string_lossy().to_string(),
                "-codex-login".to_string(),
            ]
        );
        assert!(args.iter().all(|arg| !arg.contains("management-key")));
        assert!(args.iter().all(|arg| !arg.contains("client-key")));
    }

    #[test]
    fn account_login_requires_the_managed_binary_and_config() {
        let temp = tempfile::tempdir().expect("temp");
        let error = plan_account_login(temp.path(), "claude").expect_err("missing");
        assert!(error.contains("not installed"));

        let paths = layout(temp.path());
        std::fs::create_dir_all(&paths.dir).expect("dir");
        std::fs::write(&paths.binary, b"").expect("binary");
        let error = plan_account_login(temp.path(), "claude").expect_err("config");
        assert!(error.contains("config.yaml"));

        std::fs::write(&paths.config, "server:\n  host: 127.0.0.1\n  port: 8317\n")
            .expect("config");
        let plan = plan_account_login(temp.path(), "claude").expect("plan");
        assert!(plan.needs_start);
        assert_eq!(plan.flag, "-claude-login");
        assert_eq!(plan.args[2], "-claude-login");
        assert_eq!(plan.binary, paths.binary);
        assert_eq!(plan.auth_dir, paths.auth_dir);
    }

    #[cfg(unix)]
    #[test]
    fn account_login_refuses_a_symlinked_binary() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = layout(temp.path());
        std::fs::create_dir_all(&paths.dir).expect("dir");
        let real = temp.path().join("real-binary");
        std::fs::write(&real, b"#!/bin/sh\n").expect("real");
        std::os::unix::fs::symlink(&real, &paths.binary).expect("symlink");
        std::fs::write(&paths.config, "server:\n  host: 127.0.0.1\n").expect("config");
        let error = plan_account_login(temp.path(), "codex").expect_err("symlink");
        assert!(error.contains("symlink"));
    }

    #[test]
    fn auth_file_count_ignores_directories_symlinks_and_non_json() {
        let temp = tempfile::tempdir().expect("temp");
        let dir = temp.path().join("auths");
        assert_eq!(count_auth_files(&dir), 0);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("claude-a.json"), b"{}").expect("json");
        std::fs::write(dir.join("notes.txt"), b"ignore").expect("txt");
        std::fs::create_dir(dir.join("nested.json")).expect("dir name");
        assert_eq!(count_auth_files(&dir), 1);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("claude-a.json"), dir.join("linked.json"))
                .expect("file symlink");
            assert_eq!(count_auth_files(&dir), 1);
            let link = temp.path().join("auths-link");
            std::os::unix::fs::symlink(&dir, &link).expect("dir symlink");
            assert_eq!(count_auth_files(&link), 0);
        }
    }

    fn tar_gz_with_file(name: &str, contents: &[u8]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, name, contents)
            .expect("append");
        let encoder = builder.into_inner().expect("builder");
        encoder.finish().expect("gzip")
    }
}

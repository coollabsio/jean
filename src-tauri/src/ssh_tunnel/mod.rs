//! Jean-managed SSH local forwards for loopback-only remote jean-server.
//!
//! Desktop profiles choose a direct Web Access URL or this tunnel. The tunnel
//! is `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<jean-port>`. Password auth is out
//! of scope. Tokens stay in the OS credential store on macOS and Windows, and
//! in a user-only app-data file on Linux.
//!
//! The embedded browser runs on the desktop. While a profile tunnel is ready,
//! preview forwards open additional `ssh -N -L` sessions to the remote host's
//! loopback so `localhost` ports from jean.json reach that host.

mod args;
mod hostkey;
mod secrets;
mod supervisor;

pub use supervisor::{
    normalize_spec, HostKeyPreview, LoadedSshSecret, PreviewForwardPayload, SshTunnelSupervisor,
    StartSshTunnelInput, TrustHostKeyInput, TunnelSpec, TunnelStatusPayload,
};

pub(crate) use args::redact;

use std::time::Duration;
use tauri::State;

#[tauri::command]
pub async fn preview_ssh_host_key(
    tunnels: State<'_, SshTunnelSupervisor>,
    user: String,
    host: String,
    ssh_port: Option<u16>,
) -> Result<HostKeyPreview, String> {
    let tunnels = (*tunnels).clone();
    let port = ssh_port.unwrap_or(args::DEFAULT_SSH_PORT);
    tokio::task::spawn_blocking(move || tunnels.preview(&user, &host, port))
        .await
        .map_err(|error| format!("SSH host key task failed: {error}"))?
}

#[tauri::command]
pub async fn trust_ssh_host_key(
    tunnels: State<'_, SshTunnelSupervisor>,
    host: String,
    canonical_host: String,
    port: u16,
    key_type: String,
    public_key: String,
    fingerprint: String,
) -> Result<(), String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || {
        tunnels.trust(&TrustHostKeyInput {
            host,
            canonical_host,
            port,
            key_type,
            public_key,
            fingerprint,
        })
    })
    .await
    .map_err(|error| format!("SSH host key task failed: {error}"))?
}

#[tauri::command]
pub async fn test_ssh_tunnel_auth(
    tunnels: State<'_, SshTunnelSupervisor>,
    user: String,
    host: String,
    ssh_port: Option<u16>,
    identity_file: Option<String>,
    host_key_fingerprint: String,
) -> Result<String, String> {
    let tunnels = (*tunnels).clone();
    let port = ssh_port.unwrap_or(args::DEFAULT_SSH_PORT);
    tokio::task::spawn_blocking(move || {
        tunnels.test_auth(
            &user,
            &host,
            port,
            identity_file.as_deref(),
            &host_key_fingerprint,
        )
    })
    .await
    .map_err(|error| format!("SSH test task failed: {error}"))?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_ssh_tunnel(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_id: String,
    user: String,
    host: String,
    ssh_port: Option<u16>,
    identity_file: Option<String>,
    remote_host: Option<String>,
    remote_port: Option<u16>,
    local_port: Option<u16>,
    host_key_fingerprint: String,
) -> Result<TunnelStatusPayload, String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || {
        let spec = normalize_spec(&StartSshTunnelInput {
            profile_id,
            user,
            host,
            ssh_port,
            identity_file,
            remote_host,
            remote_port,
            local_port,
            host_key_fingerprint,
        })?;
        let profile_id = spec.profile_id.clone();
        tunnels.start(spec)?;
        Ok(tunnels
            .list_status()
            .into_iter()
            .find(|status| status.profile_id == profile_id)
            .unwrap_or(TunnelStatusPayload {
                profile_id,
                status: "connecting".into(),
                local_url: None,
                local_port: None,
                error: None,
                attempt: 0,
            }))
    })
    .await
    .map_err(|error| format!("SSH tunnel task failed: {error}"))?
}

#[tauri::command]
pub async fn stop_ssh_tunnel(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_id: String,
) -> Result<(), String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || tunnels.stop(&profile_id))
        .await
        .map_err(|error| format!("SSH tunnel task failed: {error}"))?
}

#[tauri::command]
pub async fn list_ssh_tunnel_status(
    tunnels: State<'_, SshTunnelSupervisor>,
) -> Result<Vec<TunnelStatusPayload>, String> {
    Ok(tunnels.list_status())
}

#[tauri::command]
pub async fn store_ssh_profile_secret(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_id: String,
    token: String,
) -> Result<(), String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || {
        let result = tunnels.store_secret(&profile_id, &token);
        // Drop the token copy before returning. Never log it.
        drop(token);
        result
    })
    .await
    .map_err(|error| format!("SSH token task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_ssh_profile_secret(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_id: String,
) -> Result<(), String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || tunnels.delete_secret(&profile_id))
        .await
        .map_err(|error| format!("SSH token task failed: {error}"))?
}

#[tauri::command]
pub async fn ensure_ssh_preview_forward(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_id: String,
    remote_port: u16,
) -> Result<PreviewForwardPayload, String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || tunnels.ensure_preview_forward(&profile_id, remote_port))
        .await
        .map_err(|error| format!("SSH preview forward task failed: {error}"))?
}

#[tauri::command]
pub async fn release_ssh_preview_forwards(
    tunnels: State<'_, SshTunnelSupervisor>,
    keep_profile_id: Option<String>,
) -> Result<(), String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || {
        if let Some(profile_id) = keep_profile_id.as_deref() {
            secrets::validate_profile_id(profile_id)?;
        }
        tunnels.release_preview_forwards(keep_profile_id.as_deref());
        Ok(())
    })
    .await
    .map_err(|error| format!("SSH preview forward task failed: {error}"))?
}

#[tauri::command]
pub async fn load_ssh_profile_secrets(
    tunnels: State<'_, SshTunnelSupervisor>,
    profile_ids: Vec<String>,
) -> Result<Vec<LoadedSshSecret>, String> {
    let tunnels = (*tunnels).clone();
    tokio::task::spawn_blocking(move || tunnels.load_secrets(&profile_ids))
        .await
        .map_err(|error| format!("SSH token task failed: {error}"))?
}

/// Used by install-via-SSH after the server is provisioned loopback-only.
pub fn start_tunnel_and_wait(
    tunnels: &SshTunnelSupervisor,
    spec: TunnelSpec,
) -> Result<TunnelStatusPayload, String> {
    tunnels.start_and_wait_ready(spec, Duration::from_secs(60))
}

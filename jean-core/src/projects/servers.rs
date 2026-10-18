//! Server projects: SSH targets managed through a chat session.
//!
//! A server is a `Project` with `server: Some(ProjectServer)`. Jean gives it a
//! local scratch folder (`<app-data>/servers/<id>`) and one base worktree, so
//! the normal session/chat pipeline works unchanged. The AI reaches the host
//! with `ssh` from the machine where Jean (or jean-server) runs.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use uuid::Uuid;

use super::storage::{load_projects_data, save_projects_data};
use super::types::{Project, ProjectServer};

const SERVER_PROMPT_COMMAND: &str = "{ssh_command}";
const SERVER_PROMPT_NAME: &str = "{server_name}";
const SERVER_PROMPT_CONNECTION: &str = "{connection}";

pub(crate) fn default_server_system_prompt() -> String {
    r#"You help the user inspect and manage the server "{server_name}".
{connection}
Default to read-only work: status, logs, configs, processes, disk, network, containers.
Do not change the server (write files, restart services, install or remove packages, delete data) unless the user asks for it. Before a change, show the exact command and its impact.
Keep commands non-interactive and bounded (for example `--no-pager`, `tail -n 200`). Do not print secrets.
If a command needs root, try `sudo -n <command>`. If sudo denies it, tell the user what access is missing; do not work around it."#
        .to_string()
}

fn validate_ssh_token(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} is required."));
    }
    if value.starts_with('-')
        || value
            .chars()
            .any(|c| c.is_whitespace() || "'\"`$;&|<>\\".contains(c))
    {
        return Err(format!("{label} contains invalid characters."));
    }
    Ok(())
}

/// The key path goes into a single-quoted shell argument of the AI's ssh
/// command, so it must be an absolute path without quotes or line breaks.
fn validate_identity_file(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).is_absolute()
        || path.chars().any(|c| c == '\'' || c == '\n' || c == '\r')
    {
        return Err("SSH key path is invalid.".to_string());
    }
    Ok(())
}

fn normalize_server(mut server: ProjectServer) -> Result<ProjectServer, String> {
    if server.local {
        return Ok(ProjectServer {
            local: true,
            ..Default::default()
        });
    }
    server.host = server.host.trim().to_string();
    validate_ssh_token("Host", &server.host)?;
    server.user = server
        .user
        .map(|user| user.trim().to_string())
        .filter(|user| !user.is_empty());
    if let Some(user) = server.user.as_deref() {
        validate_ssh_token("User", user)?;
    }
    if server.port == Some(0) {
        return Err("Port must be between 1 and 65535.".to_string());
    }
    server.identity_file = server
        .identity_file
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(path) = server.identity_file.as_deref() {
        validate_identity_file(path)?;
    }
    server.jean_connection_id = server
        .jean_connection_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    Ok(server)
}

/// `<app-data>/servers/<project-id>`: the local working folder of a server.
fn server_scratch_path(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join("servers")
        .join(project_id))
}

fn server_scratch_dir(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = server_scratch_path(app, project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create server folder: {e}"))?;
    Ok(dir)
}

/// Create or update a server project.
///
/// Updates the server with `project_id`, or creates a new one. A new server also gets its base worktree so it can open a session at once.
pub async fn save_server_project(
    app: AppHandle,
    project_id: Option<String>,
    name: String,
    server: ProjectServer,
    parent_id: Option<String>,
    system_prompt: Option<String>,
) -> Result<Project, String> {
    // Server-scoped system prompt (project custom prompt). None = unchanged.
    let system_prompt = system_prompt.map(|prompt| prompt.trim().to_string());
    let mut data = load_projects_data(&app)?;
    let existing_id = project_id.filter(|id| data.find_project(id).is_some());

    if let Some(id) = existing_id {
        let project = data
            .find_project_mut(&id)
            .ok_or_else(|| format!("Project not found: {id}"))?;
        let Some(existing) = project.server.clone() else {
            return Err("Project is not a server.".to_string());
        };
        // The built-in local entry keeps its connection; only name and prompt change.
        let server = if existing.local {
            existing
        } else {
            normalize_server(server)?
        };
        if let Some(name) = Some(name.trim()).filter(|name| !name.is_empty()) {
            project.name = name.to_string();
        }
        project.server = Some(server);
        if let Some(prompt) = system_prompt {
            project.custom_system_prompt = Some(prompt).filter(|p| !p.is_empty());
        }
        let project = project.clone();
        save_projects_data(&app, &data)?;
        return Ok(project);
    }

    if server.local {
        return Err("The local server is built in and cannot be created.".to_string());
    }
    let server = normalize_server(server)?;
    let name = match name.trim() {
        "" => server.host.clone(),
        name => name.to_string(),
    };
    let system_prompt = system_prompt.filter(|prompt| !prompt.is_empty());
    create_server_project(app, data, name, server, parent_id, system_prompt).await
}

/// Make sure the built-in "Local" server exists (the machine Jean runs on).
pub async fn ensure_local_server_project(app: AppHandle) -> Result<Project, String> {
    let data = load_projects_data(&app)?;
    if let Some(project) = data
        .projects
        .iter()
        .find(|p| p.server.as_ref().is_some_and(|s| s.local))
    {
        return Ok(project.clone());
    }
    let server = ProjectServer {
        local: true,
        ..Default::default()
    };
    let name = machine_hostname().unwrap_or_else(|| "Local".to_string());
    create_server_project(app, data, name, server, None, None).await
}

/// Hostname of the machine Jean runs on (jean-server host in Web Access).
fn machine_hostname() -> Option<String> {
    let output = crate::platform::silent_command("hostname").output().ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !name.is_empty()).then_some(name)
}

async fn create_server_project(
    app: AppHandle,
    mut data: super::types::ProjectsData,
    name: String,
    server: ProjectServer,
    parent_id: Option<String>,
    system_prompt: Option<String>,
) -> Result<Project, String> {
    let id = Uuid::new_v4().to_string();
    let path = server_scratch_dir(&app, &id)?.to_string_lossy().to_string();
    let project = Project {
        id: id.clone(),
        name,
        path,
        default_branch: "server".to_string(),
        added_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        order: data.get_next_order(parent_id.as_deref()),
        parent_id,
        is_folder: false,
        avatar_path: None,
        default_avatar_path: None,
        enabled_mcp_servers: None,
        known_mcp_servers: Vec::new(),
        custom_system_prompt: system_prompt,
        default_provider: None,
        default_backend: None,
        worktrees_dir: None,
        linear_api_key: None,
        linear_team_id: None,
        sentry_auth_token: None,
        sentry_organization_slug: None,
        sentry_project_slug: None,
        sentry_base_url: None,
        linked_project_ids: Vec::new(),
        auto_fix_settings: None,
        server: Some(server),
    };
    data.add_project(project.clone());
    save_projects_data(&app, &data)?;
    // First session starts in the server default mode (see `create_session`),
    // not in an implicit "Session 1" that would inherit the global default.
    let worktree = super::create_base_session(app.clone(), id).await?;
    crate::chat::storage::save_empty_index(&app, &worktree.id)?;
    crate::chat::create_session(
        app,
        worktree.id,
        worktree.path,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    Ok(project)
}

/// Remove a server project, its sessions, and its scratch folder.
pub async fn remove_server_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();
    match project.server.as_ref() {
        None => return Err("Project is not a server.".to_string()),
        Some(server) if server.local => {
            return Err("The local server is built in and cannot be removed.".to_string())
        }
        Some(_) => {}
    }
    let worktree_ids: Vec<String> = data
        .worktrees_for_project(&project_id)
        .into_iter()
        .map(|w| w.id.clone())
        .collect();
    for worktree_id in worktree_ids {
        super::close_base_session_clean(app.clone(), worktree_id).await?;
    }
    super::remove_project(app.clone(), project_id.clone()).await?;
    // Delete only Jean's own scratch folder, never any other path.
    if let Ok(scratch) = server_scratch_path(&app, &project_id) {
        if std::path::Path::new(&project.path) == scratch {
            let _ = std::fs::remove_dir_all(&scratch);
        }
    }
    Ok(())
}

// =============================================================================
// Restricted user setup
// =============================================================================

/// A public key on the machine that runs `ssh` (local Jean or jean-server).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPublicKey {
    pub path: String,
    pub key_type: String,
    pub comment: String,
    pub content: String,
}

/// Sudo access for the user that Jean creates on a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerUserAccess {
    /// No sudo. Log groups only (adm, systemd-journal).
    None,
    /// Log groups + passwordless sudo for an allowlist of read-only commands.
    Readonly,
    /// Passwordless sudo for all commands (not recommended).
    Full,
}

/// List `~/.ssh/*.pub` on this machine.
pub async fn list_ssh_public_keys() -> Result<Vec<SshPublicKey>, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "Could not determine the home directory".to_string())?
        .join(".ssh");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut keys: Vec<SshPublicKey> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "pub"))
        .filter_map(|path| {
            let content = std::fs::read_to_string(&path).ok()?.trim().to_string();
            validate_public_key(&content).ok()?;
            let mut parts = content.split_whitespace();
            let key_type = parts.next()?.to_string();
            let comment = parts.skip(1).collect::<Vec<_>>().join(" ");
            Some(SshPublicKey {
                path: path.to_string_lossy().to_string(),
                key_type,
                comment,
                content,
            })
        })
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(keys)
}

/// Private key file next to the local `.pub` file with this content.
async fn public_key_identity_file(public_key: &str) -> Option<String> {
    let public_key = public_key.trim();
    list_ssh_public_keys()
        .await
        .ok()?
        .into_iter()
        .find(|key| key.content == public_key)
        .and_then(|key| key.path.strip_suffix(".pub").map(str::to_string))
        .filter(|path| std::path::Path::new(path).is_file())
}

fn validate_public_key(key: &str) -> Result<(), String> {
    let key_type = key.split_whitespace().next().unwrap_or_default();
    let known_type = key_type.starts_with("ssh-")
        || key_type.starts_with("ecdsa-")
        || key_type.starts_with("sk-");
    if !known_type || key.split_whitespace().count() < 2 {
        return Err("Not an OpenSSH public key.".to_string());
    }
    if key.chars().any(|c| c == '\'' || c == '\n' || c == '\r') {
        return Err("Public key contains invalid characters.".to_string());
    }
    Ok(())
}

fn validate_unix_user(user: &str) -> Result<(), String> {
    let mut chars = user.chars();
    let valid = user.len() <= 32
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if valid && user != "root" {
        Ok(())
    } else {
        Err("User name must be lowercase (a-z, 0-9, _ or -) and not root.".to_string())
    }
}

/// POSIX sh script, run as root on the server. Idempotent: it creates the
/// user if needed, adds the key once, and replaces Jean's sudoers file.
pub async fn server_user_setup_script(
    user: String,
    public_key: String,
    access: ServerUserAccess,
) -> Result<String, String> {
    let user = user.trim();
    let public_key = public_key.trim();
    validate_unix_user(user)?;
    validate_public_key(public_key)?;
    let mode = match access {
        ServerUserAccess::None => "none",
        ServerUserAccess::Readonly => "readonly",
        ServerUserAccess::Full => "full",
    };
    Ok(format!(
        r#"#!/bin/sh
# Jean: create a restricted SSH user. Run as root.
set -eu
U='{user}'
KEY='{public_key}'
MODE='{mode}'
SUDOERS="/etc/sudoers.d/jean-$U"
[ "$(id -u)" -eq 0 ] || {{ echo "Run this script as root." >&2; exit 1; }}

if ! id "$U" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    SHELL_BIN=/bin/sh; [ -x /bin/bash ] && SHELL_BIN=/bin/bash
    useradd -m -s "$SHELL_BIN" "$U"
  else
    adduser -D -s /bin/sh "$U"
  fi
fi
passwd -l "$U" >/dev/null 2>&1 || true

HOME_DIR=$(eval echo "~$U")
mkdir -p "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$KEY" "$HOME_DIR/.ssh/authorized_keys" || printf '%s\n' "$KEY" >> "$HOME_DIR/.ssh/authorized_keys"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
chown -R "$U" "$HOME_DIR/.ssh"

# Read logs without sudo. Do not use the docker group: it is root-equivalent.
for G in adm systemd-journal; do
  if grep -q "^$G:" /etc/group; then
    if command -v usermod >/dev/null 2>&1; then usermod -aG "$G" "$U"; else addgroup "$U" "$G"; fi
  fi
done

if [ "$MODE" = none ]; then
  rm -f "$SUDOERS"
else
  command -v sudo >/dev/null 2>&1 || {{ echo "sudo is not installed. Install it, or use access 'none'." >&2; exit 1; }}
  if [ "$MODE" = full ]; then
    RULES="$U ALL=(root) NOPASSWD: ALL"
  else
    CMDS=""
    add() {{ P=$(command -v "$1" 2>/dev/null) || return 0; shift; CMDS="$CMDS${{CMDS:+, }}$P $*"; }}
    add docker 'ps *'; add docker 'logs *'; add docker 'inspect *'; add docker 'stats --no-stream *'
    add docker 'compose ls *'; add docker 'compose ps *'; add docker 'compose logs *'
    add ss '-tulpn'
    RULES=""
    [ -n "$CMDS" ] && RULES="$U ALL=(root) NOPASSWD: $CMDS"
    S=$(command -v systemctl 2>/dev/null || true)
    # NOEXEC blocks a shell escape from the pager.
    [ -n "$S" ] && RULES="${{RULES:+$RULES
}}$U ALL=(root) NOPASSWD:NOEXEC: $S status *, $S list-units *, $S --failed *"
  fi
  TMP=$(mktemp)
  printf '%s\n' "$RULES" > "$TMP"
  visudo -cf "$TMP" >/dev/null
  cp "$TMP" "$SUDOERS"
  chmod 0440 "$SUDOERS"
  rm -f "$TMP"
fi
echo "Jean user '$U' is ready (access: $MODE)."
"#
    ))
}

/// Connect as `root_user` (key auth), run the setup script, then switch the
/// server project to the new user.
pub async fn setup_server_user(
    app: AppHandle,
    project_id: String,
    root_user: String,
    user: String,
    public_key: String,
    access: ServerUserAccess,
) -> Result<Project, String> {
    let root_user = root_user.trim().to_string();
    validate_ssh_token("Root user", &root_user)?;
    let script = server_user_setup_script(user.clone(), public_key.clone(), access).await?;
    let data = load_projects_data(&app)?;
    let server = data
        .find_project(&project_id)
        .and_then(|p| p.server.clone())
        .ok_or_else(|| "Server not found.".to_string())?;
    if server.local {
        return Err("The local server does not use SSH.".to_string());
    }

    let target = ProjectServer {
        user: Some(root_user),
        ..server.clone()
    };
    let port = target.port.unwrap_or(22).to_string();
    let output = tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut child = crate::platform::silent_command("ssh")
            .args(target.identity_args())
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "ConnectTimeout=15",
                "-p",
                &port,
                &target.destination(),
                "sh -s",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run ssh: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(script.as_bytes())
                .map_err(|e| format!("Failed to send setup script: {e}"))?;
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed to run ssh: {e}"))
    })
    .await
    .map_err(|e| format!("Setup task failed: {e}"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Setup failed (exit {:?}).", output.status.code())
        } else {
            format!("Setup failed: {detail}")
        });
    }

    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    if let Some(server) = project.server.as_mut() {
        server.user = Some(user.trim().to_string());
        // A pinned key must be the one the new user accepts.
        if server.identity_file.is_some() {
            if let Some(path) = public_key_identity_file(&public_key).await {
                server.identity_file = Some(path);
            }
        }
    }
    let project = project.clone();
    save_projects_data(&app, &data)?;
    Ok(project)
}

/// Fill the server prompt placeholders.
fn render_server_system_prompt(
    template: &str,
    project: &Project,
    server: &ProjectServer,
) -> String {
    let (ssh_command, connection) = if server.local {
        (
            String::new(),
            "This is the machine Jean runs on (for Web Access, the Jean server host). Run commands directly in the local shell, without SSH. The working directory is only a scratch folder.".to_string(),
        )
    } else {
        let ssh_command = server.ssh_command();
        let connection = format!(
            "Run every server command through SSH from this machine: `{ssh_command} '<command>'`. The local working directory is only a scratch folder."
        );
        (ssh_command, connection)
    };
    template
        .replace(SERVER_PROMPT_CONNECTION, &connection)
        .replace(SERVER_PROMPT_COMMAND, &ssh_command)
        .replace(SERVER_PROMPT_NAME, &project.name)
}

/// System prompt that replaces the global system prompt for sessions of a
/// server project. `None` for normal git projects.
pub(crate) fn server_system_prompt(app: &AppHandle, worktree_id: &str) -> Option<String> {
    let data = load_projects_data(app).ok()?;
    let worktree = data.find_worktree(worktree_id)?;
    let project = data.find_project(&worktree.project_id)?;
    let server = project.server.as_ref()?;
    let custom = crate::load_preferences_sync(app)
        .ok()
        .and_then(|prefs| prefs.magic_prompts.server_system_prompt)
        .map(|prompt| prompt.trim().to_string())
        .filter(|prompt| !prompt.is_empty());
    let template = custom.unwrap_or_else(default_server_system_prompt);
    Some(render_server_system_prompt(&template, project, server))
}

/// IDs of worktrees that belong to server projects. Their folder is not a git
/// repo, so git polling and checkpoints must skip them (git would otherwise
/// walk up to a parent repo).
pub(crate) fn server_worktree_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    let Ok(data) = load_projects_data(app) else {
        return Default::default();
    };
    data.worktrees
        .iter()
        .filter(|w| {
            data.find_project(&w.project_id)
                .is_some_and(|p| p.server.is_some())
        })
        .map(|w| w.id.clone())
        .collect()
}

/// True when the worktree belongs to a server project.
pub(crate) fn is_server_worktree(app: &AppHandle, worktree_id: &str) -> bool {
    server_worktree_ids(app).contains(worktree_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(user: Option<&str>, port: Option<u16>) -> ProjectServer {
        ProjectServer {
            host: "10.0.0.5".to_string(),
            user: user.map(str::to_string),
            port,
            identity_file: None,
            jean_connection_id: None,
            local: false,
        }
    }

    #[test]
    fn ssh_command_uses_user_and_non_default_port() {
        assert_eq!(
            server(None, None).ssh_command(),
            "ssh -o BatchMode=yes 10.0.0.5"
        );
        assert_eq!(
            server(Some("root"), Some(22)).ssh_command(),
            "ssh -o BatchMode=yes root@10.0.0.5"
        );
        assert_eq!(
            server(Some("deploy"), Some(2222)).ssh_command(),
            "ssh -o BatchMode=yes -p 2222 deploy@10.0.0.5"
        );
        let mut keyed = server(Some("root"), None);
        keyed.identity_file = Some("/home/me/.ssh/id work".to_string());
        assert_eq!(
            keyed.ssh_command(),
            "ssh -o BatchMode=yes -o IdentitiesOnly=yes -i '/home/me/.ssh/id work' root@10.0.0.5"
        );
    }

    #[test]
    fn normalize_rejects_option_and_shell_injection() {
        let mut bad = server(None, None);
        bad.host = "-oProxyCommand=evil".to_string();
        assert!(normalize_server(bad).is_err());
        let mut bad = server(Some("root;rm"), None);
        bad.host = "host".to_string();
        assert!(normalize_server(bad).is_err());
        let mut bad = server(None, Some(0));
        bad.host = "host".to_string();
        assert!(normalize_server(bad).is_err());

        let ok = normalize_server(ProjectServer {
            host: "  example.com ".to_string(),
            user: Some("  ".to_string()),
            port: None,
            identity_file: Some(" ".to_string()),
            jean_connection_id: Some(" ".to_string()),
            local: false,
        })
        .unwrap();
        assert_eq!(ok.host, "example.com");
        assert_eq!(ok.user, None);
        assert_eq!(ok.jean_connection_id, None);
        assert_eq!(ok.identity_file, None);

        for path in ["id_ed25519", "/x/id' ; rm -rf /", "/x/id\nfoo"] {
            let mut bad = server(None, None);
            bad.identity_file = Some(path.to_string());
            assert!(normalize_server(bad).is_err(), "{path}");
        }
    }

    #[tokio::test]
    async fn setup_script_validates_input_and_sets_access() {
        let key = "ssh-ed25519 AAAAC3Nza jean@laptop".to_string();
        assert!(
            server_user_setup_script("root".into(), key.clone(), ServerUserAccess::None)
                .await
                .is_err()
        );
        assert!(
            server_user_setup_script("Jean;x".into(), key.clone(), ServerUserAccess::None)
                .await
                .is_err()
        );
        assert!(server_user_setup_script(
            "jean".into(),
            "ssh-ed25519 AAA x' ; rm -rf / '".into(),
            ServerUserAccess::None
        )
        .await
        .is_err());
        assert!(server_user_setup_script(
            "jean".into(),
            "not-a-key".into(),
            ServerUserAccess::None
        )
        .await
        .is_err());

        let script =
            server_user_setup_script("jean".into(), key.clone(), ServerUserAccess::Readonly)
                .await
                .unwrap();
        assert!(script.contains("U='jean'"));
        assert!(script.contains(&format!("KEY='{key}'")));
        assert!(script.contains("MODE='readonly'"));
        assert!(script.contains("visudo -cf"));
        assert!(!script.contains("usermod -aG docker"));
    }

    #[test]
    fn render_fills_placeholders() {
        let target = server(Some("root"), Some(2200));
        let project = Project {
            name: "prod-1".to_string(),
            ..serde_json::from_value(serde_json::json!({
                "id": "p", "name": "x", "path": "", "default_branch": "", "added_at": 0
            }))
            .unwrap()
        };
        let prompt =
            render_server_system_prompt(&default_server_system_prompt(), &project, &target);
        assert!(prompt.contains("\"prod-1\""));
        assert!(prompt.contains("`ssh -o BatchMode=yes -p 2200 root@10.0.0.5 '<command>'`"));
        assert!(!prompt.contains('{'));
    }

    #[test]
    fn render_local_server_has_no_ssh() {
        let local = ProjectServer {
            local: true,
            ..Default::default()
        };
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "Local", "path": "", "default_branch": "", "added_at": 0
        }))
        .unwrap();
        let prompt = render_server_system_prompt(&default_server_system_prompt(), &project, &local);
        assert!(prompt.contains("directly in the local shell"));
        assert!(!prompt.contains("ssh -o"));
        assert!(!prompt.contains('{'));
        assert_eq!(
            normalize_server(ProjectServer {
                host: "x".into(),
                ..local
            })
            .unwrap()
            .host,
            ""
        );
    }
}

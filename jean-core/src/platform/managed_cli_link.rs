//! Expose Jean-managed CLIs to normal user terminals.

use std::path::{Path, PathBuf};

/// Create or repair a launcher for a managed CLI when no independent PATH
/// installation exists. The launcher has a stable path, so replacing the
/// managed binary during an upgrade does not break it.
pub fn ensure_managed_cli_link(tool: &str, managed_binary: &Path) -> Result<bool, String> {
    if !managed_binary.exists() {
        return Ok(false);
    }

    let canonical_managed = std::fs::canonicalize(managed_binary).ok();
    if super::find_cli_in_host_path(tool, canonical_managed.as_deref()).is_some() {
        return Ok(false);
    }

    let link = user_cli_link_path(tool)?;
    create_or_replace_launcher(&link, managed_binary)?;
    log::info!(
        "Exposed Jean-managed {tool} CLI to user terminals at {}",
        link.display()
    );
    Ok(true)
}

#[cfg(windows)]
pub fn ensure_managed_cli_link_in_wsl(
    distro: &str,
    tool: &str,
    managed_binary: &str,
) -> Result<bool, String> {
    if super::wsl_which(distro, tool, Some(managed_binary)).is_some() {
        return Ok(false);
    }
    let output = super::silent_command("wsl.exe")
        .args([
            "-d",
            distro,
            "--",
            "bash",
            "-lc",
            "test -x \"$1\" && mkdir -p \"$HOME/.local/bin\" && ln -sfn \"$1\" \"$HOME/.local/bin/$2\"",
            "jean-cli-link",
            managed_binary,
            tool,
        ])
        .output()
        .map_err(|error| format!("Failed to run WSL: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(true)
}

#[cfg(unix)]
fn user_cli_link_path(tool: &str) -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_string())?;
    Ok(home.join(".local").join("bin").join(tool))
}

#[cfg(windows)]
fn user_cli_link_path(tool: &str) -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
    // WindowsApps is on the standard per-user PATH. A cmd launcher does not
    // require Developer Mode or administrator access, unlike a symlink.
    Ok(local
        .join("Microsoft")
        .join("WindowsApps")
        .join(format!("{tool}.cmd")))
}

#[cfg(unix)]
fn create_or_replace_launcher(link: &Path, managed_binary: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if std::fs::read_link(link).ok().as_deref() == Some(managed_binary) {
        return Ok(());
    }
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    if link.symlink_metadata().is_ok() && std::fs::read_link(link).is_err() {
        return Err(format!(
            "Refusing to replace non-symlink launcher {}",
            link.display()
        ));
    }
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(link)
            .map_err(|error| format!("Failed to replace {}: {error}", link.display()))?;
    }
    symlink(managed_binary, link)
        .map_err(|error| format!("Failed to link {}: {error}", link.display()))
}

#[cfg(windows)]
fn create_or_replace_launcher(link: &Path, managed_binary: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let target = managed_binary.to_string_lossy().replace('%', "%%");
    let contents = format!("@echo off\r\n\"{target}\" %*\r\n");
    std::fs::write(link, contents)
        .map_err(|error| format!("Failed to write {}: {error}", link.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn launcher_is_repaired_after_managed_target_changes() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        let link = dir.path().join("tool");
        std::fs::write(&first, "one").unwrap();
        std::fs::write(&second, "two").unwrap();

        create_or_replace_launcher(&link, &first).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), first);
        create_or_replace_launcher(&link, &second).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), second);
    }
}

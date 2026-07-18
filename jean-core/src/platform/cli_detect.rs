//! Shared CLI path detection that transparently handles WSL mode.
//!
//! In WSL mode, every CLI (`claude`, `codex`, `opencode`, `gh`, `cursor-agent`)
//! must be detected inside the WSL distro — Windows-side `where` returns paths
//! bash cannot exec. Non-WSL paths use the existing native `where`/`which` lookup.

use std::path::{Path, PathBuf};

use super::{cli_command, detect_package_manager, silent_command};

/// Generic CLI detection result. Per-CLI Tauri commands map this into their
/// typed wrapper structs to keep the wire protocol stable.
#[derive(Debug, Clone)]
pub struct CliDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

impl CliDetection {
    pub fn not_found() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        }
    }
}

/// Detect a CLI tool on the user's PATH.
///
/// - When WSL mode is enabled: resolves the Unix path inside the WSL distro.
///   Version comes from the selected path's `--version` inside WSL.
/// - Otherwise: runs Windows `where` / Unix `which` and returns the native path.
///   `jean_managed` (when provided) is the canonical path of a Jean-installed
///   binary that must be excluded from "found in PATH" detection.
///   In WSL mode, `jean_managed_wsl` is the Unix path of the Jean-managed
///   binary to exclude from WSL PATH detection.
pub fn detect_cli_in_path(
    tool: &str,
    jean_managed: Option<&Path>,
    jean_managed_wsl: Option<&str>,
) -> CliDetection {
    let wsl = super::get_wsl_config();
    if wsl.enabled {
        let Some(unix_path) = super::wsl_which(&wsl.distro, tool, jean_managed_wsl) else {
            return CliDetection::not_found();
        };
        let version = super::wsl_tool_version(&wsl.distro, &unix_path);
        let package_manager = super::wsl_detect_package_manager(&unix_path);
        return CliDetection {
            found: true,
            path: Some(unix_path),
            version,
            package_manager,
        };
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = match silent_command(which_cmd).arg(tool).output() {
        Ok(o) if o.status.success() => o,
        _ => return CliDetection::not_found(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(found_path) = select_cli_candidate(&stdout, cfg!(target_os = "windows"), jean_managed)
    else {
        return CliDetection::not_found();
    };

    let version = match cli_command(&found_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(ver_output) if ver_output.status.success() => Some(
            String::from_utf8_lossy(&ver_output.stdout)
                .trim()
                .to_string(),
        ),
        _ => None,
    };

    CliDetection {
        found: true,
        path: Some(found_path.to_string_lossy().to_string()),
        version,
        package_manager: detect_package_manager(&found_path),
    }
}

/// Find the best host-side PATH candidate for a CLI tool.
///
/// On Windows this avoids extensionless npm shims that `where` may list before
/// the executable `.cmd`/`.exe` shim. WSL callers should use `wsl_which`
/// instead so Windows paths are not returned for Linux execution.
pub fn find_cli_in_host_path(tool: &str, jean_managed: Option<&Path>) -> Option<PathBuf> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = silent_command(which_cmd).arg(tool).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    select_cli_candidate(&stdout, cfg!(target_os = "windows"), jean_managed)
        .filter(|path| path.exists())
}

/// Select the path Jean should use from `where`/`which` output.
///
/// Windows npm installs often produce several shims for one command. The
/// extensionless shim (for Unix shells) can appear before `*.cmd`, but it is
/// not directly executable by Windows `CreateProcessW`.
pub fn select_cli_candidate(
    output: &str,
    prefer_windows_executable: bool,
    jean_managed: Option<&Path>,
) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| !is_jean_managed_candidate(path, jean_managed))
        .collect();

    if prefer_windows_executable {
        candidates.sort_by_key(|path| windows_cli_candidate_rank(path));
    }

    candidates.into_iter().next()
}

fn is_jean_managed_candidate(path: &Path, jean_managed: Option<&Path>) -> bool {
    let Some(jean_path) = jean_managed else {
        return false;
    };

    if path == jean_path {
        return true;
    }

    std::fs::canonicalize(path).is_ok_and(|canonical_found| canonical_found == jean_path)
}

fn windows_cli_candidate_rank(path: &Path) -> u8 {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe") => 0,
        Some("cmd") => 1,
        Some("bat") => 2,
        None | Some("") => 3,
        Some("ps1") => 4,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::wsl_detect_package_manager;
    use super::select_cli_candidate;

    #[test]
    fn windows_path_detection_prefers_cmd_shim_over_extensionless_npm_shim() {
        let output = r"C:\Users\u\AppData\Roaming\npm\opencode
C:\Users\u\AppData\Roaming\npm\opencode.cmd
C:\Users\u\AppData\Roaming\npm\opencode.ps1";

        assert_eq!(
            select_cli_candidate(output, true, None),
            Some(PathBuf::from(
                r"C:\Users\u\AppData\Roaming\npm\opencode.cmd"
            ))
        );
    }

    #[test]
    fn windows_path_detection_prefers_exe_over_cmd() {
        let output = r"C:\tools\opencode.cmd
C:\tools\opencode.exe";

        assert_eq!(
            select_cli_candidate(output, true, None),
            Some(PathBuf::from(r"C:\tools\opencode.exe"))
        );
    }

    #[test]
    fn windows_path_detection_prefers_batch_over_extensionless_and_ps1() {
        let output = r"C:\Users\u\AppData\Roaming\npm\codex
C:\Users\u\AppData\Roaming\npm\codex.ps1
C:\Users\u\AppData\Roaming\npm\codex.bat";

        assert_eq!(
            select_cli_candidate(output, true, None),
            Some(PathBuf::from(r"C:\Users\u\AppData\Roaming\npm\codex.bat"))
        );
    }

    #[test]
    fn unix_path_detection_keeps_first_candidate() {
        let output = "/usr/local/bin/opencode\n/opt/bin/opencode";

        assert_eq!(
            select_cli_candidate(output, false, None),
            Some(PathBuf::from("/usr/local/bin/opencode"))
        );
    }

    #[test]
    fn path_detection_skips_jean_managed_candidate_before_ranking() {
        let output = r"C:\Users\u\AppData\Roaming\jean\codex-cli\codex.exe
C:\Users\u\AppData\Roaming\npm\codex
C:\Users\u\AppData\Roaming\npm\codex.cmd";

        assert_eq!(
            select_cli_candidate(
                output,
                true,
                Some(std::path::Path::new(
                    r"C:\Users\u\AppData\Roaming\jean\codex-cli\codex.exe"
                ))
            ),
            Some(PathBuf::from(r"C:\Users\u\AppData\Roaming\npm\codex.cmd"))
        );
    }

    #[test]
    fn wsl_pkg_mgr_homebrew() {
        assert_eq!(
            wsl_detect_package_manager("/home/linuxbrew/.linuxbrew/bin/gh"),
            Some("homebrew".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_bun() {
        assert_eq!(
            wsl_detect_package_manager(
                "/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js"
            ),
            Some("bun".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_npm() {
        assert_eq!(
            wsl_detect_package_manager(
                "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude"
            ),
            Some("npm".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_cargo() {
        assert_eq!(
            wsl_detect_package_manager("/home/u/.cargo/bin/foo"),
            Some("cargo".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_system() {
        assert_eq!(wsl_detect_package_manager("/usr/bin/gh"), None);
    }
}

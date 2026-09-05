//! Shared CLI path detection that transparently handles WSL mode.
//!
//! In WSL mode, every CLI (`claude`, `codex`, `opencode`, `gh`, `cursor-agent`)
//! must be detected inside the WSL distro — Windows-side `where` returns paths
//! bash cannot exec. Non-WSL paths use the existing native `where`/`which` lookup.

use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Build a Command for a tool Jean expects on `PATH` — `npm`, `npx`, `node`,
/// `git`, or an already-resolved CLI path.
///
/// Windows needs this indirection. When `CreateProcessW` searches `PATH` it only
/// appends `.exe`, so spawning bare `npm` fails with "program not found" on a
/// stock Node.js install, which ships `npm.cmd`/`npx.cmd` plus an extensionless
/// shell shim that is not a valid executable image (issue #675). Resolving the
/// name first lets [`host_cli_command`] hand the shim to `std::process`, which
/// launches batch files through `cmd.exe` with the argument escaping that needs.
///
/// Paths stay on the Windows host rather than routing through WSL, because these
/// callers pass host directories (`npm install --prefix <app data dir>`).
///
/// Non-Windows targets spawn `tool` directly: the kernel already resolves `PATH`
/// and shebangs, so no lookup subprocess is spawned there.
pub fn path_tool_command(tool: &str) -> Command {
    if !cfg!(target_os = "windows") {
        return silent_command(tool);
    }

    // A bare name needs a `where` lookup; anything with a directory component is
    // already resolved (self-update commands pass the detected CLI path) and only
    // needs the shim handling.
    let resolved = if Path::new(tool)
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        Some(PathBuf::from(tool))
    } else {
        find_cli_in_host_path(tool, None)
    };

    match resolved {
        Some(path) => super::host_cli_command(&path.to_string_lossy(), None),
        // Nothing on PATH: spawn bare so callers still surface the OS
        // "not found" error and their own "install Node.js" hint.
        None => silent_command(tool),
    }
}

/// Select the path Jean should use from `where`/`which` output.
///
/// Windows npm installs often produce several shims for one command. The
/// extensionless shim (for Unix shells) can appear before `*.cmd`, but it is
/// not directly executable by Windows `CreateProcessW` (os error 193).
///
/// When the best candidate is still extensionless, also try a same-directory
/// sibling with a Windows executable extension (`.exe` / `.cmd` / `.bat`).
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

    let selected = candidates.into_iter().next()?;
    if prefer_windows_executable {
        Some(prefer_windows_executable_sibling(selected))
    } else {
        Some(selected)
    }
}

/// If `path` is extensionless, prefer a Windows-native sibling that
/// CreateProcessW can launch (issue #265 / #415).
pub fn prefer_windows_executable_sibling(path: PathBuf) -> PathBuf {
    let has_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| !ext.is_empty());
    if has_extension {
        return path;
    }

    for ext in ["exe", "cmd", "bat"] {
        let candidate = path.with_extension(ext);
        if candidate.is_file() {
            return candidate;
        }
    }

    path
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
    fn windows_path_detection_prefers_npm_cmd_when_no_exe_shim_exists() {
        // `where npm` on a stock Node.js install: an extensionless shell shim, the
        // batch shim Windows can actually launch, and a PowerShell shim. There is
        // no `npm.exe` at all, so bare `npm` is unlaunchable (issue #675).
        let output = "C:\\Program Files\\nodejs\\npm\r\n\
C:\\Program Files\\nodejs\\npm.cmd\r\n\
C:\\Program Files\\nodejs\\npm.ps1\r\n";

        assert_eq!(
            select_cli_candidate(output, true, None),
            Some(PathBuf::from(r"C:\Program Files\nodejs\npm.cmd"))
        );
    }

    #[test]
    fn windows_path_detection_accepts_a_lone_npx_cmd_shim() {
        let output = "C:\\Program Files\\nodejs\\npx.cmd\r\n";

        assert_eq!(
            select_cli_candidate(output, true, None),
            Some(PathBuf::from(r"C:\Program Files\nodejs\npx.cmd"))
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn path_tool_command_spawns_the_bare_tool_off_windows() {
        // No `which` probe, no shell wrapper: the kernel resolves PATH itself.
        let cmd = super::path_tool_command("npm");

        assert_eq!(cmd.get_program(), std::ffi::OsStr::new("npm"));
        assert_eq!(cmd.get_args().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn path_tool_command_runs_a_real_path_tool_off_windows() {
        let output = super::path_tool_command("echo")
            .arg("jean")
            .output()
            .expect("echo should be spawnable from PATH");

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "jean");
    }

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
    fn prefer_windows_executable_sibling_resolves_cmd_when_extensionless_is_selected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let extensionless = dir.path().join("codex");
        let cmd = dir.path().join("codex.cmd");
        std::fs::write(&extensionless, b"#!/usr/bin/env node\n").unwrap();
        std::fs::write(&cmd, b"@echo off\n").unwrap();

        assert_eq!(super::prefer_windows_executable_sibling(extensionless), cmd);
    }

    #[test]
    fn prefer_windows_executable_sibling_keeps_existing_extension() {
        let path = PathBuf::from(r"C:\tools\codex.exe");
        assert_eq!(super::prefer_windows_executable_sibling(path.clone()), path);
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

/// Node tooling must never be spawned as a bare program name.
///
/// Windows `PATH` search only appends `.exe`, so a bare spawn of the Node
/// launchers cannot find the `.cmd` shims a stock install ships and reports them
/// as missing (issue #675). New call sites have to go through
/// [`path_tool_command`], which resolves the shim first.
#[cfg(test)]
mod node_launcher_audit {
    use std::fs;
    use std::path::{Path, PathBuf};

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("jean-core should live under the repo root")
            .to_path_buf()
    }

    fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rust_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    fn line_number(source: &str, byte_offset: usize) -> usize {
        source[..byte_offset]
            .bytes()
            .filter(|&b| b == b'\n')
            .count()
            + 1
    }

    #[test]
    fn npm_and_npx_are_never_spawned_as_bare_program_names() {
        let root = repo_root();
        let mut files = Vec::new();
        collect_rust_files(&root.join("jean-core/src"), &mut files);
        collect_rust_files(&root.join("src-tauri/src"), &mut files);
        assert!(!files.is_empty(), "audit scanned no Rust sources");

        // Built at runtime so this module's own source cannot match the needles.
        let needles: Vec<String> = ["npm", "npx"]
            .iter()
            .flat_map(|tool| {
                [
                    format!("silent_command(\"{tool}\")"),
                    format!("Command::new(\"{tool}\")"),
                ]
            })
            .collect();

        let mut violations = Vec::new();
        for path in &files {
            let Ok(source) = fs::read_to_string(path) else {
                continue;
            };
            let rel = path.strip_prefix(&root).unwrap_or(path);
            for needle in &needles {
                for (idx, _) in source.match_indices(needle.as_str()) {
                    violations.push(format!(
                        "{}:{}: {needle} — use path_tool_command() so Windows finds the .cmd shim",
                        rel.to_string_lossy().replace('\\', "/"),
                        line_number(&source, idx)
                    ));
                }
            }
        }

        assert!(
            violations.is_empty(),
            "Bare npm/npx spawns found (issue #675):\n{}",
            violations.join("\n")
        );
    }
}

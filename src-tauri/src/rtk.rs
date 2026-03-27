use std::path::{Path, PathBuf};

fn path_candidates_for_binary(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(name));
            #[cfg(windows)]
            candidates.push(dir.join(format!("{name}.exe")));
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(name));
        candidates.push(home.join(".cargo").join("bin").join(name));
        #[cfg(windows)]
        {
            candidates.push(home.join(".local").join("bin").join(format!("{name}.exe")));
            candidates.push(home.join(".cargo").join("bin").join(format!("{name}.exe")));
        }
    }

    candidates
}

fn is_usable_binary(path: &Path) -> bool {
    path.exists() && path.is_file()
}

pub fn resolve_rtk_binary() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("RTK_BIN") {
        let explicit_path = PathBuf::from(explicit);
        if is_usable_binary(&explicit_path) {
            return Ok(explicit_path);
        }
        return Err(format!(
            "RTK_BIN is set but points to a missing file: {}",
            explicit_path.display()
        ));
    }

    for candidate in path_candidates_for_binary("rtk") {
        if is_usable_binary(&candidate) {
            return Ok(candidate);
        }
    }

    let path = std::env::var("PATH").unwrap_or_default();
    Err(format!(
        "RTK binary not found. Ensure `rtk` is installed and available to Jean. PATH={path}"
    ))
}

pub fn silent_rtk_command() -> Result<std::process::Command, String> {
    let binary = resolve_rtk_binary()?;
    Ok(crate::platform::silent_command(binary))
}

pub fn initialize_rtk_integration() {
    let mut command = match silent_rtk_command() {
        Ok(command) => command,
        Err(error) => {
            log::warn!("RTK initialization skipped: {error}");
            return;
        }
    };

    match command.args(["init", "-g"]).output() {
        Ok(output) if output.status.success() => {
            log::info!("RTK initialized successfully: rtk init -g");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.is_empty() {
                log::warn!(
                    "RTK initialization failed (status={}): rtk init -g",
                    output.status
                );
            } else {
                log::warn!(
                    "RTK initialization failed (status={}): rtk init -g ({stderr})",
                    output.status
                );
            }
        }
        Err(error) => {
            log::warn!("RTK initialization command failed to start: rtk init -g ({error})");
        }
    }
}

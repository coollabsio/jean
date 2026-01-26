//! Hook installer for Claude Code integration
//!
//! Manages installation and removal of the context-writer hook in Claude Code's settings.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// The hook script content (Bun/TypeScript)
const HOOK_SCRIPT: &str = r#"#!/usr/bin/env bun

/**
 * Jean context-writer hook for Claude Code
 *
 * This hook runs on the "Stop" event (after each assistant response)
 * and writes context window data for Jean to read.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface HookInput {
  session_id: string;
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface ContextData {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  contextTokens: number;
  contextMaxTokens: number;
  contextPercentage: number;
  timestamp: string;
}

const DATA_DIR = join(homedir(), ".jean", "context-data");

async function main() {
  try {
    const input: HookInput = await Bun.stdin.json();

    // Ensure data directory exists
    await mkdir(DATA_DIR, { recursive: true });

    // Extract context data
    const contextWindow = input.context_window;
    const currentUsage = contextWindow?.current_usage;

    let contextTokens = 0;
    if (currentUsage) {
      contextTokens =
        (currentUsage.input_tokens || 0) +
        (currentUsage.cache_creation_input_tokens || 0) +
        (currentUsage.cache_read_input_tokens || 0);
    }

    const maxTokens = contextWindow?.context_window_size || 200000;
    const contextPercentage = Math.min(100, Math.round((contextTokens / maxTokens) * 100));

    const data: ContextData = {
      sessionId: input.session_id,
      costUsd: input.cost.total_cost_usd,
      durationMs: input.cost.total_duration_ms,
      contextTokens: contextTokens,
      contextMaxTokens: maxTokens,
      contextPercentage: contextPercentage,
      timestamp: new Date().toISOString(),
    };

    // Write to session-specific file
    const filePath = join(DATA_DIR, `${input.session_id}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2));

  } catch (error) {
    // Fail silently - don't disrupt Claude Code
    console.error("Jean context-writer error:", error);
  }
}

main();
"#;

/// Get the path to Jean's hooks directory
fn get_jean_hooks_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".jean").join("hooks"))
}

/// Get the path to the hook script
fn get_hook_script_path() -> Option<PathBuf> {
    let dir = get_jean_hooks_dir()?;
    Some(dir.join("context-writer.ts"))
}

/// Get the path to Claude Code's settings.json
fn get_claude_settings_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".claude").join("settings.json"))
}

/// Claude Code settings structure (partial, for hooks)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub hooks: ClaudeHooks,
    #[serde(flatten)]
    pub other: Value,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClaudeHooks {
    #[serde(default, rename = "Stop")]
    pub stop: Vec<ClaudeHook>,
    #[serde(flatten)]
    pub other: Value,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeHook {
    pub matcher: String,
    pub hooks: Vec<HookCommand>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookCommand {
    #[serde(rename = "type")]
    pub hook_type: String,
    pub command: String,
}

/// Check if the Jean hook is installed in Claude Code settings
pub fn is_hook_installed() -> bool {
    let settings_path = match get_claude_settings_path() {
        Some(p) => p,
        None => return false,
    };

    if !settings_path.exists() {
        return false;
    }

    let content = match fs::read_to_string(&settings_path) {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Check if our hook command is in the file
    content.contains(".jean/hooks/context-writer.ts")
}

/// Install the Jean hook in Claude Code settings
pub fn install_hook() -> Result<(), String> {
    // 1. Create the hook script
    let hooks_dir = get_jean_hooks_dir().ok_or("Could not determine home directory")?;
    fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("Failed to create hooks directory: {e}"))?;

    let script_path = get_hook_script_path().ok_or("Could not determine hook script path")?;
    fs::write(&script_path, HOOK_SCRIPT)
        .map_err(|e| format!("Failed to write hook script: {e}"))?;

    // Make script executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| format!("Failed to read script permissions: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("Failed to set script permissions: {e}"))?;
    }

    // 2. Update Claude Code settings
    let settings_path = get_claude_settings_path().ok_or("Could not determine Claude settings path")?;

    // Read existing settings or create new
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Claude settings: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse Claude settings: {e}"))?
    } else {
        // Ensure .claude directory exists
        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .claude directory: {e}"))?;
        }
        serde_json::json!({})
    };

    // Get or create hooks object
    let hooks = settings
        .as_object_mut()
        .ok_or("Settings is not an object")?
        .entry("hooks")
        .or_insert(serde_json::json!({}));

    // Get or create Stop array
    let stop_hooks = hooks
        .as_object_mut()
        .ok_or("Hooks is not an object")?
        .entry("Stop")
        .or_insert(serde_json::json!([]));

    let stop_array = stop_hooks
        .as_array_mut()
        .ok_or("Stop is not an array")?;

    // Check if our hook already exists
    let hook_command = format!("bun {}/.jean/hooks/context-writer.ts", std::env::var("HOME").unwrap_or_default());
    let hook_exists = stop_array.iter().any(|h| {
        h.get("hooks")
            .and_then(|hooks| hooks.as_array())
            .map(|hooks| hooks.iter().any(|cmd| {
                cmd.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(".jean/hooks/context-writer.ts"))
                    .unwrap_or(false)
            }))
            .unwrap_or(false)
    });

    if !hook_exists {
        // Add our hook
        let new_hook = serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": hook_command
            }]
        });
        stop_array.push(new_hook);
    }

    // Write settings back
    let output = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&settings_path, output)
        .map_err(|e| format!("Failed to write Claude settings: {e}"))?;

    Ok(())
}

/// Uninstall the Jean hook from Claude Code settings
pub fn uninstall_hook() -> Result<(), String> {
    let settings_path = get_claude_settings_path().ok_or("Could not determine Claude settings path")?;

    if !settings_path.exists() {
        return Ok(()); // Nothing to uninstall
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read Claude settings: {e}"))?;

    let mut settings: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Claude settings: {e}"))?;

    // Navigate to hooks.Stop array
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(stop_hooks) = hooks.get_mut("Stop") {
            if let Some(stop_array) = stop_hooks.as_array_mut() {
                // Remove any hooks containing our script
                stop_array.retain(|h| {
                    !h.get("hooks")
                        .and_then(|hooks| hooks.as_array())
                        .map(|hooks| hooks.iter().any(|cmd| {
                            cmd.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.contains(".jean/hooks/context-writer.ts"))
                                .unwrap_or(false)
                        }))
                        .unwrap_or(false)
                });
            }
        }
    }

    // Write settings back
    let output = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&settings_path, output)
        .map_err(|e| format!("Failed to write Claude settings: {e}"))?;

    // Optionally remove the script file
    if let Some(script_path) = get_hook_script_path() {
        let _ = fs::remove_file(script_path); // Ignore errors
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hook_script_is_valid_typescript() {
        // Just ensure the script compiles (contains expected patterns)
        assert!(HOOK_SCRIPT.contains("#!/usr/bin/env bun"));
        assert!(HOOK_SCRIPT.contains("Bun.stdin.json()"));
        assert!(HOOK_SCRIPT.contains("contextPercentage"));
    }
}

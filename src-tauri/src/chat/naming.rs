//! Unified automatic naming for sessions and branches
//!
//! Uses a single Claude CLI call to generate both session and branch names
//! based on the first message in a session.

use crate::claude_cli::resolve_cli_binary;
use crate::platform::silent_command;
use crate::projects::git;
use crate::projects::storage::{load_projects_data, save_projects_data};

use super::storage::with_sessions_mut;
use crate::http_server::EmitExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Manager};

/// Request for combined naming (session + branch)
#[derive(Debug, Clone)]
pub struct NamingRequest {
    pub session_id: String,
    pub worktree_id: String,
    pub worktree_path: PathBuf,
    pub first_message: String,
    pub model: String,
    pub existing_branch_names: Vec<String>,
    pub generate_session_name: bool,
    pub generate_branch_name: bool,
    /// Optional custom prompt for session naming (from magic prompts settings)
    pub custom_session_prompt: Option<String>,
    /// Optional custom CLI profile name for alternative providers (e.g., OpenRouter)
    pub custom_profile_name: Option<String>,
}

/// Successful session rename result (for event emission)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNameResult {
    pub session_id: String,
    pub worktree_id: String,
    pub old_name: String,
    pub new_name: String,
}

/// Successful branch rename result (for event emission)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchNameResult {
    pub worktree_id: String,
    pub old_branch: String,
    pub new_branch: String,
}

/// Stage where naming failed
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NamingStage {
    Generation,
    Validation,
    SessionStorage,
    GitRename,
}

/// Naming error with context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamingError {
    pub session_id: Option<String>,
    pub worktree_id: String,
    pub error: String,
    pub stage: NamingStage,
}

/// JSON output from Claude for naming
#[derive(Debug, Deserialize)]
struct NamingOutput {
    #[serde(default)]
    session_name: Option<String>,
    #[serde(default)]
    branch_name: Option<String>,
}

/// Check if the message contains image attachments that require Read tool
fn contains_image_attachment(message: &str) -> bool {
    message.contains("[Image attached:")
        && message.contains("Use the Read tool to view this image]")
}

/// Check if the message contains text file attachments that require Read tool
fn contains_text_attachment(message: &str) -> bool {
    message.contains("[Text file attached:")
        && message.contains("Use the Read tool to view this file]")
}

/// Check if the message contains file mentions (@ mentions) that require Read tool
fn contains_file_mention(message: &str) -> bool {
    message.contains("[File:") && message.contains("Use the Read tool to view this file]")
}

/// Extract a JSON object from text that may contain surrounding prose
/// Claude sometimes outputs explanation text before/after the JSON when using tools
fn extract_json_object(text: &str) -> Option<&str> {
    // Find the first '{' and matching closing '}'
    let start = text.find('{')?;
    let mut depth = 0;
    let mut end = start;

    for (i, c) in text[start..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if depth == 0 && end > start {
        Some(&text[start..end])
    } else {
        None
    }
}

/// The prompt template for Claude to generate both names
const NAMING_PROMPT_BOTH: &str = r#"<task>Generate a session name AND a git branch name for a coding session based on the user's request.</task>

<session_name_rules>
- Maximum 4-5 words total
- Use sentence case (only capitalize first word)
- Be descriptive but concise
- Focus on the main topic or goal
- No special characters or punctuation
- No generic names like "Chat session" or "New task"
- Do NOT use commit-style prefixes like "Add", "Fix", "Update", "Refactor"
</session_name_rules>

<branch_name_rules>
- Use lowercase only
- Use hyphens between words (no spaces or underscores)
- Maximum 50 characters total
- Be concise but descriptive
- DO NOT include any type prefix like "feat/", "fix/", etc.
- Just provide the descriptive name directly
- The name MUST be unique - do NOT use any of the existing names listed below
- For GitHub issue investigations, format as: {number}-{brief-description} (e.g., "7904-fix-login-bug")
- For GitHub PR investigations, format as: {number}-{brief-description} (e.g., "456-add-auth")
</branch_name_rules>

<existing_branch_names>
{existing_names}
</existing_branch_names>

<user_request>
{message}
</user_request>

<output_format>
Respond with ONLY the raw JSON object, no markdown, no code fences, no explanation:
{"session_name": "Your session name here", "branch_name": "your-branch-name-here"}
</output_format>"#;

const NAMING_PROMPT_SESSION_ONLY: &str = r#"<task>Generate a short, human-friendly name for this chat session based on the user's request.</task>

<rules>
- Maximum 4-5 words total
- Use sentence case (only capitalize first word)
- Be descriptive but concise
- Focus on the main topic or goal
- No special characters or punctuation
- No generic names like "Chat session" or "New task"
- Do NOT use commit-style prefixes like "Add", "Fix", "Update", "Refactor"
</rules>

<user_request>
{message}
</user_request>

<output_format>
Respond with ONLY the raw JSON object, no markdown, no code fences, no explanation:
{"session_name": "Your session name here"}
</output_format>"#;

const NAMING_PROMPT_BRANCH_ONLY: &str = r#"<task>Generate a short, descriptive git branch name for the following user request.</task>

<rules>
- Use lowercase only
- Use hyphens between words (no spaces or underscores)
- Maximum 50 characters total
- Be concise but descriptive
- DO NOT include any type prefix like "feat/", "fix/", etc.
- Just provide the descriptive name directly
- The name MUST be unique - do NOT use any of the existing names listed below
- For GitHub issue investigations, format as: {number}-{brief-description} (e.g., "7904-fix-login-bug")
- For GitHub PR investigations, format as: {number}-{brief-description} (e.g., "456-add-auth")
</rules>

<existing_branch_names>
{existing_names}
</existing_branch_names>

<user_request>
{message}
</user_request>

<output_format>
Respond with ONLY the raw JSON object, no markdown, no code fences, no explanation:
{"branch_name": "your-branch-name-here"}
</output_format>"#;

/// Image instruction prefix - added to prompts when images are present
const IMAGE_INSTRUCTION_PREFIX: &str = r#"<image_handling>
The user's request includes attached images. You MUST read each image using the Read tool BEFORE generating names.
For each "[Image attached: PATH - Use the Read tool to view this image]" marker, call Read with that exact PATH.
Base your naming on both the text content AND what you see in the images.
</image_handling>

"#;

/// Text file instruction prefix - added to prompts when text files are attached
const TEXT_INSTRUCTION_PREFIX: &str = r#"<text_handling>
The user's request includes attached text files. You MUST read each file using the Read tool BEFORE generating names.
For each "[Text file attached: PATH - Use the Read tool to view this file]" marker, call Read with that exact PATH.
Base your naming on both the user's message AND the content of the attached text files.
</text_handling>

"#;

/// File mention instruction prefix - added to prompts when @ file mentions are present
const FILE_MENTION_INSTRUCTION_PREFIX: &str = r#"<file_handling>
The user's request includes file references. You MUST read each file using the Read tool BEFORE generating names.
For each "[File: PATH - Use the Read tool to view this file]" marker, call Read with that exact PATH.
Base your naming on both the user's message AND the content of the referenced files.
</file_handling>

"#;

/// Convert a model preference to a Claude CLI model alias
fn get_cli_model_alias(model: &str) -> &'static str {
    match model {
        "haiku" => "haiku",
        "sonnet" => "sonnet",
        "opus" => "opus",
        _ => "haiku",
    }
}

/// Extract text content from stream-json output
fn extract_text_from_stream_json(output: &str) -> Result<String, String> {
    let mut text_content = String::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(message) = parsed.get("message") {
                if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                text_content.push_str(text);
                            }
                        }
                    }
                }
            }
        }

        if parsed.get("type").and_then(|t| t.as_str()) == Some("result") {
            if let Some(result) = parsed.get("result").and_then(|r| r.as_str()) {
                if text_content.is_empty() {
                    text_content = result.to_string();
                }
            }
        }
    }

    if text_content.is_empty() {
        return Err("No text content found in Claude response".to_string());
    }

    Ok(text_content.trim().to_string())
}

/// Generate names using Claude CLI
fn generate_names(app: &AppHandle, request: &NamingRequest) -> Result<NamingOutput, String> {
    // Detect if attachments are present to enable Read tool
    let has_images = contains_image_attachment(&request.first_message);
    let has_text_files = contains_text_attachment(&request.first_message);
    let has_file_mentions = contains_file_mention(&request.first_message);
    let has_attachments = has_images || has_text_files || has_file_mentions;

    // Build prompt based on what we need to generate
    let base_prompt = if request.generate_session_name && request.generate_branch_name {
        let existing = if request.existing_branch_names.is_empty() {
            "(none)".to_string()
        } else {
            request.existing_branch_names.join("\n")
        };
        NAMING_PROMPT_BOTH
            .replace("{message}", &request.first_message)
            .replace("{existing_names}", &existing)
    } else if request.generate_session_name {
        let template = request
            .custom_session_prompt
            .as_ref()
            .filter(|p| !p.trim().is_empty())
            .map(|s| s.as_str())
            .unwrap_or(NAMING_PROMPT_SESSION_ONLY);
        template.replace("{message}", &request.first_message)
    } else {
        let existing = if request.existing_branch_names.is_empty() {
            "(none)".to_string()
        } else {
            request.existing_branch_names.join("\n")
        };
        NAMING_PROMPT_BRANCH_ONLY
            .replace("{message}", &request.first_message)
            .replace("{existing_names}", &existing)
    };

    // Prepend attachment instructions if attachments are present
    let prompt = match (has_images, has_text_files, has_file_mentions) {
        (true, true, true) => format!("{IMAGE_INSTRUCTION_PREFIX}{TEXT_INSTRUCTION_PREFIX}{FILE_MENTION_INSTRUCTION_PREFIX}{base_prompt}"),
        (true, true, false) => format!("{IMAGE_INSTRUCTION_PREFIX}{TEXT_INSTRUCTION_PREFIX}{base_prompt}"),
        (true, false, true) => format!("{IMAGE_INSTRUCTION_PREFIX}{FILE_MENTION_INSTRUCTION_PREFIX}{base_prompt}"),
        (true, false, false) => format!("{IMAGE_INSTRUCTION_PREFIX}{base_prompt}"),
        (false, true, true) => format!("{TEXT_INSTRUCTION_PREFIX}{FILE_MENTION_INSTRUCTION_PREFIX}{base_prompt}"),
        (false, true, false) => format!("{TEXT_INSTRUCTION_PREFIX}{base_prompt}"),
        (false, false, true) => format!("{FILE_MENTION_INSTRUCTION_PREFIX}{base_prompt}"),
        (false, false, false) => base_prompt,
    };

    // Route OpenCode models through OpenCode HTTP API.
    if request.model.starts_with("opencode/") {
        return generate_names_opencode(app, &prompt, &request.model, request);
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(&request.model) {
        return generate_names_codex(app, &prompt, &request.model, request);
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    let model_alias = get_cli_model_alias(&request.model);

    log::trace!(
        "Generating names with Claude CLI using model {model_alias}, has_images: {has_images}, has_text_files: {has_text_files}, has_file_mentions: {has_file_mentions}"
    );

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(
        &mut cmd,
        request.custom_profile_name.as_deref(),
    );
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model_alias,
        "--no-session-persistence",
    ]);

    if has_attachments {
        // Enable Read tool for attachment messages
        cmd.arg("--allowedTools").arg("Read");

        // Add directories for Claude to read attachments
        // In dev mode: full directory access (useful for debugging)
        // In prod mode: only specific directories (security)
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            if cfg!(debug_assertions) {
                cmd.arg("--add-dir").arg(&app_data_dir);
                log::trace!("Added full app data directory to naming scope: {app_data_dir:?}");
                if has_file_mentions {
                    cmd.arg("--add-dir").arg(&request.worktree_path);
                    log::trace!(
                        "Added worktree directory for file mentions: {:?}",
                        request.worktree_path
                    );
                }
            } else {
                if has_images {
                    let pasted_images = app_data_dir.join("pasted-images");
                    cmd.arg("--add-dir").arg(&pasted_images);
                    log::trace!("Added pasted-images directory to naming scope: {pasted_images:?}");
                }
                if has_text_files {
                    let pasted_texts = app_data_dir.join("pasted-texts");
                    cmd.arg("--add-dir").arg(&pasted_texts);
                    log::trace!("Added pasted-texts directory to naming scope: {pasted_texts:?}");
                }
                if has_file_mentions {
                    // File mentions reference files in the worktree
                    cmd.arg("--add-dir").arg(&request.worktree_path);
                    log::trace!(
                        "Added worktree directory for file mentions: {:?}",
                        request.worktree_path
                    );
                }
                // Always allow session-context for context loading
                let saved_contexts = app_data_dir.join("session-context");
                cmd.arg("--add-dir").arg(&saved_contexts);
                log::trace!("Added session-context directory to naming scope: {saved_contexts:?}");
            }
        }

        // 3 turns: tool call + tool result + final response
        cmd.arg("--max-turns").arg("3");
    } else {
        // No tools needed for text-only messages
        cmd.arg("--tools").arg("");
        cmd.arg("--max-turns").arg("1");
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin as stream-json format
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed (exit code {:?}): stderr={}, stdout={}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = extract_text_from_stream_json(&stdout)?;

    log::trace!("Claude generated naming response: {text}");

    // Strip markdown code fences if present (```json ... ```)
    let json_text = text
        .trim()
        .strip_prefix("```json")
        .or_else(|| text.trim().strip_prefix("```"))
        .unwrap_or(&text)
        .trim()
        .strip_suffix("```")
        .unwrap_or(&text)
        .trim();

    // Extract JSON object from text (Claude may include explanation text before the JSON)
    // Look for the JSON object pattern: {"session_name": ...} or {"branch_name": ...}
    let json_text = extract_json_object(json_text).unwrap_or(json_text);

    // Parse JSON response
    let naming_output: NamingOutput = serde_json::from_str(json_text)
        .map_err(|e| format!("Failed to parse naming JSON: {e}, raw: {json_text}"))?;

    Ok(naming_output)
}

/// Schema for Codex naming output
const NAMING_SCHEMA: &str = r#"{
    "type": "object",
    "properties": {
        "session_name": {
            "type": "string",
            "description": "A short, descriptive name for the session (2-6 words)"
        },
        "branch_name": {
            "type": "string",
            "description": "A git branch name in kebab-case (e.g. feat/add-dark-mode)"
        }
    }
}"#;

/// Generate names using Codex CLI with --output-schema
fn generate_names_codex(
    app: &tauri::AppHandle,
    prompt: &str,
    model: &str,
    request: &NamingRequest,
) -> Result<NamingOutput, String> {
    log::trace!("Generating names with Codex CLI using model {model}");
    let json_str = super::codex::execute_one_shot_codex(
        app,
        prompt,
        model,
        NAMING_SCHEMA,
        Some(&request.worktree_path),
    )?;
    log::trace!("Codex generated naming response: {json_str}");
    serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse Codex naming JSON: {e}, raw: {json_str}"))
}

fn choose_opencode_model(all_providers: &serde_json::Value) -> Option<(String, String)> {
    let connected = all_providers
        .get("connected")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let providers = all_providers
        .get("all")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for provider_id in connected.iter().filter_map(|v| v.as_str()) {
        for provider in &providers {
            if provider.get("id").and_then(|v| v.as_str()) != Some(provider_id) {
                continue;
            }
            if let Some(models) = provider.get("models").and_then(|v| v.as_object()) {
                if let Some((model_id, _)) = models.iter().next() {
                    return Some((provider_id.to_string(), model_id.to_string()));
                }
            }
        }
    }

    for provider in providers {
        let provider_id = match provider.get("id").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => continue,
        };
        let model_id = provider
            .get("models")
            .and_then(|v| v.as_object())
            .and_then(|o| o.keys().next())
            .cloned();
        if let Some(model_id) = model_id {
            return Some((provider_id.to_string(), model_id));
        }
    }

    None
}

fn parse_opencode_provider_model(model: Option<&str>) -> Option<(String, String)> {
    let raw = model?.trim();
    if raw.is_empty() {
        return None;
    }
    let (provider, model_id) = raw.split_once('/')?;
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider.to_string(), model_id.to_string()))
}

fn extract_text_from_opencode_parts(response_json: &serde_json::Value) -> String {
    response_json
        .get("parts")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Generate names using OpenCode HTTP API.
/// This path does not emit chat:* events, so it won't mutate active streaming UI.
fn generate_names_opencode(
    app: &tauri::AppHandle,
    prompt: &str,
    model: &str,
    request: &NamingRequest,
) -> Result<NamingOutput, String> {
    let base_url = crate::opencode_server::acquire(app)?;

    struct ServerReleaseGuard;
    impl Drop for ServerReleaseGuard {
        fn drop(&mut self) {
            crate::opencode_server::release();
        }
    }
    let _server_guard = ServerReleaseGuard;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to build OpenCode HTTP client: {e}"))?;

    let query = [(
        "directory",
        request.worktree_path.to_string_lossy().to_string(),
    )];

    let create_url = format!("{base_url}/session");
    let create_payload = serde_json::json!({
        "title": format!("Jean naming {}", request.session_id),
    });
    let create_resp = client
        .post(&create_url)
        .query(&query)
        .json(&create_payload)
        .send()
        .map_err(|e| format!("Failed to create OpenCode naming session: {e}"))?;
    if !create_resp.status().is_success() {
        let status = create_resp.status();
        let body = create_resp.text().unwrap_or_default();
        return Err(format!(
            "OpenCode naming session create failed: status={status}, body={body}"
        ));
    }
    let created: serde_json::Value = create_resp
        .json()
        .map_err(|e| format!("Failed to parse OpenCode naming session response: {e}"))?;
    let opencode_session_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("OpenCode naming session create response missing id")?
        .to_string();

    let selected_model = if let Some(pm) = parse_opencode_provider_model(Some(model)) {
        pm
    } else {
        let providers_url = format!("{base_url}/provider");
        let providers_resp = client
            .get(&providers_url)
            .query(&query)
            .send()
            .map_err(|e| format!("Failed to query OpenCode providers: {e}"))?;
        if !providers_resp.status().is_success() {
            let status = providers_resp.status();
            let body = providers_resp.text().unwrap_or_default();
            return Err(format!(
                "OpenCode provider query failed: status={status}, body={body}"
            ));
        }
        let providers: serde_json::Value = providers_resp
            .json()
            .map_err(|e| format!("Failed to parse OpenCode providers response: {e}"))?;
        choose_opencode_model(&providers)
            .ok_or("No OpenCode models available. Authenticate a provider first.")?
    };

    let msg_url = format!("{base_url}/session/{opencode_session_id}/message");
    let payload = serde_json::json!({
        "agent": "plan",
        "model": {
            "providerID": selected_model.0,
            "modelID": selected_model.1,
        },
        "parts": [
            {
                "type": "text",
                "text": prompt,
            }
        ],
    });

    let response = client
        .post(msg_url)
        .query(&query)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to send OpenCode naming request: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "OpenCode naming message failed: status={status}, body={body}"
        ));
    }

    let response_json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Failed to parse OpenCode naming response: {e}"))?;
    let text = extract_text_from_opencode_parts(&response_json);
    log::trace!("OpenCode generated naming response: {text}");

    let json_text = text
        .trim()
        .strip_prefix("```json")
        .or_else(|| text.trim().strip_prefix("```"))
        .unwrap_or(&text)
        .trim()
        .strip_suffix("```")
        .unwrap_or(&text)
        .trim();
    let json_text = extract_json_object(json_text).unwrap_or(json_text);

    serde_json::from_str(json_text)
        .map_err(|e| format!("Failed to parse OpenCode naming JSON: {e}, raw: {json_text}"))
}

/// Validate and sanitize a session name
fn validate_session_name(name: &str) -> Result<String, String> {
    let name = name.trim();

    if name.to_lowercase().starts_with("error: reached max turns") {
        return Err("CLI returned error message instead of session name".to_string());
    }

    // Sanitize: keep only alphanumeric and spaces
    let sanitized: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();

    let sanitized: String = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");

    // Enforce word limit (4 words max)
    let words: Vec<&str> = sanitized.split_whitespace().collect();
    let final_name = if words.len() > 6 {
        words[..6].join(" ")
    } else {
        sanitized
    };

    if final_name.is_empty() {
        return Err("Generated session name is empty".to_string());
    }

    // Enforce character limit (50 chars max)
    let final_name = if final_name.len() > 50 {
        final_name[..50].trim().to_string()
    } else {
        final_name
    };

    Ok(final_name)
}

/// Validate and sanitize a branch name
fn validate_branch_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_lowercase();

    if name.starts_with("error: reached max turns") {
        return Err("CLI returned error message instead of branch name".to_string());
    }

    // Remove any type prefix if Claude accidentally included one
    let name = name
        .strip_prefix("feat/")
        .or_else(|| name.strip_prefix("fix/"))
        .or_else(|| name.strip_prefix("docs/"))
        .or_else(|| name.strip_prefix("refactor/"))
        .or_else(|| name.strip_prefix("test/"))
        .or_else(|| name.strip_prefix("chore/"))
        .or_else(|| name.strip_prefix("style/"))
        .or_else(|| name.strip_prefix("perf/"))
        .unwrap_or(&name);

    // Sanitize: keep only alphanumeric and hyphens
    let sanitized: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();

    let sanitized = sanitized.trim_matches('-').to_string();

    // Enforce length limit
    let final_name = if sanitized.len() > 50 {
        sanitized[..50].to_string()
    } else {
        sanitized
    };

    if final_name.is_empty() {
        return Err("Generated branch name is empty".to_string());
    }

    Ok(final_name)
}

/// Apply session name to storage
fn apply_session_name(
    app: &AppHandle,
    request: &NamingRequest,
    new_name: &str,
) -> Result<SessionNameResult, NamingError> {
    let worktree_path_str = request.worktree_path.to_string_lossy();
    let new_name_owned = new_name.to_string();

    with_sessions_mut(app, &worktree_path_str, &request.worktree_id, |sessions| {
        let session = sessions
            .find_session_mut(&request.session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let old_name = session.name.clone();

        if old_name == new_name_owned {
            return Ok(SessionNameResult {
                session_id: request.session_id.clone(),
                worktree_id: request.worktree_id.clone(),
                old_name,
                new_name: new_name_owned.clone(),
            });
        }

        session.name = new_name_owned.clone();

        Ok(SessionNameResult {
            session_id: request.session_id.clone(),
            worktree_id: request.worktree_id.clone(),
            old_name,
            new_name: new_name_owned.clone(),
        })
    })
    .map_err(|e| NamingError {
        session_id: Some(request.session_id.clone()),
        worktree_id: request.worktree_id.clone(),
        error: e,
        stage: NamingStage::SessionStorage,
    })
}

/// Apply branch name via git rename
fn apply_branch_name(
    app: &AppHandle,
    request: &NamingRequest,
    new_name: &str,
) -> Result<BranchNameResult, NamingError> {
    let worktree_path_str = request.worktree_path.to_string_lossy();

    let old_branch = git::get_current_branch(&worktree_path_str).map_err(|e| NamingError {
        session_id: None,
        worktree_id: request.worktree_id.clone(),
        error: e,
        stage: NamingStage::GitRename,
    })?;

    if old_branch == new_name {
        return Ok(BranchNameResult {
            worktree_id: request.worktree_id.clone(),
            old_branch,
            new_branch: new_name.to_string(),
        });
    }

    let final_branch_name =
        git::rename_branch(&worktree_path_str, new_name).map_err(|e| NamingError {
            session_id: None,
            worktree_id: request.worktree_id.clone(),
            error: e,
            stage: NamingStage::GitRename,
        })?;

    // Update worktree metadata
    if let Ok(mut data) = load_projects_data(app) {
        if let Some(worktree) = data.find_worktree_mut(&request.worktree_id) {
            worktree.name = final_branch_name.clone();
            worktree.branch = final_branch_name.clone();
            let _ = save_projects_data(app, &data);
        }
    }

    Ok(BranchNameResult {
        worktree_id: request.worktree_id.clone(),
        old_branch,
        new_branch: final_branch_name,
    })
}

/// Execute the combined naming workflow
fn execute_naming(app: &AppHandle, request: &NamingRequest) {
    // Skip if nothing to generate
    if !request.generate_session_name && !request.generate_branch_name {
        return;
    }

    // Generate names
    let naming_result = match generate_names(app, request) {
        Ok(result) => result,
        Err(e) => {
            log::warn!("Naming generation failed: {e}");
            let error = NamingError {
                session_id: if request.generate_session_name {
                    Some(request.session_id.clone())
                } else {
                    None
                },
                worktree_id: request.worktree_id.clone(),
                error: e,
                stage: NamingStage::Generation,
            };
            let _ = app.emit_all("naming-failed", &error);
            return;
        }
    };

    // Apply session name if requested and generated
    if request.generate_session_name {
        if let Some(session_name) = &naming_result.session_name {
            match validate_session_name(session_name) {
                Ok(validated_name) => match apply_session_name(app, request, &validated_name) {
                    Ok(result) => {
                        log::trace!(
                            "Session renamed from '{}' to '{}'",
                            result.old_name,
                            result.new_name
                        );
                        let _ = app.emit_all("session-renamed", &result);
                    }
                    Err(error) => {
                        log::warn!("Session naming storage failed: {}", error.error);
                        let _ = app.emit_all("session-naming-failed", &error);
                    }
                },
                Err(e) => {
                    log::warn!("Session name validation failed: {e}");
                    let error = NamingError {
                        session_id: Some(request.session_id.clone()),
                        worktree_id: request.worktree_id.clone(),
                        error: e,
                        stage: NamingStage::Validation,
                    };
                    let _ = app.emit_all("session-naming-failed", &error);
                }
            }
        } else {
            log::warn!("No session name in response");
        }
    }

    // Apply branch name if requested and generated
    if request.generate_branch_name {
        if let Some(branch_name) = &naming_result.branch_name {
            match validate_branch_name(branch_name) {
                Ok(validated_name) => match apply_branch_name(app, request, &validated_name) {
                    Ok(result) => {
                        log::trace!(
                            "Branch renamed from '{}' to '{}'",
                            result.old_branch,
                            result.new_branch
                        );
                        let _ = app.emit_all("branch-renamed", &result);
                    }
                    Err(error) => {
                        log::warn!("Branch naming failed: {}", error.error);
                        let _ = app.emit_all("branch-naming-failed", &error);
                    }
                },
                Err(e) => {
                    log::warn!("Branch name validation failed: {e}");
                    let error = NamingError {
                        session_id: None,
                        worktree_id: request.worktree_id.clone(),
                        error: e,
                        stage: NamingStage::Validation,
                    };
                    let _ = app.emit_all("branch-naming-failed", &error);
                }
            }
        } else {
            log::warn!("No branch name in response");
        }
    }
}

/// Spawn a background task to generate and apply names
///
/// This function returns immediately and performs the work in a background thread.
/// Results are emitted as Tauri events:
/// - `session-renamed`: On session name success
/// - `session-naming-failed`: On session name failure
/// - `branch-renamed`: On branch name success
/// - `branch-naming-failed`: On branch name failure
pub fn spawn_naming_task(app: AppHandle, request: NamingRequest) {
    log::trace!(
        "Spawning naming task for session: {}, worktree: {} (session: {}, branch: {})",
        request.session_id,
        request.worktree_id,
        request.generate_session_name,
        request.generate_branch_name
    );

    std::thread::spawn(move || {
        execute_naming(&app, &request);
    });
}

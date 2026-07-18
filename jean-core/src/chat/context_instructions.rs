use serde::Serialize;

use crate::projects::github_issues::{
    get_github_contexts_dir, get_session_advisory_refs, get_session_issue_refs,
    get_session_pr_refs, get_session_security_refs,
};
use crate::projects::linear_issues::get_session_linear_refs;
use crate::projects::sentry_issues::get_session_sentry_refs;
use crate::projects::storage::load_projects_data;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalContextBackend {
    Claude,
    Codex,
    Opencode,
    Cursor,
    Pi,
    Commandcode,
}

impl TerminalContextBackend {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "cursor" => Some(Self::Cursor),
            "pi" => Some(Self::Pi),
            "commandcode" => Some(Self::Commandcode),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedBackendTerminalContext {
    pub command_args: Vec<String>,
}

fn trimmed_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn load_preferences(app: &tauri::AppHandle) -> Option<crate::AppPreferences> {
    let prefs_path = crate::get_preferences_path(app).ok()?;
    let contents = std::fs::read_to_string(prefs_path).ok()?;
    serde_json::from_str::<crate::AppPreferences>(&contents).ok()
}

fn build_system_prompt_parts(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Vec<String> {
    let prefs = load_preferences(app);
    let mut parts = Vec::new();

    if let Some(lang) = prefs
        .as_ref()
        .and_then(|prefs| trimmed_non_empty(Some(&prefs.ai_language)))
    {
        parts.push(format!("Respond to the user in {lang}."));
    }

    let global_prompt = prefs
        .as_ref()
        .and_then(|prefs| trimmed_non_empty(prefs.magic_prompts.global_system_prompt.as_deref()))
        .unwrap_or_else(crate::default_global_system_prompt);
    parts.push(global_prompt);

    if prefs
        .as_ref()
        .is_some_and(|prefs| prefs.parallel_execution_prompt_enabled)
    {
        let parallel_prompt = prefs
            .as_ref()
            .and_then(|prefs| trimmed_non_empty(prefs.magic_prompts.parallel_execution.as_deref()))
            .unwrap_or_else(crate::default_parallel_execution_prompt);
        parts.push(parallel_prompt);
    }

    if let Ok(data) = load_projects_data(app) {
        if let Some(worktree) = data.find_worktree(worktree_id) {
            if let Some(project) = data.find_project(&worktree.project_id) {
                if let Some(prompt) = trimmed_non_empty(project.custom_system_prompt.as_deref()) {
                    parts.push(prompt);
                }

                let linked_paths: Vec<String> = project
                    .linked_project_ids
                    .iter()
                    .filter_map(|id| data.find_project(id))
                    .filter_map(|project| trimmed_non_empty(Some(&project.path)))
                    .collect();
                if !linked_paths.is_empty() {
                    let dirs_list = linked_paths
                        .iter()
                        .map(|path| format!("- {path}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    parts.push(format!(
                        "This project is linked to other projects for cross-project context. \
                         Check the following directories for additional instructions and documentation \
                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                    ));
                }
            }
        }
    }

    let gh_binary = crate::gh_cli::config::resolve_gh_binary(app);
    if gh_binary != std::path::PathBuf::from("gh") {
        parts.push(format!(
            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
             Do NOT use bare `gh` — always use the full path above.",
            gh_binary.display()
        ));
    }
    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(app) {
        if claude_binary.exists() {
            parts.push(format!(
                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                 Do NOT use bare `claude` — always use the full path above.",
                claude_binary.display()
            ));
        }
    }
    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(app) {
        if codex_binary.exists() {
            parts.push(format!(
                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                 Do NOT use bare `codex` — always use the full path above.",
                codex_binary.display()
            ));
        }
    }

    if super::should_add_recap_instruction(app) {
        parts.push(super::RECAP_INSTRUCTION.to_string());
    }

    log::debug!(
        "Prepared {} system prompt parts for backend terminal session {session_id}",
        parts.len()
    );

    parts
}

fn collect_context_paths(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    let mut issue_keys = get_session_issue_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_issue_refs(app, worktree_id) {
        for key in wt_keys {
            if !issue_keys.contains(&key) {
                issue_keys.push(key);
            }
        }
    }
    if !issue_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in issue_keys {
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let file_path =
                        contexts_dir.join(format!("{}-issue-{}.md", parts[1], parts[0]));
                    if file_path.exists() {
                        paths.push(file_path);
                    }
                }
            }
        }
    }

    let mut pr_keys = get_session_pr_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_pr_refs(app, worktree_id) {
        for key in wt_keys {
            if !pr_keys.contains(&key) {
                pr_keys.push(key);
            }
        }
    }
    if !pr_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in pr_keys {
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let file_path = contexts_dir.join(format!("{}-pr-{}.md", parts[1], parts[0]));
                    if file_path.exists() {
                        paths.push(file_path);
                    }
                }
            }
        }
    }

    let mut security_keys = get_session_security_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_security_refs(app, worktree_id) {
        for key in wt_keys {
            if !security_keys.contains(&key) {
                security_keys.push(key);
            }
        }
    }
    if !security_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in security_keys {
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let file_path =
                        contexts_dir.join(format!("{}-security-{}.md", parts[1], parts[0]));
                    if file_path.exists() {
                        paths.push(file_path);
                    }
                }
            }
        }
    }

    let mut advisory_keys = get_session_advisory_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_advisory_refs(app, worktree_id) {
        for key in wt_keys {
            if !advisory_keys.contains(&key) {
                advisory_keys.push(key);
            }
        }
    }
    if !advisory_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in advisory_keys {
                if let Some((repo_key, ghsa_id)) = key.split_once("::") {
                    let file_path = contexts_dir.join(format!("{repo_key}-advisory-{ghsa_id}.md"));
                    if file_path.exists() {
                        paths.push(file_path);
                    }
                }
            }
        }
    }

    let mut linear_keys = get_session_linear_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_linear_refs(app, worktree_id) {
        for key in wt_keys {
            if !linear_keys.contains(&key) {
                linear_keys.push(key);
            }
        }
    }
    if !linear_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in linear_keys {
                let parts: Vec<&str> = key.rsplitn(3, '-').collect();
                if parts.len() == 3 {
                    let identifier_lower = format!("{}-{}", parts[1].to_lowercase(), parts[0]);
                    let file_path =
                        contexts_dir.join(format!("{}-linear-{identifier_lower}.md", parts[2]));
                    if file_path.exists() {
                        paths.push(file_path);
                    }
                }
            }
        }
    }

    let mut sentry_keys = get_session_sentry_refs(app, session_id).unwrap_or_default();
    if let Ok(worktree_keys) = get_session_sentry_refs(app, worktree_id) {
        for key in worktree_keys {
            if !sentry_keys.contains(&key) {
                sentry_keys.push(key);
            }
        }
    }
    if let Ok(contexts_dir) = get_github_contexts_dir(app) {
        for key in sentry_keys {
            if let Some((project_name, issue_id)) = key.split_once("::") {
                let path = contexts_dir.join(format!("{project_name}-sentry-{issue_id}.md"));
                if path.exists() {
                    paths.push(path);
                }
            }
        }
    }

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let saved_contexts_dir = app_data_dir.join("session-context");
        if saved_contexts_dir.exists() {
            let prefix = format!("{session_id}-context-");
            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                let mut context_files: Vec<_> = entries
                    .flatten()
                    .filter(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        name.starts_with(&prefix) && name.ends_with(".md")
                    })
                    .collect();
                context_files.sort_by_key(|entry| entry.file_name());
                paths.extend(context_files.into_iter().map(|entry| entry.path()));
            }
        }
    }

    paths
}

pub fn build_combined_terminal_context_content(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> String {
    let system_prompt_parts = build_system_prompt_parts(app, session_id, worktree_id);
    let context_paths = collect_context_paths(app, session_id, worktree_id);

    let mut content = String::new();
    if !system_prompt_parts.is_empty() {
        content.push_str("# Instructions\n\n");
        for part in &system_prompt_parts {
            content.push_str(part);
            content.push('\n');
        }
        content.push_str("\n---\n\n");
    }

    if !context_paths.is_empty() {
        content.push_str("# Loaded Context\n\n");
        content.push_str(
            "The following context has been loaded. You should be aware of this when working on this task.\n\n---\n\n",
        );
        for path in context_paths {
            if let Ok(file_content) = std::fs::read_to_string(path) {
                content.push_str(&file_content);
                content.push_str("\n\n---\n\n");
            }
        }
    }

    content
}

pub fn write_combined_terminal_context_file(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let combined_dir = app_data_dir.join("combined-contexts");
    std::fs::create_dir_all(&combined_dir)
        .map_err(|e| format!("Failed to create combined context directory: {e}"))?;

    let file_path = combined_dir.join(format!("{session_id}-terminal-context.md"));
    let content = build_combined_terminal_context_content(app, session_id, worktree_id);
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write terminal context file: {e}"))?;
    Ok(file_path)
}

fn toml_basic_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub fn prepare_backend_terminal_context(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    backend: TerminalContextBackend,
) -> Result<PreparedBackendTerminalContext, String> {
    let context_file = write_combined_terminal_context_file(app, session_id, worktree_id)?;
    let command_args = match backend {
        TerminalContextBackend::Claude => vec![
            "--append-system-prompt-file".to_string(),
            context_file.to_string_lossy().to_string(),
        ],
        TerminalContextBackend::Codex => {
            let content = std::fs::read_to_string(&context_file)
                .map_err(|e| format!("Failed to read terminal context file: {e}"))?;
            vec![
                "--config".to_string(),
                format!("base_instructions={}", toml_basic_string(&content)),
            ]
        }
        TerminalContextBackend::Opencode
        | TerminalContextBackend::Cursor
        | TerminalContextBackend::Pi
        | TerminalContextBackend::Commandcode => Vec::new(),
    };

    Ok(PreparedBackendTerminalContext { command_args })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_basic_string_escapes_multiline_context() {
        let encoded = toml_basic_string("hello\n\"quoted\"");
        assert_eq!(encoded, "\"hello\\n\\\"quoted\\\"\"");
    }
}

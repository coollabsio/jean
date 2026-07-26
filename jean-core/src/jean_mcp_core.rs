//! Shared Jean MCP tool registry/dispatch plus local stdio proxy helpers.
//!
//! Transport-specific frontends (HTTP and stdio) should keep protocol framing
//! only. Business logic lives here and routes to existing Jean commands.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::types::LabelData;
use crate::http_server::dispatch::dispatch_command;

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
pub const JEAN_MCP_STDIO_ARG: &str = "--jean-mcp-stdio";
pub const JEAN_MCP_SOCKET_ENV: &str = "JEAN_MCP_SOCKET";
pub const JEAN_MCP_TOKEN_ENV: &str = "JEAN_MCP_TOKEN";
pub const JEAN_MCP_SESSION_ENV: &str = "JEAN_MCP_SESSION";
pub const JEAN_MCP_DEPTH_ENV: &str = "JEAN_MCP_DEPTH";

const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMITED_TOOLS: &[&str] = &[
    "add_project",
    "archive_session",
    "archive_worktree",
    "cancel_session_run",
    "clone_project",
    "create_commit",
    "create_pull_request",
    "create_session",
    "create_worktree",
    "create_worktree_from_existing_branch",
    "delete_worktree",
    "import_worktree",
    "init_project",
    "merge_pull_request",
    "permanently_delete_worktree",
    "push_worktree",
    "run_review",
    "send_chat_message",
    "set_session_model",
    "unarchive_session",
    "unarchive_worktree",
];
const DEFAULT_MCP_DIFF_MAX_BYTES: usize = 60_000;
const MAX_MCP_DIFF_BYTES: usize = 200_000;
const DEFAULT_LABEL_COLOR: &str = "#eab308";

static RATE_BUCKETS: Lazy<std::sync::Mutex<HashMap<String, VecDeque<Instant>>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(Debug)]
pub struct ToolError {
    pub code: i32,
    pub message: String,
}

impl ToolError {
    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: msg.into(),
        }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: msg.into(),
        }
    }
}

pub fn current_depth() -> u32 {
    std::env::var(JEAN_MCP_DEPTH_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

pub fn next_depth() -> u32 {
    current_depth().saturating_add(1)
}

pub fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "jean", "version": env!("CARGO_PKG_VERSION") },
    })
}

pub fn tools_list_result() -> Value {
    json!({ "tools": tool_registry() })
}

#[derive(Debug)]
pub struct ToolCallRequest {
    pub name: String,
    pub arguments: Value,
}

pub fn extract_tool_call(params: Value) -> Result<ToolCallRequest, ToolError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolError::invalid_params("missing 'name'"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(ToolCallRequest { name, arguments })
}

pub fn handle_protocol_message(
    body: Value,
    call_tool: impl FnMut(ToolCallRequest) -> Result<Value, String>,
) -> Option<Value> {
    let id = body.get("id").cloned();
    let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => Some(jsonrpc_ok(id, initialize_result())),
        "notifications/initialized" => None,
        "tools/list" => Some(jsonrpc_ok(id, tools_list_result())),
        "tools/call" => Some(
            match extract_tool_call(params)
                .map_err(|e| e.message)
                .and_then(call_tool)
            {
                Ok(result) => jsonrpc_ok(id, result),
                Err(e) => jsonrpc_error(id, -32000, &e),
            },
        ),
        "ping" => Some(jsonrpc_ok(id, json!({}))),
        _ => Some(jsonrpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        )),
    }
}

pub fn tool_registry() -> Value {
    // Split into multiple json! arrays so the macro does not hit recursion_limit.
    let mut tools = tool_registry_core()
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(session) = tool_registry_session().as_array() {
        tools.extend(session.iter().cloned());
    }
    if let Some(ship) = tool_registry_ship_loop().as_array() {
        tools.extend(ship.iter().cloned());
    }
    Value::Array(tools)
}

fn tool_registry_core() -> Value {
    json!([
        {"name":"list_projects","description":"List all Jean projects (id, name, path, default_branch).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"add_project","description":"Add an existing local git repository as a Jean project. Path must already be a git repo (use init_project for a new folder, or clone_project for a remote URL). Returns the created project (id, name, path, default_branch).","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to an existing local git repository."},"parentId":{"type":"string","description":"Optional Jean folder/project parent id for nesting in the project list."}},"required":["path"],"additionalProperties":false}},
        {"name":"clone_project","description":"Clone a remote git repository to a local path and add it as a Jean project. Returns the created project.","inputSchema":{"type":"object","properties":{"url":{"type":"string","description":"Git remote URL to clone (https or ssh)."},"path":{"type":"string","description":"Absolute local path where the repo should be cloned."},"parentId":{"type":"string","description":"Optional Jean folder/project parent id for nesting in the project list."}},"required":["url","path"],"additionalProperties":false}},
        {"name":"init_project","description":"Create a new git repository at path (creating the directory if needed) and add it as a Jean project. Use add_project instead when the path is already a git repo. Returns the created project.","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Absolute path for the new project directory."},"parentId":{"type":"string","description":"Optional Jean folder/project parent id for nesting in the project list."}},"required":["path"],"additionalProperties":false}},
        {"name":"list_worktrees","description":"List all worktrees for a project.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"get_worktree","description":"Get a single worktree by id (path, branch, status, etc.).","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"get_project_context","description":"Get project-level context needed by orchestration agents: project settings, linked projects, default branch/backend, and worktree counts. Does not read arbitrary repo files.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"list_github_issues","description":"List GitHub issues for a project. Pass projectId; the server resolves the repo path.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"state":{"type":"string","enum":["open","closed","all"],"default":"open"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"list_github_prs","description":"List GitHub pull requests for a project. Pass projectId; the server resolves the repo path.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"state":{"type":"string","enum":["open","closed","merged","all"],"default":"open"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"list_security_issues","description":"List Dependabot security alerts for a project using the same backend command as the UI. Pass projectId; the server resolves the repo path.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"state":{"type":"string","enum":["open","dismissed","fixed","auto_dismissed","all"],"default":"open"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"list_security_advisories","description":"List repository security advisories for a project using the same backend command as the UI. Pass projectId; the server resolves the repo path.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"state":{"type":"string","enum":["draft","published","triage","closed","all"],"default":"all"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"list_linear_issues","description":"List Linear issues for a project using the same backend command as the UI. Pass projectId; Linear API config is resolved from project/global settings.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}},
        {"name":"create_worktree","description":"Create a new worktree for a project. Provide issueNumber or prNumber for a GitHub issue/PR, linearIssueIdentifier (e.g. \"PLA-215\") for a Linear issue, or ghsaId (e.g. \"GHSA-xxxx-xxxx-xxxx\") for a repository security advisory; these are mutually exclusive. Jean fetches the chosen context and attaches it to the worktree, reusing the same branch naming and context-loading as the Jean UI. Pass action=\"start_autoinvestigating\" to create a session and start investigating (and magic-fix when the Magic Prompts execution mode is yolo) the issue/PR/Linear issue/security advisory with the Magic Prompts settings default backend/model. This never switches/opens Jean's UI unless the user opens the worktree separately.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"baseBranch":{"type":"string"},"customName":{"type":"string"},"issueNumber":{"type":"integer","minimum":1},"prNumber":{"type":"integer","minimum":1},"linearIssueIdentifier":{"type":"string","description":"Linear issue identifier like \"PLA-215\". Mutually exclusive with issueNumber/prNumber/ghsaId."},"ghsaId":{"type":"string","description":"Repository security advisory GHSA id like \"GHSA-xxxx-xxxx-xxxx\". Mutually exclusive with issueNumber/prNumber/linearIssueIdentifier."},"action":{"type":"string","enum":["start_autoinvestigating"]}},"required":["projectId"],"additionalProperties":false}},
        {"name":"create_worktree_from_existing_branch","description":"Create a Jean worktree from an existing local or remote-tracking branch (branch name is used as the worktree name). Does not open Jean's UI. Prefer create_worktree for new branches; use this when the branch already exists.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"branchName":{"type":"string","description":"Existing branch name to check out into a new worktree path."}},"required":["projectId","branchName"],"additionalProperties":false}},
        {"name":"import_worktree","description":"Import an existing git worktree/directory on disk into a Jean project. Path must already exist and be a git worktree or repo. Does not create a new git worktree.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"path":{"type":"string","description":"Absolute path to an existing git worktree directory."}},"required":["projectId","path"],"additionalProperties":false}},
        {"name":"rename_worktree","description":"Rename a worktree's display name in Jean (does not rename the git branch or folder).","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"newName":{"type":"string","description":"New display name. Must be unique within the project."}},"required":["worktreeId","newName"],"additionalProperties":false}},
        {"name":"archive_worktree","description":"Archive a worktree (hide from the active project canvas). Cancels running sessions for the worktree. Base sessions cannot be archived. Prefer this over delete when work may still be needed.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"unarchive_worktree","description":"Restore an archived worktree to the active project canvas. Fails if the worktree directory no longer exists on disk.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"list_archived_worktrees","description":"List archived worktrees. Optionally filter by projectId. Active worktrees are not included (use list_worktrees for those).","inputSchema":{"type":"object","properties":{"projectId":{"type":"string","description":"Optional project id to filter archived worktrees."}},"additionalProperties":false}},
        {"name":"delete_worktree","description":"Start permanently deleting an active (non-archived) worktree in the background: removes Jean tracking, git worktree, and branch. Returns started=true when cleanup is accepted, not completion. Destructive and irreversible when cleanup succeeds. Cannot delete base sessions. Prefer archive_worktree when unsure.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"permanently_delete_worktree","description":"Start permanently deleting an already-archived worktree in the background (storage + git worktree/branch cleanup). Returns started=true when cleanup is accepted, not completion. Fails immediately if the worktree is not archived — archive it first, or use delete_worktree for active worktrees.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"update_worktree_labels","description":"Update native Jean worktree labels. Use action=add/remove/set/clear. Returns the updated worktree.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"action":{"type":"string","enum":["add","remove","set","clear"]},"label":{"type":"object","properties":{"name":{"type":"string"},"color":{"type":"string","description":"Hex color like #eab308. Optional for add; ignored by remove."},"pinned":{"type":"boolean","description":"Show this label as a project-view filter tab for the current project."}},"required":["name"],"additionalProperties":false},"labels":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"color":{"type":"string"},"pinned":{"type":"boolean","description":"Show this label as a project-view filter tab for the current project."}},"required":["name","color"],"additionalProperties":false}}},"required":["worktreeId","action"],"additionalProperties":false}}
    ])
}

fn tool_registry_session() -> Value {
    json!([
        {"name":"list_sessions","description":"List chat sessions in a worktree without loading full message history. Use before creating a session to avoid duplicates.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"includeArchived":{"type":"boolean","default":false}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"create_session","description":"Create a new chat session in an existing non-archived worktree. Returns the session id needed for send_chat_message. Fails if the worktree is archived — call unarchive_worktree first.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"name":{"type":"string"},"backend":{"type":"string","enum":["claude","codex","cursor","opencode"]}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"send_chat_message","description":"Send a message to an existing non-archived session. Fire-and-forget: returns immediately as the session begins processing. Fails immediately if the session or its worktree is archived — call unarchive_session / unarchive_worktree first. Use this to kick off investigations.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"},"message":{"type":"string"},"model":{"type":"string"},"executionMode":{"type":"string","enum":["plan","build","yolo"]}},"required":["sessionId","message"],"additionalProperties":false}},
        {"name":"archive_session","description":"Archive a chat session (hide it from the active session list). Prefer this over delete when history may still be useful. Cannot run send_chat_message on an archived session until unarchive_session is called.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"],"additionalProperties":false}},
        {"name":"unarchive_session","description":"Restore an archived chat session so it can run again. Also unarchives the parent worktree when it is archived. Call this before send_chat_message if a previous attempt failed because the session was archived.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"],"additionalProperties":false}},
        {"name":"get_session_status","description":"Get whether a Jean session is idle/running/resumable/cancelled/error plus latest run metadata. Use after send_chat_message to poll fire-and-forget work.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"],"additionalProperties":false}},
        {"name":"cancel_session_run","description":"Cancel the currently running request for a session. Returns whether Jean found an active process/turn/flag to cancel.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"],"additionalProperties":false}},
        {"name":"read_session_messages","description":"Read recent messages from a session (most recent first). Use limit to cap returned messages.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200,"default":50}},"required":["sessionId"],"additionalProperties":false}},
        {"name":"set_session_model","description":"Persist the selected model (and optionally backend) on a Jean session without sending a message. Prefer this when switching models for later turns; pass model on send_chat_message for a one-shot override only. When backend is omitted, Jean infers it from the model id when possible (e.g. grok/*, gpt-*, cursor/*). Returns sessionId, model, backend.","inputSchema":{"type":"object","properties":{"sessionId":{"type":"string"},"model":{"type":"string","description":"Model id as used in Jean (e.g. claude-sonnet-4-6[1m], gpt-5.6-sol, grok/grok-4.5)."},"backend":{"type":"string","enum":["claude","codex","cursor","opencode","pi","commandcode","grok","kimi"],"description":"Optional backend override. Inferred from model when omitted."}},"required":["sessionId","model"],"additionalProperties":false}},
        {"name":"get_usage","description":"Fetch subscription/usage snapshots for Claude, Codex, and/or Grok (same data as Jean Settings → Usage). Use to decide whether to switch models when a plan is near limits. Optional backend filters to one provider; omit or pass \"all\" for every available snapshot. Per-backend failures are reported in errors without failing the whole call.","inputSchema":{"type":"object","properties":{"backend":{"type":"string","enum":["claude","codex","grok","all"],"default":"all","description":"Which provider usage to fetch. Default all."}},"additionalProperties":false}},
        {"name":"get_worktree_changes","description":"Get a bounded summary of a worktree's git changes: porcelain status, ahead/behind counts, diff stats, and changed files. Does not return full diffs.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"maxFiles":{"type":"integer","minimum":1,"maximum":500,"default":100}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"get_worktree_diff","description":"Get a bounded unified git diff for a worktree. diffType is uncommitted (HEAD vs working tree) or branch (origin/base...HEAD). Optional path limits to one pathspec; maxBytes is capped.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"diffType":{"type":"string","enum":["uncommitted","branch"],"default":"uncommitted"},"path":{"type":"string"},"maxBytes":{"type":"integer","minimum":1,"maximum":200000,"default":60000}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"get_current_context","description":"Return the calling session's context: sessionId, worktreeId, projectId, projectPath, projectName. Use this so the agent knows what 'this project' refers to without guessing.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ])
}

fn tool_registry_ship_loop() -> Value {
    json!([
        {"name":"create_commit","description":"Stage changes and create a git commit with an AI-generated message (same path as Jean UI Commit). Optional push after commit. Use specificFiles to stage only some paths; omit to stage all. Returns commitHash, message, pushed flags.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"push":{"type":"boolean","default":false,"description":"Push after a successful commit (or push existing unpushed commits when there is nothing new to commit)."},"remote":{"type":"string","description":"Optional git remote name for push."},"prNumber":{"type":"integer","minimum":1,"description":"Optional linked PR number for PR-aware push (fork remotes / force-with-lease)."},"specificFiles":{"type":"array","items":{"type":"string"},"description":"Optional list of paths to stage instead of staging everything."},"customPrompt":{"type":"string","description":"Optional override for the commit-message magic prompt."},"model":{"type":"string"},"reasoningEffort":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"push_worktree","description":"Push the current branch for a worktree (same path as Jean UI push). Optionally pass prNumber for PR-aware push.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"remote":{"type":"string","description":"Optional git remote name."},"prNumber":{"type":"integer","minimum":1,"description":"Optional PR number for PR-aware push."}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"detect_open_pr","description":"Detect whether the worktree's current branch already has an open GitHub PR. Returns the PR (number, url, title) or null when none exists. Call before create_pull_request to avoid duplicates.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"create_pull_request","description":"Create a GitHub PR for the worktree with AI-generated title/body (same path as Jean UI Open PR). Stages and commits uncommitted changes when needed, pushes the branch, and opens the PR against the project default branch. Returns prNumber, prUrl, title, existing. Prefer detect_open_pr first when unsure.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"sessionId":{"type":"string","description":"Optional Jean session id for context when generating PR content."},"customPrompt":{"type":"string","description":"Optional override for the PR-content magic prompt."},"model":{"type":"string"},"reasoningEffort":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"merge_pull_request","description":"Merge the open GitHub PR for the worktree's current branch using gh (same path as Jean UI merge). Uses the repo-allowed merge method (prefers squash). Fails if there is no open mergeable PR.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}},
        {"name":"run_review","description":"Run Jean's AI code review on the worktree branch (same path as Jean UI Review). Returns summary, findings, and approvalStatus. Does not commit or open a PR.","inputSchema":{"type":"object","properties":{"worktreeId":{"type":"string"},"customPrompt":{"type":"string","description":"Optional override for the review magic prompt."},"model":{"type":"string"},"backend":{"type":"string","description":"Optional magic-prompt backend override (e.g. claude, codex)."},"reasoningEffort":{"type":"string"}},"required":["worktreeId"],"additionalProperties":false}}
    ])
}

pub async fn call_tool(
    app: &AppHandle,
    name: &str,
    arguments: Value,
    source: &str,
    depth: u32,
) -> Result<Value, ToolError> {
    let prefs = crate::load_preferences(app.clone())
        .await
        .map_err(ToolError::internal)?;
    if !prefs.jean_mcp_enabled {
        return Err(ToolError::internal(
            "Jean MCP is disabled. Enable it in Preferences > MCP Servers.",
        ));
    }

    if RATE_LIMITED_TOOLS.contains(&name) {
        if depth > prefs.jean_mcp_max_depth {
            return Err(ToolError::internal(format!(
                "Jean MCP recursion depth {depth} exceeds limit {}",
                prefs.jean_mcp_max_depth
            )));
        }
        if !rate_check(source, name, prefs.jean_mcp_rate_limit_per_minute) {
            return Err(ToolError::internal(format!(
                "Jean MCP rate limit exceeded ({} calls/min for source {source}, tool {name})",
                prefs.jean_mcp_rate_limit_per_minute
            )));
        }
    }

    let result_json = run_tool(app, name, arguments, source).await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&result_json).unwrap_or_else(|_| "null".to_string()),
        }],
        "isError": false,
    }))
}

async fn run_tool(
    app: &AppHandle,
    name: &str,
    args: Value,
    source: &str,
) -> Result<Value, ToolError> {
    match name {
        "list_projects" => dispatch_command(app, "list_projects", json!({}))
            .await
            .map_err(ToolError::internal),
        "add_project" => {
            let path = require_nonempty_str(&args, "path")?;
            let parent_id = optional_str(&args, "parentId")
                .or_else(|| optional_str(&args, "parent_id"));
            let mut payload = serde_json::Map::new();
            payload.insert("path".to_string(), Value::String(path));
            if let Some(parent_id) = parent_id {
                payload.insert("parentId".to_string(), Value::String(parent_id));
            }
            dispatch_command(app, "add_project", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "clone_project" => {
            let url = require_nonempty_str(&args, "url")?;
            let path = require_nonempty_str(&args, "path")?;
            let parent_id = optional_str(&args, "parentId")
                .or_else(|| optional_str(&args, "parent_id"));
            let mut payload = serde_json::Map::new();
            payload.insert("url".to_string(), Value::String(url));
            payload.insert("path".to_string(), Value::String(path));
            if let Some(parent_id) = parent_id {
                payload.insert("parentId".to_string(), Value::String(parent_id));
            }
            dispatch_command(app, "clone_project", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "init_project" => {
            let path = require_nonempty_str(&args, "path")?;
            let parent_id = optional_str(&args, "parentId")
                .or_else(|| optional_str(&args, "parent_id"));
            let mut payload = serde_json::Map::new();
            payload.insert("path".to_string(), Value::String(path));
            if let Some(parent_id) = parent_id {
                payload.insert("parentId".to_string(), Value::String(parent_id));
            }
            dispatch_command(app, "init_project", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "list_worktrees" => {
            let project_id = require_str(&args, "projectId")?;
            dispatch_command(app, "list_worktrees", json!({ "projectId": project_id }))
                .await
                .map_err(ToolError::internal)
        }
        "get_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            dispatch_command(app, "get_worktree", json!({ "worktreeId": worktree_id }))
                .await
                .map_err(ToolError::internal)
        }
        "get_project_context" => {
            let project_id = require_str(&args, "projectId")?;
            get_project_context(app, &project_id)
        }
        "list_github_issues" => {
            let project_id = require_str(&args, "projectId")?;
            let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("open");
            let project_path = resolve_project_path(app, &project_id)?;
            dispatch_command(
                app,
                "list_github_issues",
                json!({ "projectPath": project_path, "state": state }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "list_github_prs" => {
            let project_id = require_str(&args, "projectId")?;
            let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("open");
            let project_path = resolve_project_path(app, &project_id)?;
            dispatch_command(
                app,
                "list_github_prs",
                json!({ "projectPath": project_path, "state": state }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "list_security_issues" => {
            let project_id = require_str(&args, "projectId")?;
            let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("open");
            let state = if state == "all" {
                "open,dismissed,fixed,auto_dismissed"
            } else {
                state
            };
            let project_path = resolve_project_path(app, &project_id)?;
            dispatch_command(
                app,
                "list_dependabot_alerts",
                json!({ "projectPath": project_path, "state": state }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "list_security_advisories" => {
            let project_id = require_str(&args, "projectId")?;
            let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("all");
            let state = if state == "all" {
                Value::Null
            } else {
                Value::String(state.to_string())
            };
            let project_path = resolve_project_path(app, &project_id)?;
            dispatch_command(
                app,
                "list_repository_advisories",
                json!({ "projectPath": project_path, "state": state }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "list_linear_issues" => {
            let project_id = require_str(&args, "projectId")?;
            dispatch_command(
                app,
                "list_linear_issues",
                json!({ "projectId": project_id }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "create_worktree_from_existing_branch" => {
            let project_id = require_str(&args, "projectId")?;
            let branch_name = require_nonempty_str(&args, "branchName")
                .or_else(|_| require_nonempty_str(&args, "branch_name"))?;
            dispatch_command(
                app,
                "create_worktree_from_existing_branch",
                json!({
                    "projectId": project_id,
                    "branchName": branch_name,
                    "autoOpenInJean": false,
                }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "import_worktree" => {
            let project_id = require_str(&args, "projectId")?;
            let path = require_nonempty_str(&args, "path")?;
            dispatch_command(
                app,
                "import_worktree",
                json!({ "projectId": project_id, "path": path }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "rename_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let new_name = require_nonempty_str(&args, "newName")
                .or_else(|_| require_nonempty_str(&args, "new_name"))?;
            dispatch_command(
                app,
                "rename_worktree",
                json!({ "worktreeId": worktree_id, "newName": new_name }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "archive_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            dispatch_command(
                app,
                "archive_worktree",
                json!({ "worktreeId": worktree_id }),
            )
            .await
            .map_err(ToolError::internal)?;
            Ok(json!({
                "worktreeId": worktree_id,
                "action": "archive",
                "ok": true,
            }))
        }
        "unarchive_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            dispatch_command(
                app,
                "unarchive_worktree",
                json!({ "worktreeId": worktree_id }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "list_archived_worktrees" => {
            let project_id = optional_str(&args, "projectId")
                .or_else(|| optional_str(&args, "project_id"));
            let result = dispatch_command(app, "list_archived_worktrees", json!({}))
                .await
                .map_err(ToolError::internal)?;
            if let Some(project_id) = project_id {
                let filtered = result
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| {
                                item.get("project_id")
                                    .or_else(|| item.get("projectId"))
                                    .and_then(|v| v.as_str())
                                    == Some(project_id.as_str())
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok(Value::Array(filtered))
            } else {
                Ok(result)
            }
        }
        "delete_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            dispatch_command(
                app,
                "delete_worktree",
                json!({ "worktreeId": worktree_id }),
            )
            .await
            .map_err(ToolError::internal)?;
            Ok(deletion_started_result(&worktree_id, "delete"))
        }
        "permanently_delete_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            dispatch_command(
                app,
                "permanently_delete_worktree",
                json!({ "worktreeId": worktree_id }),
            )
            .await
            .map_err(ToolError::internal)?;
            Ok(deletion_started_result(
                &worktree_id,
                "permanently_delete",
            ))
        }
        "create_worktree" => {
            let project_id = require_str(&args, "projectId")?;
            let action = args.get("action").and_then(|v| v.as_str());
            if let Some(action) = action {
                if action != "start_autoinvestigating" {
                    return Err(ToolError::invalid_params(format!(
                        "Unsupported create_worktree action: {action}"
                    )));
                }
            }

            let issue_number = args.get("issueNumber").and_then(|v| v.as_u64());
            let pr_number = args.get("prNumber").and_then(|v| v.as_u64());
            let linear_identifier = args
                .get("linearIssueIdentifier")
                .or_else(|| args.get("linear_issue_identifier"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let ghsa_id = args
                .get("ghsaId")
                .or_else(|| args.get("ghsa_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            validate_create_worktree_inputs(
                issue_number.is_some(),
                pr_number.is_some(),
                linear_identifier.is_some(),
                ghsa_id.is_some(),
                action,
            )?;

            let mut payload = serde_json::Map::new();
            payload.insert("projectId".to_string(), Value::String(project_id.clone()));
            if let Some(base) = args.get("baseBranch").and_then(|v| v.as_str()) {
                payload.insert("baseBranch".to_string(), Value::String(base.to_string()));
            }
            let has_custom_name = args.get("customName").and_then(|v| v.as_str()).is_some();
            if let Some(name) = args.get("customName").and_then(|v| v.as_str()) {
                let resolved = resolve_non_conflicting_worktree_name(app, &project_id, name)?;
                payload.insert("customName".to_string(), Value::String(resolved.clone()));
            }
            // Jean MCP must never auto-open/switch the Jean UI. Opening the worktree
            // causes the normal UI path to create its default session in addition to
            // the autoinvestigation session, so keep MCP-created worktrees background-only.
            payload.insert("autoOpenInJean".to_string(), Value::Bool(false));
            let project_path = if issue_number.is_some() || pr_number.is_some() || ghsa_id.is_some()
            {
                Some(resolve_project_path(app, &project_id)?)
            } else {
                None
            };
            if let Some(issue_number) = issue_number {
                let project_path = project_path
                    .clone()
                    .ok_or_else(|| ToolError::internal("missing project_path for issue fetch"))?;
                let detail = dispatch_command(
                    app,
                    "get_github_issue",
                    json!({ "projectPath": project_path, "issueNumber": issue_number }),
                )
                .await
                .map_err(ToolError::internal)?;
                if !has_custom_name {
                    let title = detail.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    let issue_branch = crate::projects::generate_branch_name_from_issue(
                        issue_number as u32,
                        title,
                    );
                    let resolved =
                        resolve_non_conflicting_worktree_name(app, &project_id, &issue_branch)?;
                    if resolved != issue_branch {
                        payload.insert("customName".to_string(), Value::String(resolved.clone()));
                    }
                }
                payload.insert(
                    "issueContext".to_string(),
                    json!({
                        "number": detail.get("number").cloned().unwrap_or(json!(issue_number)),
                        "title": detail.get("title").cloned().unwrap_or(Value::Null),
                        "body": detail.get("body").cloned().unwrap_or(Value::Null),
                        "comments": detail.get("comments").cloned().unwrap_or(json!([])),
                    }),
                );
            }
            if let Some(pr_number) = pr_number {
                let project_path = project_path
                    .clone()
                    .ok_or_else(|| ToolError::internal("missing project_path for PR fetch"))?;
                let detail = dispatch_command(
                    app,
                    "get_github_pr",
                    json!({ "projectPath": project_path, "prNumber": pr_number }),
                )
                .await
                .map_err(ToolError::internal)?;
                payload.insert(
                    "prContext".to_string(),
                    json!({
                        "number": detail.get("number").cloned().unwrap_or(json!(pr_number)),
                        "title": detail.get("title").cloned().unwrap_or(Value::Null),
                        "body": detail.get("body").cloned().unwrap_or(Value::Null),
                        "headRefName": detail.get("headRefName").cloned().unwrap_or(Value::Null),
                        "baseRefName": detail.get("baseRefName").cloned().unwrap_or(Value::Null),
                        "comments": detail.get("comments").cloned().unwrap_or(json!([])),
                        "reviews": detail.get("reviews").cloned().unwrap_or(json!([])),
                        "diff": Value::Null,
                    }),
                );
            }
            if let Some(ref identifier) = linear_identifier {
                let number = parse_linear_issue_number(identifier).ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "Invalid Linear issue identifier: {identifier}"
                    ))
                })?;
                let resolved = dispatch_command(
                    app,
                    "get_linear_issue_by_number",
                    json!({ "projectId": project_id.as_str(), "issueNumber": number }),
                )
                .await
                .map_err(ToolError::internal)?;
                // get_linear_issue_by_number returns Option<LinearIssue> → null when missing.
                if resolved.is_null() {
                    return Err(ToolError::internal(format!(
                        "Linear issue {identifier} not found"
                    )));
                }
                // A bare number lookup can resolve to a different team's issue (e.g. input
                // ABC-215 resolving to PLA-215). Verify the resolved identifier matches.
                let resolved_identifier = resolved
                    .get("identifier")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if !resolved_identifier.eq_ignore_ascii_case(identifier) {
                    return Err(ToolError::invalid_params(format!(
                        "Linear issue {identifier} not found (resolved to {resolved_identifier})"
                    )));
                }
                let issue_id = resolved
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ToolError::internal("Linear issue missing id"))?
                    .to_string();
                let detail = dispatch_command(
                    app,
                    "get_linear_issue",
                    json!({ "projectId": project_id.as_str(), "issueId": issue_id.as_str() }),
                )
                .await
                .map_err(ToolError::internal)?;
                if !has_custom_name {
                    let title = detail.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    let linear_branch = crate::projects::generate_branch_name_from_linear_issue(
                        resolved_identifier,
                        title,
                    );
                    let resolved_name =
                        resolve_non_conflicting_worktree_name(app, &project_id, &linear_branch)?;
                    if resolved_name != linear_branch {
                        payload.insert(
                            "customName".to_string(),
                            Value::String(resolved_name.clone()),
                        );
                    }
                }
                payload.insert(
                    "linearContext".to_string(),
                    json!({
                        "id": detail.get("id").cloned().unwrap_or(Value::Null),
                        "identifier": detail
                            .get("identifier")
                            .cloned()
                            .unwrap_or(json!(resolved_identifier)),
                        "title": detail.get("title").cloned().unwrap_or(Value::Null),
                        "description": detail.get("description").cloned().unwrap_or(Value::Null),
                        "comments": detail.get("comments").cloned().unwrap_or(json!([])),
                    }),
                );
            }
            if let Some(ref ghsa_id) = ghsa_id {
                let project_path = project_path.clone().ok_or_else(|| {
                    ToolError::internal("missing project_path for advisory fetch")
                })?;
                let detail = dispatch_command(
                    app,
                    "get_repository_advisory",
                    json!({ "projectPath": project_path, "ghsaId": ghsa_id }),
                )
                .await
                .map_err(ToolError::internal)?;
                if !has_custom_name {
                    let summary = detail.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                    let advisory_branch =
                        crate::projects::generate_branch_name_from_advisory(ghsa_id, summary);
                    let resolved =
                        resolve_non_conflicting_worktree_name(app, &project_id, &advisory_branch)?;
                    if resolved != advisory_branch {
                        payload.insert("customName".to_string(), Value::String(resolved.clone()));
                    }
                }
                // Map vulnerabilities into the AdvisoryContext shape expected by create_worktree.
                let vulnerabilities = detail
                    .get("vulnerabilities")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                payload.insert(
                    "advisoryContext".to_string(),
                    json!({
                        "ghsaId": detail
                            .get("ghsaId")
                            .cloned()
                            .unwrap_or_else(|| json!(ghsa_id)),
                        "severity": detail.get("severity").cloned().unwrap_or(json!("unknown")),
                        "summary": detail.get("summary").cloned().unwrap_or(Value::Null),
                        "description": detail.get("description").cloned().unwrap_or(json!("")),
                        "cveId": detail.get("cveId").cloned().unwrap_or(Value::Null),
                        "vulnerabilities": vulnerabilities,
                        "htmlUrl": detail.get("htmlUrl").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            let worktree = dispatch_command(app, "create_worktree", Value::Object(payload))
                .await
                .map_err(ToolError::internal)?;
            if action == Some("start_autoinvestigating") {
                let kind = if issue_number.is_some() {
                    InvestigationKind::Issue
                } else if linear_identifier.is_some() {
                    InvestigationKind::Linear
                } else if ghsa_id.is_some() {
                    InvestigationKind::Advisory
                } else {
                    InvestigationKind::Pr
                };
                start_autoinvestigating(app, &worktree, kind, source).await
            } else {
                Ok(worktree)
            }
        }
        "update_worktree_labels" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let action = require_str(&args, "action")?;
            let worktree =
                dispatch_command(app, "get_worktree", json!({ "worktreeId": worktree_id }))
                    .await
                    .map_err(ToolError::internal)?;
            let current_labels: Vec<LabelData> =
                serde_json::from_value(worktree.get("labels").cloned().unwrap_or(json!([])))
                    .map_err(|e| {
                        ToolError::internal(format!("parse current worktree labels: {e}"))
                    })?;

            let next_labels = match action.as_str() {
                "add" => add_or_update_label(current_labels, parse_label_arg(&args)?),
                "remove" => {
                    let label = parse_label_arg(&args)?;
                    remove_label_by_name(current_labels, &label.name)
                }
                "set" => parse_labels_arg(&args)?,
                "clear" => Vec::new(),
                other => {
                    return Err(ToolError::invalid_params(format!(
                        "Unsupported update_worktree_labels action: {other}"
                    )))
                }
            };

            dispatch_command(
                app,
                "update_worktree_labels",
                json!({ "worktreeId": worktree_id, "labels": next_labels }),
            )
            .await
            .map_err(ToolError::internal)?;
            dispatch_command(app, "get_worktree", json!({ "worktreeId": worktree_id }))
                .await
                .map_err(ToolError::internal)
        }
        "list_sessions" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let include_archived = args
                .get("includeArchived")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            dispatch_command(
                app,
                "list_sessions_summary",
                json!({
                    "worktreeId": worktree_id,
                    "worktreePath": worktree_path,
                    "includeArchived": include_archived
                }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "create_session" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            // Fail fast when the worktree is archived (also enforced in create_session).
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let mut payload = serde_json::Map::new();
            payload.insert("worktreeId".to_string(), Value::String(worktree_id));
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            if let Some(n) = args.get("name").and_then(|v| v.as_str()) {
                payload.insert("name".to_string(), Value::String(n.to_string()));
            }
            if let Some(b) = args.get("backend").and_then(|v| v.as_str()) {
                payload.insert("backend".to_string(), Value::String(b.to_string()));
            }
            dispatch_command(app, "create_session", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "send_chat_message" => {
            let session_id = require_str(&args, "sessionId")?;
            let message = require_str(&args, "message")?;
            let (worktree_id, worktree_path) = resolve_session_worktree(app, &session_id)?;
            // Validate archive status before fire-and-forget so agents get an
            // immediate error instead of a silent log-only failure after "started".
            ensure_mcp_session_can_run(app, &session_id, &worktree_id)?;
            let mut payload = serde_json::Map::new();
            payload.insert("sessionId".to_string(), Value::String(session_id.clone()));
            payload.insert("worktreeId".to_string(), Value::String(worktree_id));
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            payload.insert("message".to_string(), Value::String(message));
            if let Some(m) = args.get("model").and_then(|v| v.as_str()) {
                payload.insert("model".to_string(), Value::String(m.to_string()));
            }
            if let Some(em) = args.get("executionMode").and_then(|v| v.as_str()) {
                payload.insert("executionMode".to_string(), Value::String(em.to_string()));
            }
            let app_clone = app.clone();
            let payload_clone = Value::Object(payload);
            let source_clone = source.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(e) =
                    dispatch_command(&app_clone, "send_chat_message", payload_clone).await
                {
                    log::warn!("Jean MCP send_chat_message (source={source_clone}) failed: {e}");
                }
            });
            Ok(json!({ "sessionId": session_id, "status": "started" }))
        }
        "archive_session" => {
            let session_id = require_str(&args, "sessionId")?;
            let (worktree_id, worktree_path) = resolve_session_worktree(app, &session_id)?;
            dispatch_command(
                app,
                "archive_session",
                json!({
                    "sessionId": session_id.clone(),
                    "worktreeId": worktree_id,
                    "worktreePath": worktree_path,
                }),
            )
            .await
            .map_err(ToolError::internal)?;
            Ok(json!({
                "sessionId": session_id,
                "action": "archive",
                "ok": true,
            }))
        }
        "unarchive_session" => {
            let session_id = require_str(&args, "sessionId")?;
            let (worktree_id, worktree_path) = resolve_session_worktree(app, &session_id)?;
            let mut unarchived_worktree = false;
            let mut unarchived_session = false;

            // If the parent worktree is archived, restore it first so the
            // session becomes runnable (not just un-flagged inside a hidden wt).
            if crate::chat::worktree_archived_at(app, &worktree_id).is_some() {
                dispatch_command(
                    app,
                    "unarchive_worktree",
                    json!({ "worktreeId": worktree_id.clone() }),
                )
                .await
                .map_err(ToolError::internal)?;
                unarchived_worktree = true;
            }

            let session_is_archived = crate::chat::storage::load_metadata(app, &session_id)
                .map_err(|e| ToolError::internal(format!("load_metadata: {e}")))?
                .map(|m| m.archived_at.is_some())
                .unwrap_or(false);

            let session = if session_is_archived {
                let restored = dispatch_command(
                    app,
                    "unarchive_session",
                    json!({
                        "sessionId": session_id.clone(),
                        "worktreeId": worktree_id.clone(),
                        "worktreePath": worktree_path.clone(),
                    }),
                )
                .await
                .map_err(ToolError::internal)?;
                unarchived_session = true;
                restored
            } else if !unarchived_worktree {
                return Err(ToolError::invalid_params(
                    "Session is not archived (and parent worktree is not archived either)",
                ));
            } else {
                // Worktree was archived but the session itself was not — return
                // current session payload so callers get a consistent shape.
                dispatch_command(
                    app,
                    "get_session",
                    json!({
                        "sessionId": session_id.clone(),
                        "worktreeId": worktree_id.clone(),
                        "worktreePath": worktree_path,
                    }),
                )
                .await
                .map_err(ToolError::internal)?
            };

            Ok(json!({
                "sessionId": session_id,
                "worktreeId": worktree_id,
                "action": "unarchive",
                "ok": true,
                "unarchivedWorktree": unarchived_worktree,
                "unarchivedSession": unarchived_session,
                "session": session,
            }))
        }
        "get_session_status" => {
            let session_id = require_str(&args, "sessionId")?;
            dispatch_command(
                app,
                "get_session_status",
                json!({ "sessionId": session_id }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "cancel_session_run" => {
            let session_id = require_str(&args, "sessionId")?;
            let (worktree_id, _) = resolve_session_worktree(app, &session_id)?;
            let cancelled = crate::chat::cancel_chat_message(
                app.clone(),
                session_id.clone(),
                worktree_id.clone(),
            )
            .await
            .map_err(ToolError::internal)?;
            Ok(json!({
                "sessionId": session_id,
                "worktreeId": worktree_id,
                "cancelled": cancelled,
            }))
        }
        "read_session_messages" => {
            let session_id = require_str(&args, "sessionId")?;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .min(200) as usize;
            let (worktree_id, worktree_path) = resolve_session_worktree(app, &session_id)?;
            dispatch_command(app, "get_session", json!({ "sessionId": session_id, "worktreeId": worktree_id, "worktreePath": worktree_path, "limit": limit })).await.map_err(ToolError::internal)
        }
        "set_session_model" => {
            let session_id = require_str(&args, "sessionId")?;
            let model = require_nonempty_str(&args, "model")?;
            let backend = optional_str(&args, "backend")
                .map(|b| normalize_backend_name(&b))
                .transpose()?
                .or_else(|| Some(infer_backend_from_model(&model).to_string()));
            let (worktree_id, worktree_path) = resolve_session_worktree(app, &session_id)?;

            dispatch_command(
                app,
                "set_session_model",
                json!({
                    "sessionId": session_id.clone(),
                    "worktreeId": worktree_id.clone(),
                    "worktreePath": worktree_path.clone(),
                    "model": model.clone(),
                }),
            )
            .await
            .map_err(ToolError::internal)?;

            if let Some(ref backend) = backend {
                dispatch_command(
                    app,
                    "set_session_backend",
                    json!({
                        "sessionId": session_id.clone(),
                        "worktreeId": worktree_id,
                        "worktreePath": worktree_path,
                        "backend": backend,
                    }),
                )
                .await
                .map_err(ToolError::internal)?;
            }

            Ok(json!({
                "sessionId": session_id,
                "model": model,
                "backend": backend,
            }))
        }
        "get_usage" => {
            let backend_filter = args
                .get("backend")
                .and_then(|v| v.as_str())
                .unwrap_or("all")
                .trim()
                .to_ascii_lowercase();
            match backend_filter.as_str() {
                "all" | "claude" | "codex" | "grok" => {}
                other => {
                    return Err(ToolError::invalid_params(format!(
                        "backend must be one of claude, codex, grok, all (got '{other}')"
                    )));
                }
            }
            get_usage_snapshots(app, &backend_filter).await
        }
        "get_worktree_changes" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let max_files = args
                .get("maxFiles")
                .and_then(|v| v.as_u64())
                .unwrap_or(100)
                .clamp(1, 500) as usize;
            dispatch_command(
                app,
                "get_worktree_changes",
                json!({ "worktreeId": worktree_id, "maxFiles": max_files }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "get_worktree_diff" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let diff_type = args
                .get("diffType")
                .and_then(|v| v.as_str())
                .unwrap_or("uncommitted");
            let path = args.get("path").and_then(|v| v.as_str());
            let max_bytes = args
                .get("maxBytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_MCP_DIFF_MAX_BYTES as u64)
                .clamp(1, MAX_MCP_DIFF_BYTES as u64) as usize;
            dispatch_command(
                app,
                "get_worktree_diff",
                json!({
                    "worktreeId": worktree_id,
                    "diffType": diff_type,
                    "path": path,
                    "maxBytes": max_bytes
                }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "create_commit" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let push = args.get("push").and_then(|v| v.as_bool()).unwrap_or(false);
            let remote = optional_str(&args, "remote");
            let pr_number = args
                .get("prNumber")
                .or_else(|| args.get("pr_number"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let specific_files = args
                .get("specificFiles")
                .or_else(|| args.get("specific_files"))
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .filter(|files| !files.is_empty());
            let custom_prompt = optional_str(&args, "customPrompt")
                .or_else(|| optional_str(&args, "custom_prompt"));
            let model = optional_str(&args, "model");
            let reasoning_effort = optional_str(&args, "reasoningEffort")
                .or_else(|| optional_str(&args, "reasoning_effort"));
            let mut payload = serde_json::Map::new();
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            payload.insert("push".to_string(), Value::Bool(push));
            if let Some(remote) = remote {
                payload.insert("remote".to_string(), Value::String(remote));
            }
            if let Some(pr_number) = pr_number {
                payload.insert("prNumber".to_string(), json!(pr_number));
            }
            if let Some(files) = specific_files {
                payload.insert("specificFiles".to_string(), json!(files));
            }
            if let Some(prompt) = custom_prompt {
                payload.insert("customPrompt".to_string(), Value::String(prompt));
            }
            if let Some(model) = model {
                payload.insert("model".to_string(), Value::String(model));
            }
            if let Some(effort) = reasoning_effort {
                payload.insert("reasoningEffort".to_string(), Value::String(effort));
            }
            dispatch_command(app, "create_commit_with_ai", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "push_worktree" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let remote = optional_str(&args, "remote");
            let pr_number = args
                .get("prNumber")
                .or_else(|| args.get("pr_number"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let mut payload = serde_json::Map::new();
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            if let Some(remote) = remote {
                payload.insert("remote".to_string(), Value::String(remote));
            }
            if let Some(pr_number) = pr_number {
                payload.insert("prNumber".to_string(), json!(pr_number));
            }
            dispatch_command(app, "git_push", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "detect_open_pr" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            dispatch_command(
                app,
                "detect_open_pr_for_branch",
                json!({ "worktreePath": worktree_path }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "create_pull_request" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let session_id = optional_str(&args, "sessionId")
                .or_else(|| optional_str(&args, "session_id"));
            let custom_prompt = optional_str(&args, "customPrompt")
                .or_else(|| optional_str(&args, "custom_prompt"));
            let model = optional_str(&args, "model");
            let reasoning_effort = optional_str(&args, "reasoningEffort")
                .or_else(|| optional_str(&args, "reasoning_effort"));
            let mut payload = serde_json::Map::new();
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            if let Some(session_id) = session_id {
                payload.insert("sessionId".to_string(), Value::String(session_id));
            }
            if let Some(prompt) = custom_prompt {
                payload.insert("customPrompt".to_string(), Value::String(prompt));
            }
            if let Some(model) = model {
                payload.insert("model".to_string(), Value::String(model));
            }
            if let Some(effort) = reasoning_effort {
                payload.insert("reasoningEffort".to_string(), Value::String(effort));
            }
            dispatch_command(app, "create_pr_with_ai_content", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "merge_pull_request" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            dispatch_command(
                app,
                "merge_github_pr",
                json!({ "worktreePath": worktree_path }),
            )
            .await
            .map_err(ToolError::internal)
        }
        "run_review" => {
            let worktree_id = require_str(&args, "worktreeId")?;
            ensure_mcp_worktree_not_archived(app, &worktree_id)?;
            let worktree_path = resolve_worktree_path(app, &worktree_id)?;
            let custom_prompt = optional_str(&args, "customPrompt")
                .or_else(|| optional_str(&args, "custom_prompt"));
            let model = optional_str(&args, "model");
            let backend = optional_str(&args, "backend");
            let reasoning_effort = optional_str(&args, "reasoningEffort")
                .or_else(|| optional_str(&args, "reasoning_effort"));
            let mut payload = serde_json::Map::new();
            payload.insert("worktreePath".to_string(), Value::String(worktree_path));
            if let Some(prompt) = custom_prompt {
                payload.insert("customPrompt".to_string(), Value::String(prompt));
            }
            if let Some(model) = model {
                payload.insert("model".to_string(), Value::String(model));
            }
            if let Some(backend) = backend {
                payload.insert("backend".to_string(), Value::String(backend));
            }
            if let Some(effort) = reasoning_effort {
                payload.insert("reasoningEffort".to_string(), Value::String(effort));
            }
            dispatch_command(app, "run_review_with_ai", Value::Object(payload))
                .await
                .map_err(ToolError::internal)
        }
        "get_current_context" => {
            if source == "anon" {
                return Err(no_current_context_error(source));
            }
            let (worktree_id, worktree_path) = resolve_session_worktree(app, source)
                .map_err(|_| no_current_context_error(source))?;
            let (project_id, project_name, project_path) =
                resolve_worktree_project(app, &worktree_id)?;
            Ok(
                json!({ "sessionId": source, "worktreeId": worktree_id, "worktreePath": worktree_path, "projectId": project_id, "projectName": project_name, "projectPath": project_path }),
            )
        }
        other => Err(ToolError::invalid_params(format!("Unknown tool: {other}"))),
    }
}

fn deletion_started_result(worktree_id: &str, action: &str) -> Value {
    json!({
        "worktreeId": worktree_id,
        "action": action,
        "started": true,
    })
}

fn get_project_context(app: &AppHandle, project_id: &str) -> Result<Value, ToolError> {
    let data = crate::projects::storage::load_projects_data(app)
        .map_err(|e| ToolError::internal(format!("load_projects_data: {e}")))?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown projectId: {project_id}")))?;
    let worktrees = data.worktrees_for_project(project_id);
    let linked_projects: Vec<Value> = project
        .linked_project_ids
        .iter()
        .filter_map(|id| data.find_project(id))
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "path": p.path,
                "defaultBranch": p.default_branch,
                "defaultBackend": p.default_backend,
            })
        })
        .collect();

    Ok(json!({
        "id": project.id,
        "name": project.name,
        "path": project.path,
        "defaultBranch": project.default_branch,
        "defaultBackend": project.default_backend,
        "defaultProvider": project.default_provider,
        "enabledMcpServers": project.enabled_mcp_servers,
        "customSystemPromptPresent": project.custom_system_prompt.as_ref().is_some_and(|p| !p.trim().is_empty()),
        "worktreesDir": project.worktrees_dir,
        "linkedProjects": linked_projects,
        "counts": {
            "worktrees": worktrees.len(),
            "activeWorktrees": worktrees.iter().filter(|w| w.archived_at.is_none()).count(),
            "archivedWorktrees": worktrees.iter().filter(|w| w.archived_at.is_some()).count(),
        },
    }))
}

fn require_str(args: &Value, key: &str) -> Result<String, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ToolError::invalid_params(format!("missing or non-string '{key}'")))
}

fn require_nonempty_str(args: &Value, key: &str) -> Result<String, ToolError> {
    let value = require_str(args, key)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid_params(format!(
            "'{key}' must be a non-empty string"
        )));
    }
    Ok(trimmed.to_string())
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_label_arg(args: &Value) -> Result<LabelData, ToolError> {
    let label = args
        .get("label")
        .ok_or_else(|| ToolError::invalid_params("missing 'label'"))?;
    let name = label
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(ToolError::invalid_params(
            "label.name must be a non-empty string",
        ));
    }
    let color = label
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_LABEL_COLOR)
        .trim()
        .to_string();
    validate_label_color(&color, "label.color")?;
    let pinned = label
        .get("pinned")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(LabelData {
        name,
        color,
        pinned,
    })
}

fn parse_labels_arg(args: &Value) -> Result<Vec<LabelData>, ToolError> {
    let labels = args
        .get("labels")
        .ok_or_else(|| ToolError::invalid_params("missing 'labels'"))?
        .as_array()
        .ok_or_else(|| ToolError::invalid_params("'labels' must be an array"))?;

    let mut parsed = Vec::with_capacity(labels.len());
    for (index, label) in labels.iter().enumerate() {
        let name = label
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if name.is_empty() {
            return Err(ToolError::invalid_params(format!(
                "labels[{index}].name must be a non-empty string"
            )));
        }
        let color = label
            .get("color")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::invalid_params(format!("missing labels[{index}].color")))?
            .trim()
            .to_string();
        validate_label_color(&color, &format!("labels[{index}].color"))?;
        let pinned = label
            .get("pinned")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        parsed.push(LabelData {
            name,
            color,
            pinned,
        });
    }
    normalize_mcp_labels(parsed)
}

fn normalize_mcp_labels(mut labels: Vec<LabelData>) -> Result<Vec<LabelData>, ToolError> {
    for label in labels.iter_mut() {
        label.name = label.name.trim().to_string();
        label.color = label.color.trim().to_string();
        if label.name.is_empty() {
            return Err(ToolError::invalid_params(
                "label.name must be a non-empty string",
            ));
        }
        validate_label_color(&label.color, "label.color")?;
    }
    crate::projects::types::dedupe_labels_by_name(&mut labels);
    Ok(labels)
}

fn add_or_update_label(mut labels: Vec<LabelData>, label: LabelData) -> Vec<LabelData> {
    if let Some(existing) = labels
        .iter_mut()
        .find(|existing| labels_match(&existing.name, &label.name))
    {
        existing.color = label.color;
        return labels;
    }
    labels.push(label);
    labels
}

fn remove_label_by_name(labels: Vec<LabelData>, label_name: &str) -> Vec<LabelData> {
    labels
        .into_iter()
        .filter(|label| !labels_match(&label.name, label_name))
        .collect()
}

fn labels_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn validate_label_color(color: &str, field: &str) -> Result<(), ToolError> {
    let hex = color.strip_prefix('#').ok_or_else(|| {
        ToolError::invalid_params(format!("{field} must be a hex color like #eab308"))
    })?;
    if matches!(hex.len(), 3 | 6) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(ToolError::invalid_params(format!(
            "{field} must be a hex color like #eab308"
        )))
    }
}

fn no_current_context_error(source: &str) -> ToolError {
    ToolError::internal(format!(
        "No Jean session context present for source '{source}'. \
get_current_context only works for MCP calls made from Jean-spawned chat sessions, where \
JEAN_MCP_SESSION is a real Jean session id. For manual/global MCP clients, use explicit-id tools \
instead: list_projects -> list_worktrees(projectId) -> list_sessions(worktreeId), then \
get_session_status(sessionId), get_worktree_changes(worktreeId), or get_worktree_diff(worktreeId)."
    ))
}

fn resolve_non_conflicting_worktree_name(
    app: &AppHandle,
    project_id: &str,
    requested_name: &str,
) -> Result<String, ToolError> {
    let data = crate::projects::storage::load_projects_data(app)
        .map_err(|e| ToolError::internal(format!("load_projects_data: {e}")))?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown projectId: {project_id}")))?;
    let worktrees_dir = crate::projects::storage::get_project_worktrees_dir(
        &project.name,
        project.worktrees_dir.as_deref(),
    )
    .map_err(ToolError::internal)?;
    let folder_name = crate::projects::sanitize_folder_name(requested_name);
    let path_exists = worktrees_dir.join(folder_name).exists();
    let name_exists = data.worktree_name_exists(project_id, requested_name);
    let branch_exists = crate::projects::git::branch_exists(&project.path, requested_name);

    if path_exists || name_exists || branch_exists {
        let resolved = crate::projects::generate_unique_suffix_name(
            requested_name,
            &project.path,
            project_id,
            Some(&data),
        );
        log::info!(
            "Jean MCP resolved worktree name conflict: requested={requested_name}, resolved={resolved}, path_exists={path_exists}, name_exists={name_exists}, branch_exists={branch_exists}"
        );
        Ok(resolved)
    } else {
        Ok(requested_name.to_string())
    }
}

/// Validate the mutually-exclusive context inputs for create_worktree.
/// GitHub `issueNumber`/`prNumber`, Linear `linearIssueIdentifier`, and advisory
/// `ghsaId` are mutually exclusive, and `action=start_autoinvestigating` needs one of them.
fn validate_create_worktree_inputs(
    has_issue: bool,
    has_pr: bool,
    has_linear: bool,
    has_advisory: bool,
    action: Option<&str>,
) -> Result<(), ToolError> {
    if has_issue && has_pr {
        return Err(ToolError::invalid_params(
            "Pass either issueNumber or prNumber, not both",
        ));
    }
    if has_linear && (has_issue || has_pr) {
        return Err(ToolError::invalid_params(
            "Pass a GitHub issueNumber/prNumber or a linearIssueIdentifier, not both",
        ));
    }
    if has_advisory && (has_issue || has_pr || has_linear) {
        return Err(ToolError::invalid_params(
            "Pass a GitHub issueNumber/prNumber, linearIssueIdentifier, or ghsaId, not both",
        ));
    }
    if action == Some("start_autoinvestigating")
        && !has_issue
        && !has_pr
        && !has_linear
        && !has_advisory
    {
        return Err(ToolError::invalid_params(
            "action=start_autoinvestigating requires issueNumber, prNumber, linearIssueIdentifier, or ghsaId",
        ));
    }
    Ok(())
}

/// Parse the numeric part of a Linear issue identifier (e.g. "PLA-215" → 215).
/// Linear's `issueByNumber`-style lookup keys off the number; the caller verifies
/// the resolved issue's identifier matches the requested one.
fn parse_linear_issue_number(identifier: &str) -> Option<i64> {
    let digits = identifier.trim().rsplit('-').next()?.trim();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().filter(|n| *n > 0)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum InvestigationKind {
    Issue,
    Pr,
    Linear,
    Advisory,
}

#[derive(Debug)]
struct InvestigationSelection {
    backend: String,
    model: String,
    provider: Option<String>,
    effort: Option<String>,
    execution_mode: String,
}

async fn start_autoinvestigating(
    app: &AppHandle,
    pending_worktree: &Value,
    kind: InvestigationKind,
    source: &str,
) -> Result<Value, ToolError> {
    let worktree_id = require_value_str(pending_worktree, "id")?;
    let ready_worktree = wait_for_worktree_ready(app, &worktree_id).await?;
    let worktree_path = require_value_str(&ready_worktree, "path")?;

    let prefs = crate::load_preferences(app.clone())
        .await
        .map_err(ToolError::internal)?;
    let selection = resolve_investigation_selection(app, &prefs, &ready_worktree, kind);
    let prompt = build_investigation_prompt(&prefs, &ready_worktree, kind);
    let parallel_execution_prompt = if prefs.parallel_execution_prompt_enabled {
        Some(
            prefs
                .magic_prompts
                .parallel_execution
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(crate::default_parallel_execution_prompt),
        )
    } else {
        None
    };
    let custom_profile_name = selection
        .provider
        .clone()
        .filter(|p| p != "__anthropic__" && selection.backend == "claude");

    let result = start_background_investigation_impl(
        app,
        worktree_id.clone(),
        worktree_path.clone(),
        prompt,
        selection.model.clone(),
        selection.backend.clone(),
        selection.provider.clone(),
        selection.effort.clone(),
        custom_profile_name,
        Some(prefs.chrome_enabled),
        Some(prefs.ai_language.clone()),
        parallel_execution_prompt,
        Some(selection.execution_mode.clone()),
        Some(source.to_string()),
    )
    .await
    .map_err(ToolError::internal)?;
    let session_id = result.session_id;

    Ok(json!({
        "worktree": ready_worktree,
        "sessionId": session_id,
        "backend": selection.backend,
        "model": selection.model,
        "status": "investigation_started",
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundInvestigationResult {
    pub session_id: String,
    pub worktree_id: String,
    pub status: String,
}

/// Marker so YOLO fix-after-investigate transforms stay idempotent when both
/// the frontend and this backend path process the same message.
const YOLO_INVESTIGATION_FIX_MARKER: &str = "<yolo_investigation_fix>";

const YOLO_INVESTIGATION_FIX_APPEND: &str = r#"<yolo_investigation_fix>

This investigation is running in YOLO mode. After investigation, fix the issue: implement the necessary code changes in the codebase. Do not stop at proposing a plan. Any earlier instruction to only investigate, only propose, not implement, or not edit code is overridden for this turn.

</yolo_investigation_fix>"#;

/// When execution mode is yolo, strip weak/anti-fix investigation wording and
/// append an unconditional fix-after-investigation directive.
pub(crate) fn apply_yolo_investigation_fix_directive(
    message: &str,
    execution_mode: &str,
) -> String {
    if execution_mode != "yolo" {
        return message.to_string();
    }
    if message.contains(YOLO_INVESTIGATION_FIX_MARKER) {
        return message.to_string();
    }

    let cleaned = strip_investigation_anti_fix_lines(message);
    format!("{}\n\n{}\n", cleaned.trim_end(), YOLO_INVESTIGATION_FIX_APPEND)
}

fn strip_investigation_anti_fix_lines(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut prev_blank = false;
    for line in prompt.lines() {
        if should_strip_line_for_yolo_fix(line) {
            continue;
        }
        let is_blank = line.trim().is_empty();
        if is_blank && prev_blank {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
        prev_blank = is_blank;
    }
    out
}

fn should_strip_line_for_yolo_fix(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let body = trimmed
        .trim_start_matches(|c: char| c.is_ascii_digit())
        .trim_start_matches('.')
        .trim_start()
        .trim_start_matches(['-', '*'])
        .trim_start();

    let lower = body.to_ascii_lowercase();

    if lower.starts_with("if you are in yolo mode") {
        return true;
    }
    if lower.contains("do not implement") || lower.contains("don't implement") {
        return true;
    }
    if lower.contains("do not apply the fix")
        || lower.contains("do not apply fixes")
        || lower.contains("don't apply the fix")
        || lower.contains("don't apply fixes")
    {
        return true;
    }
    if lower.contains("do not make any changes") || lower.contains("do not make changes") {
        return true;
    }
    if (lower.contains("do not edit") || lower.contains("do not write"))
        && (lower.contains("code") || lower.contains("file"))
    {
        return true;
    }
    if lower.contains("only investigate") && !lower.contains("fix") {
        return true;
    }
    if lower.contains("only propose")
        || lower.contains("propose only")
        || lower.contains("research only")
        || lower.contains("investigation only")
    {
        return true;
    }
    if lower.contains("do not stop at proposing") && lower.contains("yolo") {
        return true;
    }

    false
}

#[allow(clippy::too_many_arguments)]
fn build_background_investigation_queue_message(
    message: String,
    model: String,
    backend: String,
    provider: Option<String>,
    effort_level: Option<String>,
    execution_mode: String,
    custom_profile_name: Option<String>,
    chrome_enabled: Option<bool>,
    ai_language: Option<String>,
    parallel_execution_prompt: Option<String>,
) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "message": message,
        "pendingImages": [],
        "pendingFiles": [],
        "pendingSkills": [],
        "pendingTextFiles": [],
        "model": model,
        "provider": provider,
        "executionMode": execution_mode,
        "thinkingLevel": "think",
        "effortLevel": effort_level,
        "backend": backend,
        "allowAllTools": true,
        "customProfileName": custom_profile_name,
        "chromeEnabled": chrome_enabled,
        "aiLanguage": ai_language,
        "parallelExecutionPrompt": parallel_execution_prompt,
        "queuedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn start_background_investigation_impl(
    app: &AppHandle,
    worktree_id: String,
    worktree_path: String,
    message: String,
    model: String,
    backend: String,
    provider: Option<String>,
    effort_level: Option<String>,
    custom_profile_name: Option<String>,
    chrome_enabled: Option<bool>,
    ai_language: Option<String>,
    parallel_execution_prompt: Option<String>,
    execution_mode: Option<String>,
    source: Option<String>,
) -> Result<BackgroundInvestigationResult, String> {
    let sessions = crate::chat::get_sessions(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        None,
        Some(false),
    )
    .await?;
    // Prefer the active/first session; create one if the worktree has none yet
    // (e.g. programmatically empty index before the UI opens a tab).
    let session_id = match sessions
        .active_session_id
        .clone()
        .or_else(|| sessions.sessions.first().map(|session| session.id.clone()))
    {
        Some(id) => id,
        None => {
            let created = crate::chat::create_session(
                app.clone(),
                worktree_id.clone(),
                worktree_path.clone(),
                None,
                Some(backend.clone()),
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .map_err(|err| {
                format!(
                    "Background investigation: failed to create session for worktree {worktree_id}: {err}"
                )
            })?;
            created.id
        }
    };

    crate::chat::set_session_model(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        model.clone(),
    )
    .await?;
    crate::chat::set_session_backend(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        backend.clone(),
    )
    .await?;
    crate::chat::set_session_provider(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        provider.clone(),
    )
    .await?;

    let source = source.unwrap_or_else(|| "ui".to_string());
    let execution_mode = execution_mode
        .filter(|mode| matches!(mode.as_str(), "plan" | "yolo"))
        .unwrap_or_else(|| "plan".to_string());
    // Detect yolo and append an unconditional fix-after-investigation directive
    // (also strips weak "if yolo" / anti-fix lines). Idempotent if the UI
    // already applied the same transform.
    let message = apply_yolo_investigation_fix_directive(&message, &execution_mode);
    let queued_message = build_background_investigation_queue_message(
        message,
        model,
        backend,
        provider,
        effort_level,
        execution_mode,
        custom_profile_name,
        chrome_enabled,
        ai_language,
        parallel_execution_prompt,
    );

    // Persist before returning so a transient send race or app reload cannot
    // leave the newly-created session without its investigation prompt. The
    // backend queue drain starts immediately and requeues lost send races.
    // set_session_* above goes through with_sessions_mut, which materializes
    // session metadata so enqueue_message's with_existing_metadata_mut succeeds
    // even for brand-new default "Session 1" index entries.
    crate::chat::enqueue_message(
        app.clone(),
        worktree_id.clone(),
        worktree_path,
        session_id.clone(),
        queued_message,
    )
    .await?;
    log::info!("Background investigation prompt queued (source={source}) session={session_id}");

    Ok(BackgroundInvestigationResult {
        session_id,
        worktree_id,
        status: "investigation_started".to_string(),
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn start_background_investigation(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    message: String,
    model: String,
    backend: String,
    provider: Option<String>,
    effort_level: Option<String>,
    custom_profile_name: Option<String>,
    chrome_enabled: Option<bool>,
    ai_language: Option<String>,
    parallel_execution_prompt: Option<String>,
    execution_mode: Option<String>,
) -> Result<BackgroundInvestigationResult, String> {
    start_background_investigation_impl(
        &app,
        worktree_id,
        worktree_path,
        message,
        model,
        backend,
        provider,
        effort_level,
        custom_profile_name,
        chrome_enabled,
        ai_language,
        parallel_execution_prompt,
        execution_mode,
        Some("ui".to_string()),
    )
    .await
}

async fn wait_for_worktree_ready(app: &AppHandle, worktree_id: &str) -> Result<Value, ToolError> {
    let started = Instant::now();
    loop {
        match dispatch_command(app, "get_worktree", json!({ "worktreeId": worktree_id })).await {
            Ok(worktree) => return Ok(worktree),
            Err(err) if started.elapsed() < Duration::from_secs(15) => {
                if started.elapsed().as_millis() % 1000 < 500 {
                    log::debug!("Jean MCP waiting for worktree {worktree_id}: {err}");
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(err) => {
                return Err(ToolError::internal(format!(
                    "Timed out waiting for worktree {worktree_id} to be ready after 15s. Creation likely failed before persistence; check worktree:path_exists/worktree:branch_exists events or use a different customName. Last error: {err}"
                )));
            }
        }
    }
}

fn resolve_investigation_selection(
    app: &AppHandle,
    prefs: &crate::AppPreferences,
    worktree: &Value,
    kind: InvestigationKind,
) -> InvestigationSelection {
    let model = match kind {
        InvestigationKind::Issue => prefs.magic_prompt_models.investigate_issue_model.clone(),
        InvestigationKind::Pr => prefs.magic_prompt_models.investigate_pr_model.clone(),
        InvestigationKind::Linear => prefs
            .magic_prompt_models
            .investigate_linear_issue_model
            .clone(),
        InvestigationKind::Advisory => prefs.magic_prompt_models.investigate_advisory_model.clone(),
    };
    let magic_backend = match kind {
        InvestigationKind::Issue => prefs
            .magic_prompt_backends
            .investigate_issue_backend
            .as_deref(),
        InvestigationKind::Pr => prefs
            .magic_prompt_backends
            .investigate_pr_backend
            .as_deref(),
        InvestigationKind::Linear => prefs
            .magic_prompt_backends
            .investigate_linear_issue_backend
            .as_deref(),
        InvestigationKind::Advisory => prefs
            .magic_prompt_backends
            .investigate_advisory_backend
            .as_deref(),
    };
    let provider = match kind {
        InvestigationKind::Issue => prefs
            .magic_prompt_providers
            .investigate_issue_provider
            .clone()
            .or_else(|| prefs.default_provider.clone()),
        InvestigationKind::Pr => prefs
            .magic_prompt_providers
            .investigate_pr_provider
            .clone()
            .or_else(|| prefs.default_provider.clone()),
        InvestigationKind::Linear => prefs
            .magic_prompt_providers
            .investigate_linear_issue_provider
            .clone()
            .or_else(|| prefs.default_provider.clone()),
        InvestigationKind::Advisory => prefs
            .magic_prompt_providers
            .investigate_advisory_provider
            .clone()
            .or_else(|| prefs.default_provider.clone()),
    };
    let effort = match kind {
        InvestigationKind::Issue => prefs.magic_prompt_efforts.investigate_issue_effort.clone(),
        InvestigationKind::Pr => prefs.magic_prompt_efforts.investigate_pr_effort.clone(),
        InvestigationKind::Linear => prefs
            .magic_prompt_efforts
            .investigate_linear_issue_effort
            .clone(),
        InvestigationKind::Advisory => prefs
            .magic_prompt_efforts
            .investigate_advisory_effort
            .clone(),
    }
    .or_else(|| Some(prefs.default_codex_reasoning_effort.clone()));
    let execution_mode = match kind {
        InvestigationKind::Issue => prefs.magic_prompt_modes.investigate_issue_mode.clone(),
        InvestigationKind::Pr => prefs.magic_prompt_modes.investigate_pr_mode.clone(),
        InvestigationKind::Linear => prefs
            .magic_prompt_modes
            .investigate_linear_issue_mode
            .clone(),
        InvestigationKind::Advisory => prefs.magic_prompt_modes.investigate_advisory_mode.clone(),
    };

    let worktree_id = worktree.get("id").and_then(|v| v.as_str());
    let default_backend = project_default_backend(app, worktree_id).unwrap_or_else(|| {
        if !prefs.default_backend.trim().is_empty() {
            prefs.default_backend.clone()
        } else {
            infer_backend_from_model(&model).to_string()
        }
    });
    let backend = magic_backend
        .filter(|b| !b.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(default_backend);

    InvestigationSelection {
        backend,
        model,
        provider,
        effort,
        execution_mode,
    }
}

pub(crate) fn build_investigation_prompt(
    prefs: &crate::AppPreferences,
    worktree: &Value,
    kind: InvestigationKind,
) -> String {
    match kind {
        InvestigationKind::Issue => {
            let number = worktree
                .get("issue_number")
                .or_else(|| worktree.get("issueNumber"))
                .and_then(|v| v.as_u64())
                .map(|n| format!("#{n}"))
                .unwrap_or_else(|| "the loaded issue".to_string());
            let template = prefs
                .magic_prompts
                .investigate_issue
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(crate::default_investigate_issue_prompt);
            template
                .replace("{issueWord}", "issue")
                .replace("{issueRefs}", &number)
        }
        InvestigationKind::Pr => {
            let number = worktree
                .get("pr_number")
                .or_else(|| worktree.get("prNumber"))
                .and_then(|v| v.as_u64())
                .map(|n| format!("#{n}"))
                .unwrap_or_else(|| "the loaded PR".to_string());
            let template = prefs
                .magic_prompts
                .investigate_pr
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(crate::default_investigate_pr_prompt);
            template
                .replace("{prWord}", "PR")
                .replace("{prRefs}", &number)
        }
        InvestigationKind::Linear => {
            let identifier = worktree
                .get("linear_issue_identifier")
                .or_else(|| worktree.get("linearIssueIdentifier"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "the loaded Linear issue".to_string());
            let template = prefs
                .magic_prompts
                .investigate_linear_issue
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(crate::default_investigate_linear_issue_prompt);
            // The full Linear issue context is loaded into the session via the
            // context file written during worktree creation, so {linearContext}
            // is cleared here to avoid a dangling placeholder (mirrors how the
            // GitHub MCP path references only the issue/PR number).
            template
                .replace("{linearWord}", "issue")
                .replace("{linearRefs}", &identifier)
                .replace("{linearContext}", "")
        }
        InvestigationKind::Advisory => {
            let ghsa_id = worktree
                .get("advisory_ghsa_id")
                .or_else(|| worktree.get("advisoryGhsaId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "the loaded security advisory".to_string());
            let template = prefs
                .magic_prompts
                .investigate_advisory
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(crate::default_investigate_advisory_prompt);
            // Full advisory context is written to a session context file during
            // worktree creation, so the prompt only needs the GHSA id reference.
            template
                .replace("{advisoryWord}", "advisory")
                .replace("{advisoryRefs}", &ghsa_id)
        }
    }
}

fn project_default_backend(app: &AppHandle, worktree_id: Option<&str>) -> Option<String> {
    let worktree_id = worktree_id?;
    let data = crate::projects::storage::load_projects_data(app).ok()?;
    let worktree = data.find_worktree(worktree_id)?;
    let project = data.find_project(&worktree.project_id)?;
    project.default_backend.clone()
}

fn infer_backend_from_model(model: &str) -> &'static str {
    if crate::is_cursor_model(model) {
        "cursor"
    } else if crate::is_pi_model(model) {
        "pi"
    } else if crate::is_opencode_model(model) {
        "opencode"
    } else if model.starts_with("commandcode/") {
        "commandcode"
    } else if crate::is_grok_model(model) {
        "grok"
    } else if crate::is_kimi_model(model) {
        "kimi"
    } else if crate::is_codex_model(model) {
        "codex"
    } else {
        "claude"
    }
}

fn normalize_backend_name(backend: &str) -> Result<String, ToolError> {
    let normalized = backend.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "claude" | "codex" | "cursor" | "opencode" | "pi" | "commandcode" | "grok" | "kimi" => {
            Ok(normalized)
        }
        other => Err(ToolError::invalid_params(format!(
            "backend must be one of claude, codex, cursor, opencode, pi, commandcode, grok, kimi (got '{other}')"
        ))),
    }
}

async fn get_usage_snapshots(app: &AppHandle, backend_filter: &str) -> Result<Value, ToolError> {
    let want_all = backend_filter == "all";
    let mut result = serde_json::Map::new();
    let mut errors = serde_json::Map::new();

    if want_all || backend_filter == "claude" {
        match dispatch_command(app, "get_claude_usage", json!({})).await {
            Ok(usage) => {
                result.insert("claude".to_string(), usage);
            }
            Err(err) => {
                result.insert("claude".to_string(), Value::Null);
                errors.insert("claude".to_string(), Value::String(err));
            }
        }
    }

    if want_all || backend_filter == "codex" {
        match dispatch_command(app, "get_codex_usage", json!({})).await {
            Ok(usage) => {
                result.insert("codex".to_string(), usage);
            }
            Err(err) => {
                result.insert("codex".to_string(), Value::Null);
                errors.insert("codex".to_string(), Value::String(err));
            }
        }
    }

    if want_all || backend_filter == "grok" {
        match dispatch_command(app, "get_grok_usage", json!({})).await {
            Ok(usage) => {
                result.insert("grok".to_string(), usage);
            }
            Err(err) => {
                result.insert("grok".to_string(), Value::Null);
                errors.insert("grok".to_string(), Value::String(err));
            }
        }
    }

    if !errors.is_empty() {
        result.insert("errors".to_string(), Value::Object(errors));
    }

    Ok(Value::Object(result))
}

fn require_value_str(value: &Value, key: &str) -> Result<String, ToolError> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ToolError::internal(format!("missing string field '{key}' in result")))
}

fn resolve_project_path(app: &AppHandle, project_id: &str) -> Result<String, ToolError> {
    let data = crate::projects::storage::load_projects_data(app)
        .map_err(|e| ToolError::internal(format!("load_projects_data: {e}")))?;
    data.find_project(project_id)
        .map(|p| p.path.clone())
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown projectId: {project_id}")))
}

fn resolve_worktree_path(app: &AppHandle, worktree_id: &str) -> Result<String, ToolError> {
    let data = crate::projects::storage::load_projects_data(app)
        .map_err(|e| ToolError::internal(format!("load_projects_data: {e}")))?;
    data.find_worktree(worktree_id)
        .map(|w| w.path.clone())
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown worktreeId: {worktree_id}")))
}

fn resolve_worktree_project(
    app: &AppHandle,
    worktree_id: &str,
) -> Result<(String, String, String), ToolError> {
    let data = crate::projects::storage::load_projects_data(app)
        .map_err(|e| ToolError::internal(format!("load_projects_data: {e}")))?;
    let wt = data
        .find_worktree(worktree_id)
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown worktreeId: {worktree_id}")))?;
    let project = data.find_project(&wt.project_id).ok_or_else(|| {
        ToolError::internal(format!("Worktree {worktree_id} has no parent project"))
    })?;
    Ok((
        project.id.clone(),
        project.name.clone(),
        project.path.clone(),
    ))
}

fn resolve_session_worktree(
    app: &AppHandle,
    session_id: &str,
) -> Result<(String, String), ToolError> {
    let metadata = crate::chat::storage::load_metadata(app, session_id)
        .map_err(|e| ToolError::internal(format!("load_metadata: {e}")))?
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown sessionId: {session_id}")))?;
    let worktree_path = resolve_worktree_path(app, &metadata.worktree_id)?;
    Ok((metadata.worktree_id, worktree_path))
}

/// Reject MCP mutations/runs when the worktree is archived.
fn ensure_mcp_worktree_not_archived(app: &AppHandle, worktree_id: &str) -> Result<(), ToolError> {
    crate::chat::ensure_worktree_not_archived(
        worktree_id,
        crate::chat::worktree_archived_at(app, worktree_id),
    )
    .map_err(ToolError::invalid_params)
}

/// Reject MCP send_chat_message when the session or its worktree is archived.
fn ensure_mcp_session_can_run(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<(), ToolError> {
    let metadata = crate::chat::storage::load_metadata(app, session_id)
        .map_err(|e| ToolError::internal(format!("load_metadata: {e}")))?
        .ok_or_else(|| ToolError::invalid_params(format!("Unknown sessionId: {session_id}")))?;
    crate::chat::ensure_session_can_run(
        session_id,
        metadata.archived_at,
        worktree_id,
        crate::chat::worktree_archived_at(app, worktree_id),
    )
    .map_err(ToolError::invalid_params)
}

fn rate_check(source: &str, tool: &str, limit_per_minute: u32) -> bool {
    if limit_per_minute == 0 {
        return true;
    }
    let now = Instant::now();
    let mut buckets = match RATE_BUCKETS.lock() {
        Ok(b) => b,
        Err(p) => p.into_inner(),
    };
    let bucket = buckets.entry(format!("{source}::{tool}")).or_default();
    while let Some(t) = bucket.front() {
        if now.duration_since(*t) > RATE_LIMIT_WINDOW {
            bucket.pop_front();
        } else {
            break;
        }
    }
    if bucket.len() as u32 >= limit_per_minute {
        return false;
    }
    bucket.push_back(now);
    true
}

pub fn jsonrpc_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

pub fn jsonrpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_tool(tools: &Value, name: &str) -> Value {
        tools
            .as_array()
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("name").and_then(|tool_name| tool_name.as_str()) == Some(name)
                })
            })
            .cloned()
            .unwrap_or_else(|| panic!("{name} tool exists"))
    }

    #[test]
    fn create_worktree_schema_documents_no_open_default() {
        let tools = tool_registry();
        let create_worktree = find_tool(&tools, "create_worktree");

        assert!(
            create_worktree["inputSchema"]["properties"]
                .get("openInJean")
                .is_none(),
            "Jean MCP create_worktree must not expose an auto-open option"
        );
        assert!(
            !create_worktree["description"]
                .as_str()
                .unwrap_or_default()
                .contains("openInJean"),
            "Jean MCP create_worktree docs must not mention openInJean"
        );
        assert_eq!(
            create_worktree["inputSchema"]["properties"]["action"]["enum"][0],
            "start_autoinvestigating"
        );
        assert_eq!(
            create_worktree["inputSchema"]["properties"]["prNumber"]["type"],
            "integer"
        );
    }

    #[test]
    fn create_worktree_schema_exposes_linear_identifier() {
        let tools = tool_registry();
        let create_worktree = find_tool(&tools, "create_worktree");
        assert_eq!(
            create_worktree["inputSchema"]["properties"]["linearIssueIdentifier"]["type"], "string",
            "create_worktree must expose a linearIssueIdentifier input"
        );
    }

    #[test]
    fn create_worktree_schema_exposes_ghsa_id() {
        let tools = tool_registry();
        let create_worktree = find_tool(&tools, "create_worktree");
        assert_eq!(
            create_worktree["inputSchema"]["properties"]["ghsaId"]["type"],
            "string",
            "create_worktree must expose a ghsaId input for security advisories"
        );
        let description = create_worktree["description"].as_str().unwrap_or_default();
        assert!(
            description.contains("ghsaId"),
            "create_worktree description must document ghsaId"
        );
        assert!(
            description.contains("security advisory") || description.contains("security advisories"),
            "create_worktree description must mention security advisories"
        );
    }

    #[test]
    fn parse_linear_issue_number_extracts_trailing_number() {
        assert_eq!(parse_linear_issue_number("PLA-215"), Some(215));
        assert_eq!(parse_linear_issue_number("eng-12"), Some(12));
        assert_eq!(parse_linear_issue_number("  ABC-7  "), Some(7));
        assert_eq!(parse_linear_issue_number("215"), Some(215));
    }

    #[test]
    fn parse_linear_issue_number_rejects_invalid() {
        assert_eq!(parse_linear_issue_number("PLA-"), None);
        assert_eq!(parse_linear_issue_number("PLA-abc"), None);
        assert_eq!(parse_linear_issue_number(""), None);
        assert_eq!(parse_linear_issue_number("PLA-0"), None);
    }

    #[test]
    fn validate_inputs_rejects_github_and_linear_together() {
        // issueNumber + linearIssueIdentifier
        let err = validate_create_worktree_inputs(true, false, true, false, None).unwrap_err();
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("linearIssueIdentifier"));
        // prNumber + linearIssueIdentifier
        let err = validate_create_worktree_inputs(false, true, true, false, None).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn validate_inputs_rejects_issue_and_pr_together() {
        let err = validate_create_worktree_inputs(true, true, false, false, None).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn validate_inputs_rejects_advisory_with_other_context() {
        let err = validate_create_worktree_inputs(true, false, false, true, None).unwrap_err();
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("ghsaId"));
        let err = validate_create_worktree_inputs(false, true, false, true, None).unwrap_err();
        assert_eq!(err.code, -32602);
        let err = validate_create_worktree_inputs(false, false, true, true, None).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn validate_inputs_allows_linear_only_autoinvestigate() {
        // Linear identifier alone satisfies the autoinvestigate guard.
        assert!(validate_create_worktree_inputs(
            false,
            false,
            true,
            false,
            Some("start_autoinvestigating")
        )
        .is_ok());
        // No context at all fails the autoinvestigate guard.
        assert!(validate_create_worktree_inputs(
            false,
            false,
            false,
            false,
            Some("start_autoinvestigating")
        )
        .is_err());
    }

    #[test]
    fn validate_inputs_allows_advisory_only_autoinvestigate() {
        assert!(validate_create_worktree_inputs(
            false,
            false,
            false,
            true,
            Some("start_autoinvestigating")
        )
        .is_ok());
    }

    #[test]
    fn validate_inputs_allows_single_context() {
        assert!(validate_create_worktree_inputs(true, false, false, false, None).is_ok());
        assert!(validate_create_worktree_inputs(false, true, false, false, None).is_ok());
        assert!(validate_create_worktree_inputs(false, false, true, false, None).is_ok());
        assert!(validate_create_worktree_inputs(false, false, false, true, None).is_ok());
        assert!(validate_create_worktree_inputs(false, false, false, false, None).is_ok());
    }

    #[test]
    fn build_investigation_prompt_for_advisory_uses_ghsa_id() {
        let prefs = crate::AppPreferences::default();
        let worktree = json!({
            "advisory_ghsa_id": "GHSA-xxxx-yyyy-zzzz",
        });
        let prompt =
            build_investigation_prompt(&prefs, &worktree, InvestigationKind::Advisory);
        assert!(
            prompt.contains("GHSA-xxxx-yyyy-zzzz"),
            "advisory investigation prompt should include the GHSA id"
        );
        assert!(
            prompt.contains("advisory"),
            "advisory investigation prompt should use advisory wording"
        );
    }

    #[test]
    fn tool_registry_includes_pr_listing() {
        let tools = tool_registry();
        let has_pr_list = tools.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("name").and_then(|name| name.as_str()) == Some("list_github_prs")
            })
        });

        assert!(has_pr_list);
    }

    #[test]
    fn tool_registry_includes_project_lifecycle_tools() {
        let tools = tool_registry();
        let add_project = find_tool(&tools, "add_project");
        let clone_project = find_tool(&tools, "clone_project");
        let init_project = find_tool(&tools, "init_project");

        assert_eq!(
            add_project["inputSchema"]["required"],
            json!(["path"]),
            "add_project requires a local path"
        );
        assert!(
            add_project["inputSchema"]["properties"]
                .get("parentId")
                .is_some(),
            "add_project should accept optional parentId"
        );
        assert_eq!(
            clone_project["inputSchema"]["required"],
            json!(["url", "path"]),
            "clone_project requires remote url and local path"
        );
        assert_eq!(
            init_project["inputSchema"]["required"],
            json!(["path"]),
            "init_project requires a path for the new repo"
        );
        assert!(
            RATE_LIMITED_TOOLS.contains(&"add_project")
                && RATE_LIMITED_TOOLS.contains(&"clone_project")
                && RATE_LIMITED_TOOLS.contains(&"init_project"),
            "project lifecycle tools must be rate-limited"
        );
    }

    #[test]
    fn tool_registry_includes_worktree_lifecycle_tools() {
        let tools = tool_registry();
        let names: std::collections::HashSet<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|item| item.get("name").and_then(|name| name.as_str()))
            .collect();

        for expected in [
            "create_worktree_from_existing_branch",
            "import_worktree",
            "rename_worktree",
            "archive_worktree",
            "unarchive_worktree",
            "list_archived_worktrees",
            "delete_worktree",
            "permanently_delete_worktree",
        ] {
            assert!(names.contains(expected), "missing MCP tool {expected}");
        }

        let create_from_branch = find_tool(&tools, "create_worktree_from_existing_branch");
        assert_eq!(
            create_from_branch["inputSchema"]["required"],
            json!(["projectId", "branchName"])
        );
        assert!(
            create_from_branch["inputSchema"]["properties"]
                .get("autoOpenInJean")
                .is_none(),
            "MCP must not expose auto-open for create_worktree_from_existing_branch"
        );

        let list_archived = find_tool(&tools, "list_archived_worktrees");
        assert!(
            list_archived["inputSchema"]["properties"]
                .get("projectId")
                .is_some(),
            "list_archived_worktrees should allow optional projectId filter"
        );

        let rename = find_tool(&tools, "rename_worktree");
        assert_eq!(
            rename["inputSchema"]["required"],
            json!(["worktreeId", "newName"])
        );

        for limited in [
            "archive_worktree",
            "unarchive_worktree",
            "delete_worktree",
            "permanently_delete_worktree",
            "import_worktree",
            "create_worktree_from_existing_branch",
        ] {
            assert!(
                RATE_LIMITED_TOOLS.contains(&limited),
                "worktree mutation tool {limited} must be rate-limited"
            );
        }
    }

    #[test]
    fn require_nonempty_str_rejects_blank_values() {
        let err = require_nonempty_str(&json!({ "path": "   " }), "path").unwrap_err();
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("path"));

        let value = require_nonempty_str(&json!({ "path": " /tmp/repo " }), "path").unwrap();
        assert_eq!(value, "/tmp/repo");
    }

    #[test]
    fn tool_registry_includes_first_release_observability_tools() {
        let tools = tool_registry();
        let names: std::collections::HashSet<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|item| item.get("name").and_then(|name| name.as_str()))
            .collect();

        for expected in [
            "get_project_context",
            "list_sessions",
            "get_session_status",
            "cancel_session_run",
            "get_worktree_changes",
            "get_worktree_diff",
            "get_usage",
            "set_session_model",
            "archive_session",
            "unarchive_session",
        ] {
            assert!(names.contains(expected), "missing MCP tool {expected}");
        }

        for limited in ["archive_session", "unarchive_session"] {
            assert!(
                RATE_LIMITED_TOOLS.contains(&limited),
                "session archive tool {limited} must be rate-limited"
            );
        }

        let archive = find_tool(&tools, "archive_session");
        assert_eq!(
            archive["inputSchema"]["required"],
            json!(["sessionId"])
        );
        let unarchive = find_tool(&tools, "unarchive_session");
        assert_eq!(
            unarchive["inputSchema"]["required"],
            json!(["sessionId"])
        );
        assert!(
            find_tool(&tools, "send_chat_message")["description"]
                .as_str()
                .unwrap_or("")
                .contains("archived"),
            "send_chat_message description should mention archive rejection"
        );
    }

    #[test]
    fn tool_registry_get_usage_and_set_session_model_schemas() {
        let tools = tool_registry();

        let get_usage = find_tool(&tools, "get_usage");
        assert_eq!(
            get_usage["inputSchema"]["properties"]["backend"]["enum"],
            json!(["claude", "codex", "grok", "all"])
        );
        assert!(
            !RATE_LIMITED_TOOLS.contains(&"get_usage"),
            "get_usage is read-only and should not be rate-limited"
        );

        let set_model = find_tool(&tools, "set_session_model");
        assert_eq!(
            set_model["inputSchema"]["required"],
            json!(["sessionId", "model"])
        );
        assert_eq!(
            set_model["inputSchema"]["properties"]["backend"]["enum"],
            json!([
                "claude",
                "codex",
                "cursor",
                "opencode",
                "pi",
                "commandcode",
                "grok",
                "kimi"
            ])
        );
        assert!(
            RATE_LIMITED_TOOLS.contains(&"set_session_model"),
            "set_session_model mutates session state and should be rate-limited"
        );
    }

    #[test]
    fn infer_backend_from_model_covers_catalog_prefixes() {
        assert_eq!(infer_backend_from_model("claude-sonnet-4-6[1m]"), "claude");
        assert_eq!(infer_backend_from_model("gpt-5.6-sol"), "codex");
        assert_eq!(infer_backend_from_model("grok/grok-4.5"), "grok");
        assert_eq!(infer_backend_from_model("cursor/auto"), "cursor");
        assert_eq!(infer_backend_from_model("opencode/gpt-5.2"), "opencode");
        assert_eq!(infer_backend_from_model("pi/sonnet"), "pi");
        assert_eq!(infer_backend_from_model("kimi/k2"), "kimi");
        assert_eq!(
            infer_backend_from_model("commandcode/default"),
            "commandcode"
        );
    }

    #[test]
    fn normalize_backend_name_accepts_known_backends() {
        assert_eq!(normalize_backend_name("Claude").unwrap(), "claude");
        assert_eq!(normalize_backend_name("GROK").unwrap(), "grok");
        assert!(normalize_backend_name("openai").is_err());
    }

    #[test]
    fn tool_registry_includes_ship_loop_tools() {
        let tools = tool_registry();
        let names: std::collections::HashSet<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|item| item.get("name").and_then(|name| name.as_str()))
            .collect();

        for expected in [
            "create_commit",
            "push_worktree",
            "detect_open_pr",
            "create_pull_request",
            "merge_pull_request",
            "run_review",
        ] {
            assert!(names.contains(expected), "missing MCP tool {expected}");
        }

        let create_commit = find_tool(&tools, "create_commit");
        assert_eq!(
            create_commit["inputSchema"]["required"],
            json!(["worktreeId"])
        );
        assert_eq!(
            create_commit["inputSchema"]["properties"]["push"]["type"],
            "boolean"
        );

        let create_pr = find_tool(&tools, "create_pull_request");
        assert_eq!(
            create_pr["inputSchema"]["required"],
            json!(["worktreeId"])
        );
        assert!(
            create_pr["inputSchema"]["properties"]
                .get("sessionId")
                .is_some()
        );

        for limited in [
            "create_commit",
            "create_pull_request",
            "merge_pull_request",
            "push_worktree",
            "run_review",
        ] {
            assert!(
                RATE_LIMITED_TOOLS.contains(&limited),
                "ship-loop mutation tool {limited} must be rate-limited"
            );
        }
        assert!(
            !RATE_LIMITED_TOOLS.contains(&"detect_open_pr"),
            "detect_open_pr is read-only and should not be rate-limited"
        );
    }

    #[test]
    fn tool_registry_includes_worktree_label_mutation_tool() {
        let tools = tool_registry();
        let update_worktree_labels = find_tool(&tools, "update_worktree_labels");

        assert_eq!(
            update_worktree_labels["inputSchema"]["properties"]["action"]["enum"],
            json!(["add", "remove", "set", "clear"])
        );
        assert_eq!(
            update_worktree_labels["inputSchema"]["required"],
            json!(["worktreeId", "action"])
        );
    }

    #[test]
    fn deletion_tools_report_background_work_as_started() {
        for action in ["delete", "permanently_delete"] {
            let result = deletion_started_result("worktree-1", action);

            assert_eq!(result["worktreeId"], "worktree-1");
            assert_eq!(result["action"], action);
            assert_eq!(result["started"], true);
            assert!(result.get("ok").is_none());
        }
    }

    #[test]
    fn deletion_tool_descriptions_explain_background_completion() {
        let tools = tool_registry();

        for name in ["delete_worktree", "permanently_delete_worktree"] {
            let tool = find_tool(&tools, name);
            let description = tool["description"]
                .as_str()
                .expect("tool description");

            assert!(description.contains("background"));
            assert!(description.contains("started"));
            assert!(description.contains("not completion"));
        }
    }

    #[test]
    fn add_worktree_label_upserts_case_insensitively() {
        let current = vec![crate::chat::types::LabelData {
            name: "Feature".to_string(),
            color: "#22c55e".to_string(),
            pinned: false,
        }];
        let label = crate::chat::types::LabelData {
            name: "feature".to_string(),
            color: "#ef4444".to_string(),
            pinned: false,
        };

        let next = add_or_update_label(current, label);

        assert_eq!(next.len(), 1);
        assert_eq!(next[0].name, "Feature");
        assert_eq!(next[0].color, "#ef4444");
    }

    #[test]
    fn remove_worktree_label_matches_case_insensitively() {
        let current = vec![
            crate::chat::types::LabelData {
                name: "Feature".to_string(),
                color: "#22c55e".to_string(),
                pinned: false,
            },
            crate::chat::types::LabelData {
                name: "Blocked".to_string(),
                color: "#ef4444".to_string(),
                pinned: false,
            },
        ];

        let next = remove_label_by_name(current, "feature");

        assert_eq!(next.len(), 1);
        assert_eq!(next[0].name, "Blocked");
    }

    #[test]
    fn set_worktree_labels_dedupes_by_name() {
        let labels = vec![
            crate::chat::types::LabelData {
                name: "Feature".to_string(),
                color: "#22c55e".to_string(),
                pinned: false,
            },
            crate::chat::types::LabelData {
                name: "feature".to_string(),
                color: "#ef4444".to_string(),
                pinned: false,
            },
        ];

        let next = normalize_mcp_labels(labels).expect("labels normalize");

        assert_eq!(next.len(), 1);
        assert_eq!(next[0].name, "Feature");
        assert_eq!(next[0].color, "#22c55e");
    }

    #[test]
    fn parse_worktree_label_rejects_empty_name() {
        let err = parse_label_arg(&json!({
            "label": { "name": "   ", "color": "#ef4444" }
        }))
        .expect_err("empty label name should fail");

        assert!(err.message.contains("label.name"));
    }

    #[test]
    fn parse_worktree_label_rejects_invalid_color() {
        let err = parse_label_arg(&json!({
            "label": { "name": "Blocked", "color": "red" }
        }))
        .expect_err("invalid label color should fail");

        assert!(err.message.contains("label.color"));
    }

    #[test]
    fn worktree_diff_schema_is_bounded() {
        let tools = tool_registry();
        let get_worktree_diff = find_tool(&tools, "get_worktree_diff");

        assert_eq!(
            get_worktree_diff["inputSchema"]["properties"]["maxBytes"]["maximum"],
            MAX_MCP_DIFF_BYTES
        );
        assert_eq!(
            get_worktree_diff["inputSchema"]["properties"]["diffType"]["enum"][0],
            "uncommitted"
        );
    }

    #[test]
    fn no_current_context_error_explains_manual_sources() {
        let error = no_current_context_error("manual-dev");

        assert!(error.message.contains("manual-dev"));
        assert!(error.message.contains("Jean-spawned chat sessions"));
        assert!(error.message.contains("list_projects -> list_worktrees"));
        assert!(error.message.contains("get_session_status(sessionId)"));
    }

    #[test]
    fn tool_registry_includes_security_and_linear_issue_tools() {
        let tools = tool_registry();
        let names: std::collections::HashSet<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|item| item.get("name").and_then(|name| name.as_str()))
            .collect();

        for expected in [
            "list_security_issues",
            "list_security_advisories",
            "list_linear_issues",
        ] {
            assert!(names.contains(expected), "missing MCP tool {expected}");
        }
    }

    #[test]
    fn security_issue_schema_matches_ui_backed_dependabot_states() {
        let tools = tool_registry();
        let list_security_issues = find_tool(&tools, "list_security_issues");
        let state = &list_security_issues["inputSchema"]["properties"]["state"];

        assert_eq!(state["default"], "open");
        assert_eq!(
            state["enum"],
            json!(["open", "dismissed", "fixed", "auto_dismissed", "all"])
        );
        assert_eq!(
            list_security_issues["inputSchema"]["required"],
            json!(["projectId"])
        );
    }

    #[test]
    fn security_advisory_and_linear_schemas_require_project_id() {
        let tools = tool_registry();
        let list_security_advisories = find_tool(&tools, "list_security_advisories");
        let list_linear_issues = find_tool(&tools, "list_linear_issues");

        assert_eq!(
            list_security_advisories["inputSchema"]["properties"]["state"]["default"],
            "all"
        );
        assert_eq!(
            list_security_advisories["inputSchema"]["required"],
            json!(["projectId"])
        );
        assert_eq!(
            list_linear_issues["inputSchema"]["required"],
            json!(["projectId"])
        );
        assert!(list_linear_issues["inputSchema"]["properties"]
            .get("projectId")
            .is_some());
    }

    #[test]
    fn background_investigation_prompt_is_queued_with_send_settings() {
        let queued = build_background_investigation_queue_message(
            "Investigate issue #42".to_string(),
            "gpt-5.6-sol".to_string(),
            "codex".to_string(),
            Some("profile-a".to_string()),
            Some("high".to_string()),
            "yolo".to_string(),
            None,
            None,
            None,
            None,
        );

        assert_eq!(queued["message"], "Investigate issue #42");
        assert_eq!(queued["model"], "gpt-5.6-sol");
        assert_eq!(queued["backend"], "codex");
        assert_eq!(queued["provider"], "profile-a");
        assert_eq!(queued["effortLevel"], "high");
        assert_eq!(queued["executionMode"], "yolo");
        assert_eq!(queued["thinkingLevel"], "think");
        assert_eq!(queued["allowAllTools"], true);
        assert!(queued["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(queued["queuedAt"].as_u64().is_some());
    }

    #[test]
    fn yolo_investigation_appends_unconditional_fix_directive() {
        let prompt = "Investigate issue #42\n6. Propose solution\n7. If you are in yolo mode, also apply the fix(es)\nDo not implement fixes.";
        let result = apply_yolo_investigation_fix_directive(prompt, "yolo");
        assert!(result.contains(YOLO_INVESTIGATION_FIX_MARKER));
        assert!(result.contains("After investigation, fix the issue"));
        assert!(!result.to_ascii_lowercase().contains("if you are in yolo mode"));
        assert!(!result.to_ascii_lowercase().contains("do not implement fixes"));
        assert!(result.contains("Propose solution"));
    }

    #[test]
    fn non_yolo_investigation_prompt_is_unchanged() {
        let prompt = "Investigate issue #42\nDo not implement fixes.";
        assert_eq!(
            apply_yolo_investigation_fix_directive(prompt, "plan"),
            prompt
        );
        assert_eq!(
            apply_yolo_investigation_fix_directive(prompt, "build"),
            prompt
        );
    }

    #[test]
    fn yolo_investigation_fix_directive_is_idempotent() {
        let once = apply_yolo_investigation_fix_directive("Investigate #1", "yolo");
        let twice = apply_yolo_investigation_fix_directive(&once, "yolo");
        assert_eq!(once, twice);
        assert_eq!(once.matches(YOLO_INVESTIGATION_FIX_MARKER).count(), 1);
    }
}

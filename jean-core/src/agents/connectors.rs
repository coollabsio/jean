//! Per-agent MCP connector allowlist.
//!
//! Discovery stays per backend CLI (`<backend>_cli/mcp.rs` plus
//! `chat/mcp_external`). This module decides whether an agent's saved
//! allowlist can be turned into the per-session `mcpConfig` JSON that
//! `send_chat_message` already forwards.
//!
//! `None` on the agent means no limit: the caller’s config is left as it is
//! (today’s behavior). An empty list is a real limit that allows no user MCP
//! servers. Jean MCP is merged afterwards by the existing Claude/Grok/Cursor
//! path and is not part of this allowlist.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::db::{Agent, AgentConnector};

/// How a backend receives MCP servers for one agent turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpSessionSupport {
    /// The process or ACP session takes a server list and does not change the
    /// user's shared config permanently.
    PerSession,
    /// The CLI loads a global or project config. Applying an allowlist would
    /// either do nothing or mutate shared state.
    Unsupported,
}

/// One server returned by `get_mcp_servers`.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredConnector {
    pub backend: String,
    pub name: String,
    pub config: Value,
    pub disabled: bool,
}

/// What to do with the `mcpConfig` argument of `send_chat_message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpConfigPlan {
    /// No agent limit. Keep the config the caller sent.
    Keep,
    /// Replace it. `{"mcpServers":{}}` means no user servers.
    Replace(String),
    /// A limit is saved, and this backend cannot apply it. Keep the caller’s
    /// config and say so. Do not pretend the limit took effect.
    Unsupported,
}

pub fn session_support(backend: &str) -> McpSessionSupport {
    match backend {
        "claude" | "grok" | "devin" => McpSessionSupport::PerSession,
        _ => McpSessionSupport::Unsupported,
    }
}

/// Why a backend can or cannot take a per-agent server list.
pub fn support_reason(backend: &str) -> &'static str {
    match backend {
        "claude" => {
            "Claude takes --mcp-config and --strict-mcp-config for this process. \
             claude.ai connectors and plugin servers are not in that file; when one \
             of them is allowed, strict mode stays off and Claude is told to deny \
             the other known servers."
        }
        "grok" => {
            "Grok takes the enabled servers as ACP mcpServers for this session. \
             Jean also rewrites disabled_mcp_servers for the turn and restores the \
             previous list afterwards."
        }
        "cursor" => {
            "Cursor applies MCP with `cursor mcp enable/disable`, which changes \
             shared workspace approval and is not restored after the turn."
        }
        "codex" => {
            "Codex loads MCP servers from ~/.codex/config.toml. A thread config \
             override can set the Jean session env on the existing Jean server, \
             not which servers exist."
        }
        "opencode" => {
            "OpenCode loads MCP servers from opencode.json. The session request \
             has no MCP config argument."
        }
        "pi" => "Pi sessions have no MCP config argument.",
        "commandcode" => "Command Code sessions have no MCP config argument.",
        "kimi" => {
            "Kimi ACP sessions always send mcpServers as an empty list and then \
             use the CLI's own config. Jean does not replace that list."
        }
        "antigravity" => {
            "Antigravity loads every enabled server from its persistent config. \
             There is no per-run MCP override."
        }
        "muse" => {
            "Muse sends only Jean MCP in session/start. Other servers come from \
             the CLI's settings.json."
        }
        "devin" => {
            "Devin local ACP sessions take mcpServers for this session. Cloud \
             sessions do not receive local MCP servers."
        }
        _ => "This backend has no per-session MCP config.",
    }
}

pub fn backend_label(backend: &crate::chat::types::Backend) -> &'static str {
    use crate::chat::types::Backend;
    match backend {
        Backend::Claude => "claude",
        Backend::Codex => "codex",
        Backend::Opencode => "opencode",
        Backend::Cursor => "cursor",
        Backend::Pi => "pi",
        Backend::Commandcode => "commandcode",
        Backend::Grok => "grok",
        Backend::Kimi => "kimi",
        Backend::Antigravity => "antigravity",
        Backend::Muse => "muse",
        Backend::Devin => "devin",
    }
}

/// Backends whose `get_mcp_servers` reads that CLI's own files.
/// Unknown backends fall through to Claude's files, so they are not listed here.
pub fn has_own_mcp_discovery(backend: &str) -> bool {
    matches!(
        backend,
        "claude"
            | "codex"
            | "opencode"
            | "cursor"
            | "grok"
            | "kimi"
            | "antigravity"
            | "muse"
            | "devin"
    )
}

pub fn empty_mcp_config() -> String {
    r#"{"mcpServers":{}}"#.to_string()
}

/// `discovered == None` means discovery failed. A per-session limit then becomes
/// an empty server list so the caller’s broader config is not kept by accident.
pub fn plan_mcp_config(
    allowlist: Option<&[AgentConnector]>,
    backend: &str,
    discovered: Option<&[DiscoveredConnector]>,
) -> McpConfigPlan {
    let Some(allowlist) = allowlist else {
        return McpConfigPlan::Keep;
    };
    if session_support(backend) != McpSessionSupport::PerSession {
        return McpConfigPlan::Unsupported;
    }
    let Some(discovered) = discovered else {
        return McpConfigPlan::Replace(empty_mcp_config());
    };
    McpConfigPlan::Replace(build_mcp_config(allowlist, backend, discovered))
}

/// JSON `{"mcpServers":{name: config}}` for servers on `backend` that the
/// allowlist names. Disabled servers stay in the list; the CLI config decides
/// whether they start. Servers for other backends are ignored.
pub fn build_mcp_config(
    allowlist: &[AgentConnector],
    backend: &str,
    discovered: &[DiscoveredConnector],
) -> String {
    let mut servers = serde_json::Map::new();
    for server in discovered {
        if server.backend != backend {
            continue;
        }
        let allowed = allowlist
            .iter()
            .any(|item| item.backend == backend && item.name == server.name);
        if !allowed {
            continue;
        }
        servers.insert(server.name.clone(), server.config.clone());
    }
    serde_json::to_string(&json!({ "mcpServers": servers })).unwrap_or_else(|_| empty_mcp_config())
}

/// Names in the config that will be passed, for logs. The config itself can
/// hold commands and tokens, so it is not logged.
pub fn mcp_config_server_names(config: &str) -> Vec<String> {
    serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|value| value.get("mcpServers")?.as_object().cloned())
        .map(|servers| {
            let mut names: Vec<String> = servers.keys().cloned().collect();
            names.sort();
            names
        })
        .unwrap_or_default()
}

/// Apply a saved allowlist for an agent session. Other sessions are unchanged.
pub async fn apply_agent_mcp_allowlist(
    app: &AppHandle,
    session_id: &str,
    worktree_path: &str,
    backend: &str,
    incoming: Option<String>,
) -> Option<String> {
    let Some(agent) = super::agent_for_session(app, session_id) else {
        return incoming;
    };
    if agent.mcp_servers.is_none() {
        return incoming;
    }
    let discovered = if session_support(backend) == McpSessionSupport::PerSession {
        match crate::chat::get_mcp_servers(
            app.clone(),
            Some(backend.to_string()),
            Some(worktree_path.to_string()),
        )
        .await
        {
            Ok(servers) => Some(
                servers
                    .into_iter()
                    .map(|server| DiscoveredConnector {
                        backend: server.backend,
                        name: server.name,
                        config: server.config,
                        disabled: server.disabled,
                    })
                    .collect::<Vec<_>>(),
            ),
            Err(error) => {
                log::warn!(
                    "[Agents] MCP discovery failed for agent {} on {backend}; \
                     passing no user MCP servers: {error}",
                    agent.id
                );
                None
            }
        }
    } else {
        Some(Vec::new())
    };
    match plan_mcp_config(agent.mcp_servers.as_deref(), backend, discovered.as_deref()) {
        McpConfigPlan::Keep => incoming,
        McpConfigPlan::Replace(config) => {
            log::info!(
                "[Agents] MCP allowlist applied agent={} session={session_id} backend={backend} servers={:?}",
                agent.id,
                mcp_config_server_names(&config)
            );
            Some(config)
        }
        McpConfigPlan::Unsupported => {
            log::warn!(
                "[Agents] MCP allowlist for agent {} is not applied on {backend}: {}",
                agent.id,
                support_reason(backend)
            );
            incoming
        }
    }
}

/// `None` allows every Jean tool. `claude_permission_prompt` stays available
/// so Claude's permission hook still works when a list is saved.
pub fn jean_tool_allowed(allowlist: Option<&[String]>, tool: &str) -> bool {
    if tool == crate::jean_mcp_core::CLAUDE_PERMISSION_PROMPT_TOOL {
        return true;
    }
    match allowlist {
        None => true,
        Some(names) => names.iter().any(|name| name == tool),
    }
}

/// Extra system-prompt text when a limit is saved. `None` when the agent is
/// on today's defaults, so the prompt does not claim a limit that is not there.
pub fn prompt_section(agent: &Agent) -> Option<String> {
    if agent.mcp_servers.is_none() && agent.jean_tools.is_none() {
        return None;
    }
    let mut out = String::from("## Connectors and tools\n");
    if let Some(list) = &agent.mcp_servers {
        let backend = agent.backend.as_deref().unwrap_or("");
        if backend.is_empty() {
            out.push_str(
                "A connector limit is saved. It is applied only when this session's backend is Claude or Grok. Other backends keep their own MCP config.\n",
            );
        } else if session_support(backend) == McpSessionSupport::PerSession {
            out.push_str(&format!(
                "This session's backend is {backend}. Only the MCP servers listed here are passed to it. Jean MCP stays available.\n"
            ));
        } else {
            out.push_str(&format!(
                "A connector limit is saved, but {backend} cannot apply it. {} Do not assume the limit is in effect.\n",
                support_reason(backend)
            ));
        }
        if list.is_empty() {
            out.push_str("No user MCP servers are allowed.\n");
        } else {
            out.push_str("Saved connectors:\n");
            for item in list {
                out.push_str(&format!("- {}:{}\n", item.backend, item.name));
            }
        }
    }
    if let Some(tools) = &agent.jean_tools {
        out.push_str("Jean tools you may call:\n");
        if tools.is_empty() {
            out.push_str("- (none)\n");
        } else {
            for tool in tools {
                out.push_str(&format!("- {tool}\n"));
            }
        }
        out.push_str("Any other Jean tool is refused.\n");
    }
    if jean_tool_allowed(agent.jean_tools.as_deref(), "list_connectors") {
        out.push_str("Use `list_connectors` to read this limit. It does not change it.\n");
    }
    Some(out)
}

fn jean_tool_catalog() -> Vec<Value> {
    let mut names = Vec::new();
    if let Some(tools) = crate::jean_mcp_core::tool_registry().as_array() {
        for tool in tools {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            if name == crate::jean_mcp_core::CLAUDE_PERMISSION_PROMPT_TOOL {
                continue;
            }
            names.push(name.to_string());
        }
    }
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "dangerous": super::mcp::APPROVAL_TOOLS.contains(&name.as_str()),
            })
        })
        .collect()
}

/// Static facts for the agent settings page.
pub fn catalog_payload() -> Value {
    let backends = [
        "claude",
        "codex",
        "opencode",
        "cursor",
        "pi",
        "commandcode",
        "grok",
        "kimi",
        "antigravity",
        "muse",
    ];
    let mut reasons = serde_json::Map::new();
    for backend in backends {
        reasons.insert(backend.to_string(), json!(support_reason(backend)));
    }
    json!({
        "perSessionBackends": ["claude", "grok"],
        "discoveryBackends": ["claude", "codex", "opencode", "cursor", "grok", "kimi", "antigravity", "muse"],
        "reasons": reasons,
        "jeanTools": jean_tool_catalog(),
    })
}

/// Read-only description for the `list_connectors` tool.
pub async fn report_for_session(app: &AppHandle, agent: &Agent, source: &str) -> Value {
    let backend = agent
        .backend
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            crate::chat::storage::load_metadata(app, source)
                .ok()
                .flatten()
                .map(|metadata| backend_label(&metadata.backend).to_string())
        })
        .unwrap_or_else(|| "claude".to_string());
    let support = session_support(&backend);
    let limited = agent.mcp_servers.is_some();
    let applied = limited && support == McpSessionSupport::PerSession;
    let path = super::agent_workdir(app, &agent.id).unwrap_or_default();
    let discovered = if has_own_mcp_discovery(&backend) && !path.is_empty() {
        crate::chat::get_mcp_servers(app.clone(), Some(backend.clone()), Some(path))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let allowlist = agent.mcp_servers.clone().unwrap_or_default();
    let mut connectors: Vec<Value> = discovered
        .iter()
        .map(|server| {
            let selected = allowlist
                .iter()
                .any(|item| item.backend == server.backend && item.name == server.name);
            json!({
                "backend": server.backend,
                "name": server.name,
                "scope": server.scope,
                "disabled": server.disabled,
                "discovered": true,
                "selected": selected,
            })
        })
        .collect();
    for item in &allowlist {
        if item.backend != backend {
            continue;
        }
        let known = discovered.iter().any(|server| server.name == item.name);
        if !known {
            connectors.push(json!({
                "backend": item.backend,
                "name": item.name,
                "discovered": false,
                "selected": true,
            }));
        }
    }
    json!({
        "backend": backend,
        "perSession": support == McpSessionSupport::PerSession,
        "limited": limited,
        "applied": applied,
        "note": if applied {
            "This backend receives only the selected connectors, plus Jean MCP."
        } else if limited {
            support_reason(&backend)
        } else {
            "No connector limit is saved. This agent keeps today's MCP behavior."
        },
        "connectors": connectors,
        "jeanTools": agent.jean_tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(backend: &str, name: &str, disabled: bool) -> DiscoveredConnector {
        DiscoveredConnector {
            backend: backend.into(),
            name: name.into(),
            config: json!({ "command": name, "disabled": disabled }),
            disabled,
        }
    }

    fn names(plan: &McpConfigPlan) -> Vec<String> {
        match plan {
            McpConfigPlan::Replace(config) => mcp_config_server_names(config),
            other => panic!("expected a replacement, got {other:?}"),
        }
    }

    #[test]
    fn unset_allowlist_keeps_the_caller_config() {
        let plan = plan_mcp_config(None, "claude", Some(&[]));
        assert_eq!(plan, McpConfigPlan::Keep);
        assert_eq!(
            plan_mcp_config(None, "codex", Some(&[])),
            McpConfigPlan::Keep
        );
    }

    #[test]
    fn claude_and_grok_receive_only_the_allowed_servers() {
        let allow = vec![
            AgentConnector {
                backend: "claude".into(),
                name: "alpha".into(),
            },
            AgentConnector {
                backend: "grok".into(),
                name: "gamma".into(),
            },
        ];
        let found = vec![
            server("claude", "alpha", false),
            server("claude", "beta", false),
            server("claude", "hidden", true),
            server("grok", "gamma", false),
        ];
        assert_eq!(
            names(&plan_mcp_config(Some(&allow), "claude", Some(&found))),
            vec!["alpha".to_string()]
        );
        assert_eq!(
            names(&plan_mcp_config(Some(&allow), "grok", Some(&found))),
            vec!["gamma".to_string()]
        );
        let with_disabled = vec![AgentConnector {
            backend: "claude".into(),
            name: "hidden".into(),
        }];
        assert_eq!(
            names(&plan_mcp_config(
                Some(&with_disabled),
                "claude",
                Some(&found)
            )),
            vec!["hidden".to_string()]
        );
    }

    #[test]
    fn empty_allowlist_and_failed_discovery_pass_no_user_servers() {
        let allow = Vec::new();
        assert_eq!(
            plan_mcp_config(
                Some(&allow),
                "claude",
                Some(&[server("claude", "alpha", false)])
            ),
            McpConfigPlan::Replace(empty_mcp_config())
        );
        assert_eq!(
            plan_mcp_config(
                Some(&[AgentConnector {
                    backend: "claude".into(),
                    name: "alpha".into(),
                }]),
                "grok",
                None
            ),
            McpConfigPlan::Replace(empty_mcp_config())
        );
    }

    #[test]
    fn backends_without_per_session_config_are_not_rewritten() {
        let allow = vec![AgentConnector {
            backend: "codex".into(),
            name: "alpha".into(),
        }];
        let found = [server("codex", "alpha", false)];
        for backend in [
            "codex",
            "cursor",
            "opencode",
            "pi",
            "commandcode",
            "kimi",
            "antigravity",
            "muse",
            "",
        ] {
            assert_eq!(
                session_support(backend),
                McpSessionSupport::Unsupported,
                "{backend}"
            );
            assert_eq!(
                plan_mcp_config(Some(&allow), backend, Some(&found)),
                McpConfigPlan::Unsupported,
                "{backend}"
            );
            assert!(!support_reason(backend).is_empty(), "{backend}");
        }
        assert_eq!(session_support("claude"), McpSessionSupport::PerSession);
        assert_eq!(session_support("grok"), McpSessionSupport::PerSession);
        assert!(support_reason("cursor").contains("shared"));
        assert!(support_reason("codex").contains("config.toml"));
        assert!(support_reason("kimi").contains("empty list"));
        assert!(support_reason("antigravity").contains("persistent"));
    }

    #[test]
    fn jean_tool_allowlist_blocks_unlisted_tools_and_keeps_the_permission_hook() {
        assert!(jean_tool_allowed(None, "delete_worktree"));
        let allow = ["notify_user".to_string()];
        assert!(jean_tool_allowed(Some(&allow), "notify_user"));
        assert!(!jean_tool_allowed(Some(&allow), "delete_worktree"));
        assert!(!jean_tool_allowed(Some(&[]), "list_projects"));
        assert!(jean_tool_allowed(
            Some(&[]),
            crate::jean_mcp_core::CLAUDE_PERMISSION_PROMPT_TOOL
        ));
    }

    #[test]
    fn prompt_mentions_a_saved_limit_and_an_unsupported_backend() {
        let mut agent = Agent {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: String::new(),
            icon: "blue".into(),
            role_prompt: String::new(),
            worktree_id: "__agent_reviewer__".into(),
            paused: false,
            max_wakes_per_hour: 12,
            builtin: false,
            backend: Some("codex".into()),
            model: None,
            effort: None,
            thinking_level: None,
            skills: Vec::new(),
            mcp_servers: Some(vec![AgentConnector {
                backend: "codex".into(),
                name: "alpha".into(),
            }]),
            jean_tools: Some(vec!["list_connectors".into(), "notify_user".into()]),
        };
        let prompt = prompt_section(&agent).unwrap();
        assert!(prompt.contains("cannot apply"));
        assert!(prompt.contains("codex:alpha"));
        assert!(prompt.contains("notify_user"));
        assert!(prompt.contains("list_connectors"));
        agent.jean_tools = Some(Vec::new());
        assert!(!prompt_section(&agent).unwrap().contains("list_connectors"));
        agent.mcp_servers = None;
        agent.jean_tools = None;
        assert!(prompt_section(&agent).is_none());
    }

    #[test]
    fn catalog_marks_destructive_jean_tools_and_names_per_session_backends() {
        let catalog = catalog_payload();
        assert_eq!(catalog["perSessionBackends"], json!(["claude", "grok"]));
        let discovery = catalog["discoveryBackends"].as_array().unwrap();
        assert!(discovery.iter().any(|backend| backend == "codex"));
        assert!(discovery
            .iter()
            .all(|backend| backend != "pi" && backend != "commandcode"));
        let tools = catalog["jeanTools"].as_array().unwrap();
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "delete_worktree" && tool["dangerous"] == true));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "list_projects" && tool["dangerous"] == false));
        assert!(tools
            .iter()
            .all(|tool| tool["name"] != "claude_permission_prompt"));
        assert!(catalog["reasons"]["opencode"]
            .as_str()
            .unwrap()
            .contains("opencode.json"));
    }
}

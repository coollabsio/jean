use std::collections::HashMap;

use serde::Serialize;

use super::types::TerminalPortInfo;
use crate::projects::types::PortEntry;

#[derive(Debug, Clone, Default)]
pub struct RunEnvironmentFilter {
    pub worktree_id: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LiveCommandTerminal {
    pub terminal_id: String,
    pub worktree_path: String,
    pub command: String,
    pub command_args: Option<Vec<String>>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PersistedCommandTerminal {
    pub worktree_id: String,
    pub terminal_id: String,
    pub command: String,
    pub command_args: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorktreeRef {
    pub id: String,
    pub name: String,
    pub path: String,
    pub project_id: String,
    pub is_base: bool,
}

#[derive(Debug, Clone)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvironmentPort {
    pub port: u16,
    pub process_name: Option<String>,
    pub local_address: Option<String>,
    pub url: String,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvironment {
    pub running: bool,
    pub terminal_id: String,
    pub worktree_id: Option<String>,
    pub worktree_name: Option<String>,
    pub worktree_path: String,
    pub is_base_session: bool,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub session_id: Option<String>,
    pub command: String,
    pub command_args: Option<Vec<String>>,
    pub ports: Vec<RunEnvironmentPort>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvironmentsResult {
    pub environments: Vec<RunEnvironment>,
}

pub fn normalize_path(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).to_string()
}

/// Build an http URL from an lsof listen address plus port.
pub fn url_from_listen_address(local_address: &str, port: u16) -> String {
    let host = host_from_listen_address(local_address);
    format_http_url(&host, port)
}

pub fn url_from_host_and_port(host: &str, port: u16) -> String {
    let host = if is_wildcard_host(host) {
        "127.0.0.1".to_string()
    } else {
        host.trim_matches(['[', ']']).to_string()
    };
    format_http_url(&host, port)
}

fn format_http_url(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

fn is_wildcard_host(host: &str) -> bool {
    matches!(host, "*" | "0.0.0.0" | "::" | "[::]" | "[::0]")
}

fn host_from_listen_address(local_address: &str) -> String {
    let host = if let Some(rest) = local_address.strip_prefix('[') {
        rest.split_once(']')
            .map(|(inside, _)| inside.to_string())
            .unwrap_or_else(|| local_address.to_string())
    } else if let Some((host, _)) = local_address.rsplit_once(':') {
        host.to_string()
    } else {
        local_address.to_string()
    };

    if is_wildcard_host(&host) {
        "127.0.0.1".to_string()
    } else {
        host
    }
}

fn is_session_kind(kind: Option<&str>) -> bool {
    kind.is_some_and(|k| k.eq_ignore_ascii_case("session"))
}

pub fn assemble_run_environments(
    live: &[LiveCommandTerminal],
    persisted: &[PersistedCommandTerminal],
    listening: &[TerminalPortInfo],
    worktrees: &[WorktreeRef],
    projects: &[ProjectRef],
    active_session_ids: &HashMap<String, String>,
    configured_ports: &HashMap<String, Vec<PortEntry>>,
    filter: &RunEnvironmentFilter,
) -> RunEnvironmentsResult {
    let worktrees_by_path: HashMap<String, &WorktreeRef> = worktrees
        .iter()
        .map(|w| (normalize_path(&w.path), w))
        .collect();
    let worktrees_by_id: HashMap<&str, &WorktreeRef> =
        worktrees.iter().map(|w| (w.id.as_str(), w)).collect();
    let projects_by_id: HashMap<&str, &ProjectRef> =
        projects.iter().map(|p| (p.id.as_str(), p)).collect();

    let persisted_by_terminal: HashMap<&str, &PersistedCommandTerminal> = persisted
        .iter()
        .filter(|t| !is_session_kind(t.kind.as_deref()) && !t.command.trim().is_empty())
        .map(|t| (t.terminal_id.as_str(), t))
        .collect();

    let mut environments = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for term in live {
        if term.command.trim().is_empty() || term.session_id.is_some() {
            continue;
        }
        if !seen.insert(term.terminal_id.clone()) {
            continue;
        }
        let persisted = persisted_by_terminal
            .get(term.terminal_id.as_str())
            .copied();
        if let Some(env) = build_environment(
            true,
            &term.terminal_id,
            &term.worktree_path,
            &term.command,
            term.command_args.clone(),
            term.session_id.clone(),
            persisted,
            listening,
            &worktrees_by_path,
            &worktrees_by_id,
            &projects_by_id,
            active_session_ids,
            configured_ports,
            filter,
        ) {
            environments.push(env);
        }
    }

    for term in persisted {
        if is_session_kind(term.kind.as_deref()) || term.command.trim().is_empty() {
            continue;
        }
        if !seen.insert(term.terminal_id.clone()) {
            continue;
        }
        let path = worktrees_by_id
            .get(term.worktree_id.as_str())
            .map(|w| w.path.clone())
            .unwrap_or_default();
        if let Some(env) = build_environment(
            false,
            &term.terminal_id,
            &path,
            &term.command,
            term.command_args.clone(),
            term.session_id.clone(),
            Some(term),
            listening,
            &worktrees_by_path,
            &worktrees_by_id,
            &projects_by_id,
            active_session_ids,
            configured_ports,
            filter,
        ) {
            environments.push(env);
        }
    }

    environments.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| a.worktree_name.cmp(&b.worktree_name))
            .then_with(|| a.command.cmp(&b.command))
    });

    RunEnvironmentsResult { environments }
}

fn build_environment(
    running: bool,
    terminal_id: &str,
    worktree_path: &str,
    command: &str,
    command_args: Option<Vec<String>>,
    live_session_id: Option<String>,
    persisted: Option<&PersistedCommandTerminal>,
    listening: &[TerminalPortInfo],
    worktrees_by_path: &HashMap<String, &WorktreeRef>,
    worktrees_by_id: &HashMap<&str, &WorktreeRef>,
    projects_by_id: &HashMap<&str, &ProjectRef>,
    active_session_ids: &HashMap<String, String>,
    configured_ports: &HashMap<String, Vec<PortEntry>>,
    filter: &RunEnvironmentFilter,
) -> Option<RunEnvironment> {
    let worktree = persisted
        .and_then(|p| worktrees_by_id.get(p.worktree_id.as_str()).copied())
        .or_else(|| {
            worktrees_by_path
                .get(&normalize_path(worktree_path))
                .copied()
        });

    if let Some(filter_id) = filter.worktree_id.as_deref() {
        match worktree {
            Some(w) if w.id == filter_id => {}
            _ => return None,
        }
    }
    if let Some(filter_id) = filter.project_id.as_deref() {
        match worktree {
            Some(w) if w.project_id == filter_id => {}
            _ => return None,
        }
    }

    let project = worktree.and_then(|w| projects_by_id.get(w.project_id.as_str()).copied());
    let worktree_id = worktree.map(|w| w.id.clone());
    let session_id = live_session_id
        .or_else(|| persisted.and_then(|p| p.session_id.clone()))
        .or_else(|| {
            worktree_id
                .as_deref()
                .and_then(|id| active_session_ids.get(id).cloned())
        });

    let mut ports = Vec::new();
    let mut seen_ports = std::collections::HashSet::new();
    for info in listening.iter().filter(|p| p.terminal_id == terminal_id) {
        if !seen_ports.insert(info.port) {
            continue;
        }
        let configured_host = worktree.and_then(|w| {
            configured_ports
                .get(&w.id)
                .into_iter()
                .flatten()
                .find(|entry| entry.port == info.port)
                .and_then(|entry| entry.host.as_deref())
        });
        let url = if let Some(host) = configured_host {
            url_from_host_and_port(host, info.port)
        } else {
            url_from_listen_address(&info.local_address, info.port)
        };
        ports.push(RunEnvironmentPort {
            port: info.port,
            process_name: Some(info.process_name.clone()),
            local_address: Some(info.local_address.clone()),
            url,
            source: "listening",
        });
    }

    if running {
        if let Some(w) = worktree {
            if let Some(configured) = configured_ports.get(&w.id) {
                for entry in configured {
                    if !seen_ports.insert(entry.port) {
                        continue;
                    }
                    let host = entry.host.as_deref().unwrap_or("127.0.0.1");
                    ports.push(RunEnvironmentPort {
                        port: entry.port,
                        process_name: None,
                        local_address: None,
                        url: url_from_host_and_port(host, entry.port),
                        source: "configured",
                    });
                }
            }
        }
    }

    let url = ports
        .iter()
        .find(|p| p.source == "listening")
        .or_else(|| ports.first())
        .map(|p| p.url.clone());

    Some(RunEnvironment {
        running,
        terminal_id: terminal_id.to_string(),
        worktree_id,
        worktree_name: worktree.map(|w| w.name.clone()),
        worktree_path: worktree
            .map(|w| w.path.clone())
            .unwrap_or_else(|| worktree_path.to_string()),
        is_base_session: worktree.is_some_and(|w| w.is_base),
        project_id: worktree.map(|w| w.project_id.clone()),
        project_name: project.map(|p| p.name.clone()),
        session_id,
        command: command.to_string(),
        command_args,
        ports,
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worktree_base() -> WorktreeRef {
        WorktreeRef {
            id: "wt-base".into(),
            name: "jean".into(),
            path: "/repos/jean".into(),
            project_id: "proj-1".into(),
            is_base: true,
        }
    }

    fn worktree_feature() -> WorktreeRef {
        WorktreeRef {
            id: "wt-feat".into(),
            name: "fuzzy-tiger".into(),
            path: "/jean/jean/fuzzy-tiger".into(),
            project_id: "proj-1".into(),
            is_base: false,
        }
    }

    fn project() -> ProjectRef {
        ProjectRef {
            id: "proj-1".into(),
            name: "jean".into(),
        }
    }

    fn live(id: &str, path: &str, command: &str) -> LiveCommandTerminal {
        LiveCommandTerminal {
            terminal_id: id.into(),
            worktree_path: path.into(),
            command: command.into(),
            command_args: None,
            session_id: None,
        }
    }

    #[test]
    fn url_from_wildcard_listen_address_uses_localhost() {
        assert_eq!(
            url_from_listen_address("*:5173", 5173),
            "http://127.0.0.1:5173"
        );
        assert_eq!(
            url_from_listen_address("0.0.0.0:3000", 3000),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            url_from_listen_address("[::]:8080", 8080),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn url_from_specific_listen_address_preserves_host() {
        assert_eq!(
            url_from_listen_address("127.0.0.1:1420", 1420),
            "http://127.0.0.1:1420"
        );
        assert_eq!(
            url_from_listen_address("[::1]:3000", 3000),
            "http://[::1]:3000"
        );
    }

    #[test]
    fn live_run_terminal_reports_worktree_port_and_url() {
        let result = assemble_run_environments(
            &[live("term-1", "/jean/jean/fuzzy-tiger/", "bun run dev")],
            &[],
            &[TerminalPortInfo {
                terminal_id: "term-1".into(),
                port: 5173,
                process_name: "bun".into(),
                local_address: "127.0.0.1:5173".into(),
            }],
            &[worktree_base(), worktree_feature()],
            &[project()],
            &HashMap::from([("wt-feat".into(), "sess-active".into())]),
            &HashMap::new(),
            &RunEnvironmentFilter::default(),
        );

        assert_eq!(result.environments.len(), 1);
        let env = &result.environments[0];
        assert!(env.running);
        assert_eq!(env.worktree_id.as_deref(), Some("wt-feat"));
        assert_eq!(env.worktree_name.as_deref(), Some("fuzzy-tiger"));
        assert!(!env.is_base_session);
        assert_eq!(env.project_id.as_deref(), Some("proj-1"));
        assert_eq!(env.project_name.as_deref(), Some("jean"));
        assert_eq!(env.session_id.as_deref(), Some("sess-active"));
        assert_eq!(env.command, "bun run dev");
        assert_eq!(env.ports.len(), 1);
        assert_eq!(env.ports[0].port, 5173);
        assert_eq!(env.ports[0].source, "listening");
        assert_eq!(env.url.as_deref(), Some("http://127.0.0.1:5173"));
    }

    #[test]
    fn base_session_worktree_is_flagged() {
        let result = assemble_run_environments(
            &[live("term-base", "/repos/jean", "npm start")],
            &[],
            &[],
            &[worktree_base(), worktree_feature()],
            &[project()],
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter::default(),
        );

        assert_eq!(result.environments.len(), 1);
        assert!(result.environments[0].is_base_session);
        assert_eq!(
            result.environments[0].worktree_id.as_deref(),
            Some("wt-base")
        );
    }

    #[test]
    fn session_cli_terminals_are_excluded() {
        let mut live_cli = live("term-cli", "/repos/jean", "/bin/claude");
        live_cli.session_id = Some("sess-1".into());
        let persisted = PersistedCommandTerminal {
            worktree_id: "wt-base".into(),
            terminal_id: "term-cli-persisted".into(),
            command: "/bin/codex".into(),
            command_args: None,
            session_id: Some("sess-2".into()),
            kind: Some("session".into()),
        };

        let result = assemble_run_environments(
            &[live_cli],
            &[persisted],
            &[],
            &[worktree_base()],
            &[project()],
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter::default(),
        );

        assert!(result.environments.is_empty());
    }

    #[test]
    fn persisted_stopped_run_terminal_is_not_running() {
        let persisted = PersistedCommandTerminal {
            worktree_id: "wt-feat".into(),
            terminal_id: "term-stopped".into(),
            command: "bun run dev".into(),
            command_args: None,
            session_id: None,
            kind: Some("panel".into()),
        };

        let result = assemble_run_environments(
            &[],
            &[persisted],
            &[],
            &[worktree_feature()],
            &[project()],
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter::default(),
        );

        assert_eq!(result.environments.len(), 1);
        assert!(!result.environments[0].running);
        assert_eq!(result.environments[0].command, "bun run dev");
        assert_eq!(
            result.environments[0].worktree_id.as_deref(),
            Some("wt-feat")
        );
        assert!(result.environments[0].url.is_none());
    }

    #[test]
    fn filters_by_worktree_and_project() {
        let live_terms = [
            live("term-a", "/repos/jean", "npm start"),
            live("term-b", "/jean/jean/fuzzy-tiger", "bun run dev"),
        ];
        let worktrees = [worktree_base(), worktree_feature()];
        let projects = [project()];

        let by_worktree = assemble_run_environments(
            &live_terms,
            &[],
            &[],
            &worktrees,
            &projects,
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter {
                worktree_id: Some("wt-feat".into()),
                project_id: None,
            },
        );
        assert_eq!(by_worktree.environments.len(), 1);
        assert_eq!(by_worktree.environments[0].terminal_id, "term-b");

        let by_project = assemble_run_environments(
            &live_terms,
            &[],
            &[],
            &worktrees,
            &projects,
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter {
                worktree_id: None,
                project_id: Some("proj-1".into()),
            },
        );
        assert_eq!(by_project.environments.len(), 2);

        let other_project = assemble_run_environments(
            &live_terms,
            &[],
            &[],
            &worktrees,
            &projects,
            &HashMap::new(),
            &HashMap::new(),
            &RunEnvironmentFilter {
                worktree_id: None,
                project_id: Some("proj-missing".into()),
            },
        );
        assert!(other_project.environments.is_empty());
    }

    #[test]
    fn configured_host_overrides_listen_url() {
        let configured = HashMap::from([(
            "wt-feat".to_string(),
            vec![PortEntry {
                port: 5173,
                label: "vite".into(),
                host: Some("localhost".into()),
            }],
        )]);

        let result = assemble_run_environments(
            &[live("term-1", "/jean/jean/fuzzy-tiger", "bun run dev")],
            &[],
            &[TerminalPortInfo {
                terminal_id: "term-1".into(),
                port: 5173,
                process_name: "node".into(),
                local_address: "*:5173".into(),
            }],
            &[worktree_feature()],
            &[project()],
            &HashMap::new(),
            &configured,
            &RunEnvironmentFilter::default(),
        );

        assert_eq!(
            result.environments[0].url.as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(result.environments[0].ports[0].source, "listening");
    }
}

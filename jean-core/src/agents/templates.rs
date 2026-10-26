//! Repo-shipped agent templates (`templates.yaml`).
//!
//! The catalog is the source of truth. It is not stored in `agents.db` and it
//! is not seeded on startup. Installing one calls the same create path as
//! `create_agent` and stores a normal custom agent (`builtin` stays false).
//! Only the seeded `jean` agent is built-in.
//!
//! Skill hints are short names for the user to attach later. They are not
//! file paths and they are not written onto the agent. Default schedules are
//! real schedules. Install leaves `mcp_servers` and `jean_tools` unset, so
//! Jean MCP stays available.

use std::collections::HashSet;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::db::{self, Agent};
use super::self_manage::{self, CreateInput, InitialSchedule};

const MAX_SKILL_HINTS: usize = 16;
const MAX_SKILL_HINT_CHARS: usize = 80;
const MAX_TEMPLATE_SCHEDULES: usize = 10;
const SEEDED_IDS: &[&str] = &[
    "support-triage",
    "seo-aeo",
    "ai-search-visibility",
    "competitor-watch",
    "billing-disputes",
    "feature-requests",
    "docs-auditor",
    "release-notes",
];

/// One predefined role the user can install as a custom agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub role_prompt: String,
    /// Names of skills the user may attach. Not file paths.
    #[serde(default)]
    pub skill_hints: Vec<String>,
    #[serde(default)]
    pub schedules: Vec<TemplateSchedule>,
}

/// A schedule copied onto the agent at install time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSchedule {
    pub name: String,
    pub prompt: String,
    /// `cron`, `interval`, or `event`.
    pub kind: String,
    #[serde(default)]
    pub every_secs: Option<i64>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
}

/// Load the in-repo catalog.
pub fn load_templates() -> Result<Vec<AgentTemplate>, String> {
    parse_catalog(include_str!("templates.yaml"))
}

pub(crate) fn parse_catalog(raw: &str) -> Result<Vec<AgentTemplate>, String> {
    let parsed: Vec<AgentTemplate> =
        serde_yaml::from_str(raw).map_err(|e| format!("Agent template catalog is invalid: {e}"))?;
    normalize_catalog(parsed)
}

fn normalize_catalog(parsed: Vec<AgentTemplate>) -> Result<Vec<AgentTemplate>, String> {
    if parsed.is_empty() {
        return Err("Agent template catalog is empty".to_string());
    }
    let mut seen = HashSet::new();
    let mut templates = Vec::with_capacity(parsed.len());
    for template in parsed {
        templates.push(normalize_template(template, &mut seen)?);
    }
    for id in SEEDED_IDS {
        if !seen.contains(*id) {
            return Err(format!("Agent template catalog is missing '{id}'"));
        }
    }
    Ok(templates)
}

fn normalize_template(
    template: AgentTemplate,
    seen: &mut HashSet<String>,
) -> Result<AgentTemplate, String> {
    let id = template.id.trim().to_string();
    if !valid_template_id(&id) {
        return Err(format!(
            "Agent template id '{id}' must be a lowercase slug other than jean"
        ));
    }
    if !seen.insert(id.clone()) {
        return Err(format!("Duplicate agent template id '{id}'"));
    }
    let name = template.name.trim().to_string();
    if name.is_empty() {
        return Err(format!("Agent template '{id}' needs a name"));
    }
    let description = template.description.trim().to_string();
    if description.is_empty() {
        return Err(format!("Agent template '{id}' needs a description"));
    }
    let role_prompt = template.role_prompt.trim().to_string();
    if role_prompt.is_empty() {
        return Err(format!("Agent template '{id}' needs a role prompt"));
    }
    // Custom agents cannot take the coordinator color.
    let icon = self_manage::normalize_icon(&template.icon, false)
        .map_err(|e| format!("Agent template '{id}': {e}"))?;
    if template.schedules.len() > MAX_TEMPLATE_SCHEDULES {
        return Err(format!(
            "Agent template '{id}' has more than {MAX_TEMPLATE_SCHEDULES} schedules"
        ));
    }
    let now = db::now();
    let mut schedules = Vec::with_capacity(template.schedules.len());
    for schedule in template.schedules {
        let name = schedule.name.trim().to_string();
        let prompt = schedule.prompt.trim().to_string();
        if name.is_empty() || prompt.is_empty() {
            return Err(format!(
                "Agent template '{id}' has a schedule with an empty name or prompt"
            ));
        }
        // Validate now so a bad cron fails at load, before anyone installs it.
        schedule_timing(&schedule, now)?;
        schedules.push(TemplateSchedule {
            name,
            prompt,
            kind: schedule.kind.trim().to_string(),
            every_secs: schedule.every_secs,
            cron: schedule.cron.as_ref().map(|cron| cron.trim().to_string()),
            timezone: schedule
                .timezone
                .as_ref()
                .map(|timezone| timezone.trim().to_string()),
            event: schedule
                .event
                .as_ref()
                .map(|event| event.trim().to_string()),
        });
    }
    Ok(AgentTemplate {
        id,
        name,
        description,
        icon,
        role_prompt,
        skill_hints: normalize_skill_hints(&template.skill_hints)?,
        schedules,
    })
}

fn valid_template_id(id: &str) -> bool {
    if id.is_empty() || id == "jean" || id.len() > 40 || id.starts_with('-') || id.ends_with('-') {
        return false;
    }
    let mut prev_hyphen = false;
    for c in id.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_hyphen = false;
        } else if c == '-' && !prev_hyphen {
            prev_hyphen = true;
        } else {
            return false;
        }
    }
    !prev_hyphen
}

fn normalize_skill_hints(hints: &[String]) -> Result<Vec<String>, String> {
    if hints.len() > MAX_SKILL_HINTS {
        return Err(format!("At most {MAX_SKILL_HINTS} skill hints"));
    }
    let mut out = Vec::new();
    for hint in hints {
        let hint = hint.trim();
        if hint.is_empty() {
            continue;
        }
        if hint.chars().count() > MAX_SKILL_HINT_CHARS
            || hint.contains('/')
            || hint.contains('\\')
            || hint.contains("..")
        {
            return Err(format!(
                "Skill hint '{hint}' must be a short name, not a file path"
            ));
        }
        out.push(hint.to_string());
    }
    Ok(out)
}

fn schedule_timing(schedule: &TemplateSchedule, now: i64) -> Result<db::ScheduleTiming, String> {
    let label = schedule.name.trim();
    let label = if label.is_empty() {
        "template schedule"
    } else {
        label
    };
    let kind = schedule.kind.trim();
    let timing = match kind {
        "cron" => db::validate_schedule_timing(
            None,
            schedule.cron.as_deref(),
            schedule.timezone.as_deref(),
            None,
            None,
            now,
        ),
        "interval" => {
            db::validate_schedule_timing(schedule.every_secs, None, None, None, None, now)
        }
        "event" => {
            db::validate_schedule_timing(None, None, None, schedule.event.as_deref(), None, now)
        }
        _ => Err("kind must be cron, interval, or event".to_string()),
    };
    timing.map_err(|e| format!("Schedule '{label}': {e}"))
}

/// Create a non-builtin agent from a catalog template.
///
/// Uses [`self_manage::create_for_actor`] with no actor, the same path as
/// `create_agent`. `mcp_servers` and `jean_tools` stay unset.
pub fn install_template(conn: &mut Connection, template_id: &str) -> Result<Agent, String> {
    let template_id = template_id.trim();
    let template = load_templates()?
        .into_iter()
        .find(|template| template.id == template_id)
        .ok_or_else(|| format!("Unknown agent template: {template_id}"))?;
    let now = db::now();
    let mut schedules = Vec::with_capacity(template.schedules.len());
    for schedule in &template.schedules {
        schedules.push(InitialSchedule {
            name: schedule.name.clone(),
            prompt: schedule.prompt.clone(),
            timing: schedule_timing(schedule, now)?,
        });
    }
    let agent = self_manage::create_for_actor(
        conn,
        None,
        None,
        &CreateInput {
            name: template.name,
            description: template.description,
            icon: template.icon,
            role_prompt: template.role_prompt,
            // Defaults only. A template must not turn Jean MCP off.
            config: db::AgentRunConfig::default(),
            schedules,
        },
    )?;
    if agent.builtin || agent.id == db::JEAN_AGENT_ID {
        return Err("Template install created a built-in agent".to_string());
    }
    Ok(agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        conn
    }

    #[test]
    fn catalog_loads_and_install_creates_editable_custom_agent() {
        let templates = load_templates().unwrap();
        let ids: Vec<&str> = templates
            .iter()
            .map(|template| template.id.as_str())
            .collect();
        for id in SEEDED_IDS {
            assert!(ids.contains(id), "missing {id}");
        }
        assert_eq!(ids.len(), ids.iter().collect::<HashSet<_>>().len());
        let support = templates
            .iter()
            .find(|template| template.id == "support-triage")
            .unwrap();
        assert_eq!(support.icon, "blue");
        assert!(support
            .skill_hints
            .iter()
            .any(|hint| hint == "github-issues"));
        assert!(support
            .schedules
            .iter()
            .any(|schedule| schedule.kind == "cron"));
        assert!(support.role_prompt.contains("Jean MCP is on"));

        let mut conn = memory_db();
        let jean_before = db::get_agent(&conn, db::JEAN_AGENT_ID).unwrap().unwrap();
        assert!(jean_before.builtin);

        let agent = install_template(&mut conn, "support-triage").unwrap();
        assert!(!agent.builtin);
        assert_eq!(agent.name, "Support triage");
        assert_eq!(agent.id, "support-triage");
        assert_ne!(agent.id, db::JEAN_AGENT_ID);
        assert!(agent.skills.is_empty());
        assert!(agent.mcp_servers.is_none());
        assert!(agent.jean_tools.is_none());
        assert!(agent.role_prompt.contains("support triage"));

        let schedules = db::list_schedules(&conn, &agent.id).unwrap();
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0].name, "Morning support sweep");
        assert_eq!(schedules[0].cron.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(schedules[0].timezone.as_deref(), Some("UTC"));

        let updated = db::update_agent(
            &conn,
            &agent.id,
            &db::AgentPatch {
                role_prompt: Some("Edited after install".to_string()),
                ..db::AgentPatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.role_prompt, "Edited after install");
        assert!(!updated.builtin);

        let again = install_template(&mut conn, " support-triage ").unwrap();
        assert_eq!(again.id, "support-triage-2");
        assert!(!again.builtin);

        db::delete_agent(&conn, &agent.id).unwrap();
        db::delete_agent(&conn, &again.id).unwrap();
        assert!(db::get_agent(&conn, &agent.id).unwrap().is_none());

        let jean = db::get_agent(&conn, db::JEAN_AGENT_ID).unwrap().unwrap();
        assert!(jean.builtin);
        assert!(db::delete_agent(&conn, db::JEAN_AGENT_ID).is_err());
        let builtins = db::list_agents(&conn)
            .unwrap()
            .into_iter()
            .filter(|agent| agent.builtin)
            .map(|agent| agent.id)
            .collect::<Vec<_>>();
        assert_eq!(builtins, vec![db::JEAN_AGENT_ID.to_string()]);

        let before = db::count_user_agents(&conn).unwrap();
        let err = install_template(&mut conn, "not-a-template").unwrap_err();
        assert!(err.contains("not-a-template"));
        assert_eq!(db::count_user_agents(&conn).unwrap(), before);
    }

    #[test]
    fn catalog_rejects_reserved_ids_coordinator_color_and_path_hints() {
        let err = parse_catalog(
            r#"
- id: jean
  name: Jean
  description: Boss
  icon: blue
  rolePrompt: Hello
"#,
        )
        .unwrap_err();
        assert!(err.contains("jean"), "{err}");

        let err = parse_catalog(
            r#"
- id: support-triage
  name: One
  description: First
  icon: jean
  rolePrompt: Hello
"#,
        )
        .unwrap_err();
        assert!(err.contains("reserved") || err.contains("jean"), "{err}");

        let err = parse_catalog(
            r#"
- id: support-triage
  name: One
  description: First
  icon: blue
  rolePrompt: Hello
  skillHints:
    - /tmp/SKILL.md
"#,
        )
        .unwrap_err();
        assert!(err.contains("file path"), "{err}");
    }
}

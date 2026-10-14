//! SQLite storage for agents: definitions, delegations, wake events, schedules,
//! approvals and memory. All functions take a `&Connection` so they can be
//! unit-tested with an in-memory database.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Built-in coordinator agent. Its worktree ID predates the agents database.
pub const JEAN_AGENT_ID: &str = "jean";
pub const JEAN_AGENT_WORKTREE_ID: &str = "__jean_agent__";

/// Most memory entries one scope (an agent, or shared) can hold.
pub const MAX_MEMORIES_PER_SCOPE: i64 = 500;
pub const MAX_MEMORY_CHARS: usize = 1000;
/// Most active schedules one agent can hold.
pub const MAX_SCHEDULES_PER_AGENT: i64 = 50;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'yellow',
        role_prompt TEXT NOT NULL DEFAULT '',
        worktree_id TEXT NOT NULL UNIQUE,
        paused INTEGER NOT NULL DEFAULT 0,
        max_wakes_per_hour INTEGER NOT NULL DEFAULT 12,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE delegations (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        hop INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        last_event TEXT,
        last_error TEXT,
        last_summary TEXT,
        check_after INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(agent_id, session_id)
    );
    CREATE INDEX delegations_session ON delegations(session_id);
    CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        hop INTEGER NOT NULL DEFAULT 0,
        reply_to_agent TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
    );
    CREATE INDEX events_pending ON events(agent_id, delivered_at);
    CREATE TABLE wakes (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE schedules (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        every_secs INTEGER,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE approvals (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
    );
    CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        agent_id TEXT,
        project_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, content='memories', content_rowid='id'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    "#,
    // v2: tasks (background work in its own sessions), routing of updates,
    // user notifications, chat rotation carry-over.
    r#"
    ALTER TABLE delegations ADD COLUMN origin_session_id TEXT;
    ALTER TABLE events ADD COLUMN title TEXT;
    ALTER TABLE events ADD COLUMN target_session_id TEXT;
    ALTER TABLE events ADD COLUMN reply_to_session TEXT;
    ALTER TABLE approvals ADD COLUMN session_id TEXT;
    ALTER TABLE agents ADD COLUMN carry_over TEXT;
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        last_event TEXT,
        check_after INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
    );
    CREATE INDEX tasks_agent ON tasks(agent_id, status);
    CREATE TABLE notifications (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
    );
    CREATE INDEX notifications_unread ON notifications(agent_id, read_at);
    "#,
];

const JEAN_ROLE_PROMPT: &str = "You are Jean, the coordinator agent of the Jean app. You are the boss of all the user's projects.
- Delegate coding work to sessions inside the correct project worktree. Do not edit project files directly.
- Follow up on delegated work when its update arrives: check the result, start the next step, or tell the user.
- Keep answers short and report what you did with project and worktree names.";

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Open (or create) the database, apply migrations and seed built-in agents.
pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open agents db: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to enable WAL: {e}"))?;
    init(&conn)?;
    Ok(conn)
}

/// Apply migrations and seed data (also used by tests with an in-memory db).
pub fn init(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read db version: {e}"))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(&format!(
            "BEGIN; {sql} PRAGMA user_version = {}; COMMIT;",
            index + 1
        ))
        .map_err(|e| format!("Agents db migration {} failed: {e}", index + 1))?;
    }
    let ts = now();
    conn.execute(
        "INSERT OR IGNORE INTO agents (id, name, description, icon, role_prompt, worktree_id, builtin, created_at, updated_at)
         VALUES (?1, 'Jean', 'The boss. Coordinates all your projects.', 'jean', ?2, ?3, 1, ?4, ?4)",
        params![JEAN_AGENT_ID, JEAN_ROLE_PROMPT, JEAN_AGENT_WORKTREE_ID, ts],
    )
    .map_err(|e| format!("Failed to seed Jean agent: {e}"))?;
    Ok(())
}

fn err(e: rusqlite::Error) -> String {
    format!("Agents db error: {e}")
}

// ============================================================================
// Agents
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub role_prompt: String,
    pub worktree_id: String,
    pub paused: bool,
    pub max_wakes_per_hour: i64,
    pub builtin: bool,
}

const AGENT_COLUMNS: &str =
    "id, name, description, icon, role_prompt, worktree_id, paused, max_wakes_per_hour, builtin";

fn agent_from_row(row: &rusqlite::Row) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        icon: row.get(3)?,
        role_prompt: row.get(4)?,
        worktree_id: row.get(5)?,
        paused: row.get::<_, i64>(6)? != 0,
        max_wakes_per_hour: row.get(7)?,
        builtin: row.get::<_, i64>(8)? != 0,
    })
}

pub fn list_agents(conn: &Connection) -> Result<Vec<Agent>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {AGENT_COLUMNS} FROM agents ORDER BY builtin DESC, created_at, id"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([], agent_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn get_agent(conn: &Connection, id: &str) -> Result<Option<Agent>, String> {
    conn.query_row(
        &format!("SELECT {AGENT_COLUMNS} FROM agents WHERE id = ?1"),
        [id],
        agent_from_row,
    )
    .optional()
    .map_err(err)
}

pub fn agent_by_worktree(conn: &Connection, worktree_id: &str) -> Result<Option<Agent>, String> {
    conn.query_row(
        &format!("SELECT {AGENT_COLUMNS} FROM agents WHERE worktree_id = ?1"),
        [worktree_id],
        agent_from_row,
    )
    .optional()
    .map_err(err)
}

/// Worktree ID for a new agent's sessions. Only `[a-z0-9-]` IDs are accepted,
/// so the ID survives session index file-name sanitizing unchanged.
pub fn agent_worktree_id(agent_id: &str) -> String {
    if agent_id == JEAN_AGENT_ID {
        JEAN_AGENT_WORKTREE_ID.to_string()
    } else {
        format!("__agent_{agent_id}__")
    }
}

/// Worktree ID of an agent's task sessions (background work), kept apart from
/// its chat sessions. Agent IDs never contain `_`, so it cannot clash with a
/// chat worktree ID.
pub fn agent_tasks_worktree_id(agent_id: &str) -> String {
    format!("__agent_tasks_{agent_id}__")
}

/// Agent ID of a task worktree ID.
pub fn agent_id_from_tasks_worktree(worktree_id: &str) -> Option<&str> {
    worktree_id
        .strip_prefix("__agent_tasks_")
        .and_then(|rest| rest.strip_suffix("__"))
        .filter(|id| !id.is_empty())
}

/// True for worktree IDs reserved for agent sessions (never real worktrees).
pub fn is_agent_worktree_id(worktree_id: &str) -> bool {
    worktree_id == JEAN_AGENT_WORKTREE_ID
        || (worktree_id.starts_with("__agent_") && worktree_id.ends_with("__"))
}

/// Lowercase slug from a display name: "Release Manager" -> "release-manager".
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').chars().take(40).collect()
}

pub fn create_agent(
    conn: &Connection,
    name: &str,
    description: &str,
    icon: &str,
    role_prompt: &str,
) -> Result<Agent, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Agent name cannot be empty".to_string());
    }
    let base = slugify(name);
    if base.is_empty() {
        return Err("Agent name needs at least one letter or digit".to_string());
    }
    let mut id = base.clone();
    let mut n = 2;
    while get_agent(conn, &id)?.is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let ts = now();
    conn.execute(
        "INSERT INTO agents (id, name, description, icon, role_prompt, worktree_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, name, description.trim(), icon, role_prompt.trim(), agent_worktree_id(&id), ts],
    )
    .map_err(err)?;
    get_agent(conn, &id)?.ok_or_else(|| "Agent was not created".to_string())
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub role_prompt: Option<String>,
    pub paused: Option<bool>,
    pub max_wakes_per_hour: Option<i64>,
}

pub fn update_agent(conn: &Connection, id: &str, patch: &AgentPatch) -> Result<Agent, String> {
    let mut agent = get_agent(conn, id)?.ok_or_else(|| format!("Agent not found: {id}"))?;
    if let Some(name) = patch.name.as_deref().map(str::trim) {
        if name.is_empty() {
            return Err("Agent name cannot be empty".to_string());
        }
        agent.name = name.to_string();
    }
    if let Some(v) = &patch.description {
        agent.description = v.trim().to_string();
    }
    if let Some(v) = &patch.icon {
        agent.icon = v.clone();
    }
    if let Some(v) = &patch.role_prompt {
        agent.role_prompt = v.trim().to_string();
    }
    if let Some(v) = patch.paused {
        agent.paused = v;
    }
    if let Some(v) = patch.max_wakes_per_hour {
        agent.max_wakes_per_hour = v.clamp(1, 120);
    }
    conn.execute(
        "UPDATE agents SET name=?2, description=?3, icon=?4, role_prompt=?5, paused=?6,
         max_wakes_per_hour=?7, updated_at=?8 WHERE id=?1",
        params![
            id,
            agent.name,
            agent.description,
            agent.icon,
            agent.role_prompt,
            agent.paused as i64,
            agent.max_wakes_per_hour,
            now()
        ],
    )
    .map_err(err)?;
    Ok(agent)
}

pub fn delete_agent(conn: &Connection, id: &str) -> Result<(), String> {
    let agent = get_agent(conn, id)?.ok_or_else(|| format!("Agent not found: {id}"))?;
    if agent.builtin {
        return Err("Built-in agents cannot be deleted".to_string());
    }
    conn.execute("DELETE FROM memories WHERE agent_id = ?1", [id])
        .map_err(err)?;
    conn.execute("DELETE FROM agents WHERE id = ?1", [id])
        .map_err(err)?;
    Ok(())
}

// ============================================================================
// Delegations
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub id: i64,
    pub agent_id: String,
    pub session_id: String,
    pub worktree_id: String,
    pub hop: i64,
    pub status: String,
    pub last_event: Option<String>,
    pub last_error: Option<String>,
    pub last_summary: Option<String>,
    pub check_after: Option<i64>,
    pub updated_at: i64,
    /// Session that sent the work; its follow-up goes back there.
    pub origin_session_id: Option<String>,
}

const DELEGATION_COLUMNS: &str = "id, agent_id, session_id, worktree_id, hop, status, last_event, last_error, last_summary, check_after, updated_at, origin_session_id";

fn delegation_from_row(row: &rusqlite::Row) -> rusqlite::Result<Delegation> {
    Ok(Delegation {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        session_id: row.get(2)?,
        worktree_id: row.get(3)?,
        hop: row.get(4)?,
        status: row.get(5)?,
        last_event: row.get(6)?,
        last_error: row.get(7)?,
        last_summary: row.get(8)?,
        check_after: row.get(9)?,
        updated_at: row.get(10)?,
        origin_session_id: row.get(11)?,
    })
}

/// Record (or re-activate) "this session works for this agent".
pub fn upsert_delegation(
    conn: &Connection,
    agent_id: &str,
    session_id: &str,
    worktree_id: &str,
    hop: i64,
    origin_session_id: Option<&str>,
) -> Result<(), String> {
    let ts = now();
    conn.execute(
        "INSERT INTO delegations (agent_id, session_id, worktree_id, hop, status, origin_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?6)
         ON CONFLICT(agent_id, session_id) DO UPDATE SET
            status='active', hop=excluded.hop, worktree_id=excluded.worktree_id,
            origin_session_id=excluded.origin_session_id,
            last_event=NULL, last_error=NULL, check_after=NULL, updated_at=excluded.updated_at",
        params![agent_id, session_id, worktree_id, hop, origin_session_id, ts],
    )
    .map_err(err)?;
    Ok(())
}

/// A run in `session_id` ended (`done` | `error` | `cancelled`). Queue a check
/// for every active delegation of this session. Returns how many were marked.
pub fn mark_delegation_run_ended(
    conn: &Connection,
    session_id: &str,
    event: &str,
    error: Option<&str>,
    check_after: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE delegations SET last_event=?2, last_error=?3, check_after=?4, updated_at=?5
         WHERE session_id=?1 AND status IN ('active', 'waiting')",
        params![session_id, event, error, check_after, now()],
    )
    .map_err(err)
}

pub fn due_delegation_checks(conn: &Connection, at: i64) -> Result<Vec<Delegation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {DELEGATION_COLUMNS} FROM delegations
             WHERE status IN ('active', 'waiting') AND check_after IS NOT NULL AND check_after <= ?1
             ORDER BY check_after"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([at], delegation_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn defer_delegation_check(
    conn: &Connection,
    id: i64,
    check_after: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE delegations SET check_after=?2 WHERE id=?1",
        params![id, check_after],
    )
    .map_err(err)?;
    Ok(())
}

pub fn finish_delegation(
    conn: &Connection,
    id: i64,
    status: &str,
    summary: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE delegations SET status=?2, last_summary=?3, check_after=NULL, updated_at=?4 WHERE id=?1",
        params![id, status, summary, now()],
    )
    .map_err(err)?;
    Ok(())
}

/// Active delegations without a queued check (used once at startup, so runs
/// that ended while Jean was closed are still reported).
pub fn requeue_active_delegations(conn: &Connection, check_after: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE delegations SET check_after=?1 WHERE status='active' AND check_after IS NULL",
        [check_after],
    )
    .map_err(err)
}

/// Hop of the active delegation that made `session_id` work for another agent.
pub fn active_hop_for_session(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(hop), 0) FROM delegations WHERE session_id=?1 AND status IN ('active', 'waiting')",
        [session_id],
        |row| row.get(0),
    )
    .map_err(err)
}

pub fn list_delegations(
    conn: &Connection,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Delegation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {DELEGATION_COLUMNS} FROM delegations WHERE agent_id=?1 ORDER BY updated_at DESC, id DESC LIMIT ?2"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(params![agent_id, limit], delegation_from_row)
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// ============================================================================
// Events and wakes
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: i64,
    pub agent_id: String,
    pub kind: String,
    pub body: String,
    pub hop: i64,
    pub reply_to_agent: Option<String>,
    pub created_at: i64,
    /// Title of the task session made for this event.
    pub title: Option<String>,
    /// Session that gets this update. `None` = a new task session.
    pub target_session_id: Option<String>,
    /// Session of `reply_to_agent` that waits for the answer.
    pub reply_to_session: Option<String>,
}

/// A queued update for an agent.
#[derive(Debug, Clone, Default)]
pub struct NewEvent<'a> {
    pub agent_id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub hop: i64,
    pub target_session_id: Option<&'a str>,
    pub reply_to_agent: Option<&'a str>,
    pub reply_to_session: Option<&'a str>,
}

pub fn add_event(conn: &Connection, e: &NewEvent) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO events (agent_id, kind, title, body, hop, target_session_id, reply_to_agent, reply_to_session, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            e.agent_id,
            e.kind,
            e.title,
            e.body,
            e.hop,
            e.target_session_id,
            e.reply_to_agent,
            e.reply_to_session,
            now()
        ],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn pending_events(conn: &Connection, agent_id: &str) -> Result<Vec<AgentEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, agent_id, kind, body, hop, reply_to_agent, created_at, title, target_session_id, reply_to_session
             FROM events WHERE agent_id=?1 AND delivered_at IS NULL ORDER BY id LIMIT 50",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map([agent_id], |row| {
            Ok(AgentEvent {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                kind: row.get(2)?,
                body: row.get(3)?,
                hop: row.get(4)?,
                reply_to_agent: row.get(5)?,
                created_at: row.get(6)?,
                title: row.get(7)?,
                target_session_id: row.get(8)?,
                reply_to_session: row.get(9)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn agents_with_pending_events(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT agent_id FROM events WHERE delivered_at IS NULL")
        .map_err(err)?;
    let rows = stmt.query_map([], |row| row.get(0)).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn pending_event_count(conn: &Connection, agent_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM events WHERE agent_id=?1 AND delivered_at IS NULL",
        [agent_id],
        |row| row.get(0),
    )
    .map_err(err)
}

pub fn mark_events_delivered(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    let ts = now();
    for id in ids {
        conn.execute(
            "UPDATE events SET delivered_at=?2 WHERE id=?1",
            params![id, ts],
        )
        .map_err(err)?;
    }
    Ok(())
}

pub fn record_wake(conn: &Connection, agent_id: &str, session_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO wakes (agent_id, session_id, created_at) VALUES (?1, ?2, ?3)",
        params![agent_id, session_id, now()],
    )
    .map_err(err)?;
    Ok(())
}

pub fn wakes_since(conn: &Connection, agent_id: &str, since: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM wakes WHERE agent_id=?1 AND created_at >= ?2",
        params![agent_id, since],
        |row| row.get(0),
    )
    .map_err(err)
}

// ============================================================================
// Schedules
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: i64,
    pub agent_id: String,
    pub name: String,
    pub prompt: String,
    pub every_secs: Option<i64>,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
}

const SCHEDULE_COLUMNS: &str = "id, agent_id, name, prompt, every_secs, next_run_at, last_run_at";

fn schedule_from_row(row: &rusqlite::Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        every_secs: row.get(4)?,
        next_run_at: row.get(5)?,
        last_run_at: row.get(6)?,
    })
}

pub fn create_schedule(
    conn: &Connection,
    agent_id: &str,
    name: &str,
    prompt: &str,
    first_run_at: i64,
    every_secs: Option<i64>,
) -> Result<Schedule, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schedules WHERE agent_id=?1 AND active=1",
            [agent_id],
            |row| row.get(0),
        )
        .map_err(err)?;
    if count >= MAX_SCHEDULES_PER_AGENT {
        return Err(format!(
            "Too many active schedules ({MAX_SCHEDULES_PER_AGENT}). Cancel one first."
        ));
    }
    conn.execute(
        "INSERT INTO schedules (agent_id, name, prompt, every_secs, next_run_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![agent_id, name, prompt, every_secs, first_run_at, now()],
    )
    .map_err(err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        &format!("SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE id=?1"),
        [id],
        schedule_from_row,
    )
    .map_err(err)
}

pub fn list_schedules(conn: &Connection, agent_id: &str) -> Result<Vec<Schedule>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE agent_id=?1 AND active=1 ORDER BY next_run_at"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([agent_id], schedule_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// Returns false when no active schedule of this agent has that ID.
pub fn cancel_schedule(conn: &Connection, agent_id: &str, id: i64) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE schedules SET active=0 WHERE id=?1 AND agent_id=?2 AND active=1",
            params![id, agent_id],
        )
        .map_err(err)?;
    Ok(changed > 0)
}

/// Fire due schedules of agents that are not paused: add one event each, then
/// move repeating schedules to their next time and end one-shot schedules.
/// Missed runs (Jean closed) fire once, not once per missed interval.
pub fn fire_due_schedules(conn: &Connection, at: i64) -> Result<Vec<Schedule>, String> {
    let due: Vec<Schedule> = {
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.agent_id, s.name, s.prompt, s.every_secs, s.next_run_at, s.last_run_at
                 FROM schedules s JOIN agents a ON a.id = s.agent_id
                 WHERE s.active=1 AND s.next_run_at <= ?1 AND a.paused=0",
            )
            .map_err(err)?;
        let rows = stmt.query_map([at], schedule_from_row).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    for schedule in &due {
        let body = format!(
            "Schedule #{} \"{}\" is due.\n\n{}",
            schedule.id, schedule.name, schedule.prompt
        );
        add_event(
            conn,
            &NewEvent {
                agent_id: &schedule.agent_id,
                kind: "schedule",
                title: &schedule.name,
                body: &body,
                ..Default::default()
            },
        )?;
        match schedule.every_secs {
            Some(every) if every > 0 => conn.execute(
                "UPDATE schedules SET last_run_at=?2, next_run_at=?3 WHERE id=?1",
                params![schedule.id, at, at + every],
            ),
            _ => conn.execute(
                "UPDATE schedules SET last_run_at=?2, active=0 WHERE id=?1",
                params![schedule.id, at],
            ),
        }
        .map_err(err)?;
    }
    Ok(due)
}

pub fn next_schedule_at(conn: &Connection, agent_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT MIN(next_run_at) FROM schedules WHERE agent_id=?1 AND active=1",
        [agent_id],
        |row| row.get(0),
    )
    .map_err(err)
}

// ============================================================================
// Approvals
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: i64,
    pub agent_id: String,
    /// Session that asked; the result goes back there.
    pub session_id: Option<String>,
    pub tool: String,
    pub args: Value,
    pub status: String,
    pub result: Option<String>,
    pub created_at: i64,
}

fn approval_from_row(row: &rusqlite::Row) -> rusqlite::Result<Approval> {
    let args: String = row.get(3)?;
    Ok(Approval {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        tool: row.get(2)?,
        args: serde_json::from_str(&args).unwrap_or(Value::Null),
        status: row.get(4)?,
        result: row.get(5)?,
        created_at: row.get(6)?,
        session_id: row.get(7)?,
    })
}

const APPROVAL_COLUMNS: &str = "id, agent_id, tool, args, status, result, created_at, session_id";

pub fn create_approval(
    conn: &Connection,
    agent_id: &str,
    session_id: Option<&str>,
    tool: &str,
    args: &Value,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO approvals (agent_id, session_id, tool, args, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
        params![agent_id, session_id, tool, args.to_string(), now()],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn get_approval(conn: &Connection, id: i64) -> Result<Option<Approval>, String> {
    conn.query_row(
        &format!("SELECT {APPROVAL_COLUMNS} FROM approvals WHERE id=?1"),
        [id],
        approval_from_row,
    )
    .optional()
    .map_err(err)
}

/// Move a pending approval to `status`. Returns false when it was already
/// decided (double click, second client), so the action runs only once.
pub fn decide_approval(conn: &Connection, id: i64, status: &str) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE approvals SET status=?2, decided_at=?3 WHERE id=?1 AND status='pending'",
            params![id, status, now()],
        )
        .map_err(err)?;
    Ok(changed > 0)
}

pub fn set_approval_result(
    conn: &Connection,
    id: i64,
    status: &str,
    result: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE approvals SET status=?2, result=?3 WHERE id=?1",
        params![id, status, result],
    )
    .map_err(err)?;
    Ok(())
}

pub fn list_approvals(
    conn: &Connection,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Approval>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {APPROVAL_COLUMNS} FROM approvals WHERE agent_id=?1
             ORDER BY (status='pending') DESC, id DESC LIMIT ?2"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(params![agent_id, limit], approval_from_row)
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn pending_approval_count(conn: &Connection, agent_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM approvals WHERE agent_id=?1 AND status='pending'",
        [agent_id],
        |row| row.get(0),
    )
    .map_err(err)
}

// ============================================================================
// Tasks (background work, one session each)
// ============================================================================

/// Most tasks of one agent that run at the same time.
pub const MAX_RUNNING_TASKS: i64 = 2;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub agent_id: String,
    pub session_id: String,
    pub title: String,
    /// schedule | delegation | message | approval
    pub kind: String,
    /// running | waiting (on delegated work) | done | failed | cancelled
    pub status: String,
    pub summary: Option<String>,
    pub last_event: Option<String>,
    pub check_after: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

const TASK_COLUMNS: &str = "id, agent_id, session_id, title, kind, status, summary, last_event, check_after, created_at, updated_at, archived_at";

fn task_from_row(row: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        session_id: row.get(2)?,
        title: row.get(3)?,
        kind: row.get(4)?,
        status: row.get(5)?,
        summary: row.get(6)?,
        last_event: row.get(7)?,
        check_after: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        archived_at: row.get(11)?,
    })
}

pub fn create_task(
    conn: &Connection,
    agent_id: &str,
    session_id: &str,
    title: &str,
    kind: &str,
) -> Result<Task, String> {
    let ts = now();
    conn.execute(
        "INSERT INTO tasks (agent_id, session_id, title, kind, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5)",
        params![agent_id, session_id, title, kind, ts],
    )
    .map_err(err)?;
    task_by_session(conn, session_id)?.ok_or_else(|| "Task was not created".to_string())
}

pub fn task_by_session(conn: &Connection, session_id: &str) -> Result<Option<Task>, String> {
    conn.query_row(
        &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE session_id=?1"),
        [session_id],
        task_from_row,
    )
    .optional()
    .map_err(err)
}

/// The task got new input (follow-up update): it runs again.
pub fn set_task_running(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status='running', last_event=NULL, check_after=NULL, updated_at=?2 WHERE session_id=?1",
        params![session_id, now()],
    )
    .map_err(err)?;
    Ok(())
}

/// A run of a task session ended: queue a check of its final state.
pub fn mark_task_run_ended(
    conn: &Connection,
    session_id: &str,
    event: &str,
    check_after: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE tasks SET last_event=?2, check_after=?3 WHERE session_id=?1 AND archived_at IS NULL",
        params![session_id, event, check_after],
    )
    .map_err(err)
}

pub fn due_task_checks(conn: &Connection, at: i64) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE check_after IS NOT NULL AND check_after <= ?1"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([at], task_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn defer_task_check(
    conn: &Connection,
    id: i64,
    check_after: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET check_after=?2 WHERE id=?1",
        params![id, check_after],
    )
    .map_err(err)?;
    Ok(())
}

pub fn finish_task(conn: &Connection, id: i64, status: &str, summary: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status=?2, summary=?3, check_after=NULL, updated_at=?4 WHERE id=?1",
        params![id, status, summary, now()],
    )
    .map_err(err)?;
    Ok(())
}

pub fn running_task_count(conn: &Connection, agent_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE agent_id=?1 AND status='running' AND archived_at IS NULL",
        [agent_id],
        |row| row.get(0),
    )
    .map_err(err)
}

/// Delegations still open that a session started (a task waits on them).
pub fn open_delegations_from(conn: &Connection, origin_session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM delegations WHERE origin_session_id=?1 AND status IN ('active', 'waiting')",
        [origin_session_id],
        |row| row.get(0),
    )
    .map_err(err)
}

pub fn list_tasks(conn: &Connection, agent_id: &str, limit: i64) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE agent_id=?1 AND archived_at IS NULL
             ORDER BY (status IN ('running', 'waiting')) DESC, updated_at DESC, id DESC LIMIT ?2"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(params![agent_id, limit], task_from_row)
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// Finished tasks last changed before `before` (to archive their sessions).
pub fn finished_tasks_before(conn: &Connection, before: i64) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks
             WHERE archived_at IS NULL AND status IN ('done', 'failed', 'cancelled') AND updated_at < ?1"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([before], task_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn mark_task_archived(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET archived_at=?2, check_after=NULL WHERE id=?1",
        params![id, now()],
    )
    .map_err(err)?;
    Ok(())
}

/// Archived tasks archived before `before` (to delete their sessions).
pub fn archived_tasks_before(conn: &Connection, before: i64) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE archived_at IS NOT NULL AND archived_at < ?1"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([before], task_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn delete_task(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM tasks WHERE id=?1", [id])
        .map_err(err)?;
    Ok(())
}

// ============================================================================
// Notifications (notify_user) and chat carry-over
// ============================================================================

pub const NOTIFICATION_LEVELS: &[&str] = &["info", "action", "error"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: i64,
    pub agent_id: String,
    pub session_id: Option<String>,
    /// info | action (needs the user) | error
    pub level: String,
    pub message: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
}

pub fn add_notification(
    conn: &Connection,
    agent_id: &str,
    session_id: Option<&str>,
    level: &str,
    message: &str,
) -> Result<Notification, String> {
    if !NOTIFICATION_LEVELS.contains(&level) {
        return Err(format!(
            "level must be one of: {}",
            NOTIFICATION_LEVELS.join(", ")
        ));
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("Notification message cannot be empty".to_string());
    }
    let message: String = message.chars().take(2000).collect();
    conn.execute(
        "INSERT INTO notifications (agent_id, session_id, level, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![agent_id, session_id, level, message, now()],
    )
    .map_err(err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, agent_id, session_id, level, message, created_at, read_at FROM notifications WHERE id=?1",
        [id],
        notification_from_row,
    )
    .map_err(err)
}

fn notification_from_row(row: &rusqlite::Row) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        session_id: row.get(2)?,
        level: row.get(3)?,
        message: row.get(4)?,
        created_at: row.get(5)?,
        read_at: row.get(6)?,
    })
}

pub fn list_notifications(
    conn: &Connection,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Notification>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, agent_id, session_id, level, message, created_at, read_at FROM notifications
             WHERE agent_id=?1 ORDER BY (read_at IS NULL) DESC, id DESC LIMIT ?2",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![agent_id, limit], notification_from_row)
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn unread_notification_count(conn: &Connection, agent_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM notifications WHERE agent_id=?1 AND read_at IS NULL",
        [agent_id],
        |row| row.get(0),
    )
    .map_err(err)
}

/// Newest notification and newest task result of an agent, with times
/// (for the sidebar's "what is going on" line).
pub fn latest_activity(conn: &Connection, agent_id: &str) -> Result<Vec<(i64, String)>, String> {
    let notification: Option<(i64, String)> = conn
        .query_row(
            "SELECT created_at, message FROM notifications WHERE agent_id=?1 ORDER BY id DESC LIMIT 1",
            [agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let task: Option<(i64, String)> = conn
        .query_row(
            "SELECT updated_at, COALESCE(NULLIF(summary, ''), title) FROM tasks
             WHERE agent_id=?1 ORDER BY updated_at DESC, id DESC LIMIT 1",
            [agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    Ok(notification.into_iter().chain(task).collect())
}

pub fn mark_notifications_read(conn: &Connection, agent_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE notifications SET read_at=?2 WHERE agent_id=?1 AND read_at IS NULL",
        params![agent_id, now()],
    )
    .map_err(err)?;
    Ok(())
}

/// End of the agent's previous chat, added to the prompt of its new chat.
pub fn set_carry_over(conn: &Connection, agent_id: &str, text: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE agents SET carry_over=?2 WHERE id=?1",
        params![agent_id, text],
    )
    .map_err(err)?;
    Ok(())
}

pub fn get_carry_over(conn: &Connection, agent_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT carry_over FROM agents WHERE id=?1",
        [agent_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(err)
    .map(Option::flatten)
}

// ============================================================================
// Memory
// ============================================================================

pub const MEMORY_KINDS: &[&str] = &["rule", "fact", "open_work"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: i64,
    /// None = shared by all agents.
    pub agent_id: Option<String>,
    pub project_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: Option<i64>,
}

const MEMORY_COLUMNS: &str =
    "m.id, m.agent_id, m.project_id, m.kind, m.content, m.pinned, m.created_at, m.updated_at, m.expires_at";

fn memory_from_row(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: row.get(3)?,
        content: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        expires_at: row.get(8)?,
    })
}

pub struct NewMemory<'a> {
    pub agent_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub kind: &'a str,
    pub content: &'a str,
    pub pinned: bool,
    pub source_session_id: Option<&'a str>,
    pub expires_at: Option<i64>,
}

fn validate_memory(kind: &str, content: &str) -> Result<String, String> {
    if !MEMORY_KINDS.contains(&kind) {
        return Err(format!("kind must be one of: {}", MEMORY_KINDS.join(", ")));
    }
    let content = content.trim();
    if content.is_empty() {
        return Err("Memory content cannot be empty".to_string());
    }
    if content.chars().count() > MAX_MEMORY_CHARS {
        return Err(format!(
            "Memory content is too long (max {MAX_MEMORY_CHARS} characters). Save a shorter fact."
        ));
    }
    Ok(content.to_string())
}

/// Save a memory. The same text in the same scope updates the existing entry
/// instead of adding a duplicate.
pub fn save_memory(conn: &Connection, m: &NewMemory) -> Result<Memory, String> {
    let content = validate_memory(m.kind, m.content)?;
    let ts = now();
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM memories WHERE agent_id IS ?1 AND content = ?2",
            params![m.agent_id, content],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    let id = if let Some(id) = existing {
        conn.execute(
            "UPDATE memories SET kind=?2, project_id=?3, pinned=?4, expires_at=?5, updated_at=?6 WHERE id=?1",
            params![id, m.kind, m.project_id, m.pinned as i64, m.expires_at, ts],
        )
        .map_err(err)?;
        id
    } else {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE agent_id IS ?1",
                [m.agent_id],
                |row| row.get(0),
            )
            .map_err(err)?;
        if count >= MAX_MEMORIES_PER_SCOPE {
            return Err(format!(
                "Memory is full ({MAX_MEMORIES_PER_SCOPE} entries). Forget old entries first."
            ));
        }
        conn.execute(
            "INSERT INTO memories (agent_id, project_id, kind, content, pinned, source_session_id, created_at, updated_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![m.agent_id, m.project_id, m.kind, content, m.pinned as i64, m.source_session_id, ts, m.expires_at],
        )
        .map_err(err)?;
        conn.last_insert_rowid()
    };
    get_memory(conn, id)?.ok_or_else(|| "Memory was not saved".to_string())
}

pub fn get_memory(conn: &Connection, id: i64) -> Result<Option<Memory>, String> {
    conn.query_row(
        &format!("SELECT {MEMORY_COLUMNS} FROM memories m WHERE m.id=?1"),
        [id],
        memory_from_row,
    )
    .optional()
    .map_err(err)
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPatch {
    pub content: Option<String>,
    pub kind: Option<String>,
    pub pinned: Option<bool>,
}

/// Update a memory that `agent_id` can see (its own or shared).
pub fn update_memory(
    conn: &Connection,
    agent_id: &str,
    id: i64,
    patch: &MemoryPatch,
) -> Result<Memory, String> {
    let mut memory = get_memory(conn, id)?
        .filter(|m| m.agent_id.as_deref().is_none_or(|owner| owner == agent_id))
        .ok_or_else(|| format!("Memory not found: {id}"))?;
    let kind = patch.kind.clone().unwrap_or(memory.kind.clone());
    let content = validate_memory(&kind, patch.content.as_deref().unwrap_or(&memory.content))?;
    memory.kind = kind;
    memory.content = content;
    if let Some(pinned) = patch.pinned {
        memory.pinned = pinned;
    }
    memory.updated_at = now();
    conn.execute(
        "UPDATE memories SET kind=?2, content=?3, pinned=?4, updated_at=?5 WHERE id=?1",
        params![
            id,
            memory.kind,
            memory.content,
            memory.pinned as i64,
            memory.updated_at
        ],
    )
    .map_err(err)?;
    Ok(memory)
}

/// Delete a memory that `agent_id` can see. Returns false when not found.
pub fn forget_memory(conn: &Connection, agent_id: &str, id: i64) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM memories WHERE id=?1 AND (agent_id IS NULL OR agent_id=?2)",
            params![id, agent_id],
        )
        .map_err(err)?;
    Ok(changed > 0)
}

/// FTS5 query from free text: each word becomes a quoted prefix term, so user
/// input can never be a syntax error ("orbit push" -> "orbit"* "push"*).
fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|w| !w.is_empty())
        .take(10)
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Memories `agent_id` can see (own + shared), excluding expired entries.
/// With a query: full-text match ranked by relevance; without: pinned first, then newest.
pub fn search_memories(
    conn: &Connection,
    agent_id: &str,
    query: Option<&str>,
    limit: i64,
) -> Result<Vec<Memory>, String> {
    let at = now();
    let scope =
        "(m.agent_id IS NULL OR m.agent_id = ?1) AND (m.expires_at IS NULL OR m.expires_at > ?2)";
    match query.and_then(fts_query) {
        Some(fts) => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEMORY_COLUMNS} FROM memories_fts f JOIN memories m ON m.id = f.rowid
                     WHERE memories_fts MATCH ?3 AND {scope} ORDER BY rank LIMIT ?4"
                ))
                .map_err(err)?;
            let rows = stmt
                .query_map(params![agent_id, at, fts, limit], memory_from_row)
                .map_err(err)?;
            rows.collect::<Result<_, _>>().map_err(err)
        }
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEMORY_COLUMNS} FROM memories m WHERE {scope}
                     ORDER BY m.pinned DESC, m.updated_at DESC, m.id DESC LIMIT ?3"
                ))
                .map_err(err)?;
            let rows = stmt
                .query_map(params![agent_id, at, limit], memory_from_row)
                .map_err(err)?;
            rows.collect::<Result<_, _>>().map_err(err)
        }
    }
}

/// All memories `agent_id` can see, for the UI (includes expired ones).
pub fn list_memories(conn: &Connection, agent_id: &str) -> Result<Vec<Memory>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories m WHERE m.agent_id IS NULL OR m.agent_id = ?1
             ORDER BY m.pinned DESC, m.updated_at DESC, m.id DESC"
        ))
        .map_err(err)?;
    let rows = stmt.query_map([agent_id], memory_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    #[test]
    fn init_seeds_jean_and_is_idempotent() {
        let conn = db();
        init(&conn).unwrap();
        let agents = list_agents(&conn).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, JEAN_AGENT_ID);
        assert_eq!(agents[0].worktree_id, JEAN_AGENT_WORKTREE_ID);
        assert!(agents[0].builtin);
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn create_agent_makes_unique_slug_ids_and_reserved_worktrees() {
        let conn = db();
        let a = create_agent(&conn, "Release Manager", "", "blue", "Ship it").unwrap();
        let b = create_agent(&conn, "Release  manager!", "", "blue", "").unwrap();
        assert_eq!(a.id, "release-manager");
        assert_eq!(b.id, "release-manager-2");
        assert_eq!(a.worktree_id, "__agent_release-manager__");
        assert!(is_agent_worktree_id(&a.worktree_id));
        assert!(is_agent_worktree_id(JEAN_AGENT_WORKTREE_ID));
        assert!(!is_agent_worktree_id("4f1c-real-worktree"));
        assert_eq!(
            agent_by_worktree(&conn, "__agent_release-manager__")
                .unwrap()
                .unwrap()
                .id,
            a.id
        );
        assert!(create_agent(&conn, "  !! ", "", "blue", "").is_err());
    }

    #[test]
    fn builtin_agent_cannot_be_deleted_but_custom_can() {
        let conn = db();
        assert!(delete_agent(&conn, JEAN_AGENT_ID).is_err());
        let a = create_agent(&conn, "Reviewer", "", "green", "").unwrap();
        save_memory(
            &conn,
            &NewMemory {
                agent_id: Some(&a.id),
                project_id: None,
                kind: "fact",
                content: "x",
                pinned: false,
                source_session_id: None,
                expires_at: None,
            },
        )
        .unwrap();
        delete_agent(&conn, &a.id).unwrap();
        assert!(get_agent(&conn, &a.id).unwrap().is_none());
        assert!(list_memories(&conn, &a.id).unwrap().is_empty());
    }

    #[test]
    fn delegation_check_cycle() {
        let conn = db();
        upsert_delegation(&conn, JEAN_AGENT_ID, "s1", "wt1", 0, None).unwrap();
        // Unrelated session: nothing marked
        assert_eq!(
            mark_delegation_run_ended(&conn, "other", "done", None, 10).unwrap(),
            0
        );
        assert_eq!(
            mark_delegation_run_ended(&conn, "s1", "done", None, 10).unwrap(),
            1
        );
        assert!(due_delegation_checks(&conn, 9).unwrap().is_empty());
        let due = due_delegation_checks(&conn, 10).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].last_event.as_deref(), Some("done"));
        finish_delegation(&conn, due[0].id, "waiting", "asks a question").unwrap();
        // Waiting delegations still report the next run end
        assert_eq!(
            mark_delegation_run_ended(&conn, "s1", "done", None, 15).unwrap(),
            1
        );
        finish_delegation(&conn, due[0].id, "done", "all good").unwrap();
        // Finished delegations ignore later runs until re-activated
        assert_eq!(
            mark_delegation_run_ended(&conn, "s1", "done", None, 20).unwrap(),
            0
        );
        upsert_delegation(&conn, JEAN_AGENT_ID, "s1", "wt1", 1, None).unwrap();
        assert_eq!(active_hop_for_session(&conn, "s1").unwrap(), 1);
        assert_eq!(
            list_delegations(&conn, JEAN_AGENT_ID, 10).unwrap()[0].status,
            "active"
        );
    }

    #[test]
    fn requeue_only_touches_active_unqueued_delegations() {
        let conn = db();
        upsert_delegation(&conn, JEAN_AGENT_ID, "s1", "wt", 0, None).unwrap();
        upsert_delegation(&conn, JEAN_AGENT_ID, "s2", "wt", 0, None).unwrap();
        let d2 = list_delegations(&conn, JEAN_AGENT_ID, 10).unwrap();
        let s2 = d2.iter().find(|d| d.session_id == "s2").unwrap();
        finish_delegation(&conn, s2.id, "done", "").unwrap();
        assert_eq!(requeue_active_delegations(&conn, 5).unwrap(), 1);
    }

    #[test]
    fn events_and_wake_budget() {
        let conn = db();
        let id = add_event(
            &conn,
            &NewEvent {
                agent_id: JEAN_AGENT_ID,
                kind: "delegation",
                title: "Follow-up",
                body: "hello",
                target_session_id: Some("task-1"),
                ..Default::default()
            },
        )
        .unwrap();
        let pending = pending_events(&conn, JEAN_AGENT_ID).unwrap();
        assert_eq!(pending[0].target_session_id.as_deref(), Some("task-1"));
        assert_eq!(pending[0].title.as_deref(), Some("Follow-up"));
        assert_eq!(
            agents_with_pending_events(&conn).unwrap(),
            vec![JEAN_AGENT_ID.to_string()]
        );
        assert_eq!(pending_event_count(&conn, JEAN_AGENT_ID).unwrap(), 1);
        mark_events_delivered(&conn, &[id]).unwrap();
        assert!(pending_events(&conn, JEAN_AGENT_ID).unwrap().is_empty());
        record_wake(&conn, JEAN_AGENT_ID, "home").unwrap();
        assert_eq!(wakes_since(&conn, JEAN_AGENT_ID, now() - 3600).unwrap(), 1);
        assert_eq!(wakes_since(&conn, JEAN_AGENT_ID, now() + 1).unwrap(), 0);
    }

    #[test]
    fn schedules_fire_once_or_repeat_and_skip_paused_agents() {
        let conn = db();
        let once = create_schedule(&conn, JEAN_AGENT_ID, "once", "check CI", 100, None).unwrap();
        let every =
            create_schedule(&conn, JEAN_AGENT_ID, "brief", "daily brief", 100, Some(600)).unwrap();
        assert!(fire_due_schedules(&conn, 99).unwrap().is_empty());
        assert_eq!(fire_due_schedules(&conn, 150).unwrap().len(), 2);
        let left = list_schedules(&conn, JEAN_AGENT_ID).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, every.id);
        assert_eq!(left[0].next_run_at, 750);
        assert_eq!(pending_event_count(&conn, JEAN_AGENT_ID).unwrap(), 2);
        assert!(!cancel_schedule(&conn, JEAN_AGENT_ID, once.id).unwrap());
        update_agent(
            &conn,
            JEAN_AGENT_ID,
            &AgentPatch {
                paused: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(fire_due_schedules(&conn, 10_000).unwrap().is_empty());
        assert!(cancel_schedule(&conn, JEAN_AGENT_ID, every.id).unwrap());
        assert_eq!(next_schedule_at(&conn, JEAN_AGENT_ID).unwrap(), None);
    }

    #[test]
    fn approval_is_decided_only_once() {
        let conn = db();
        let id = create_approval(
            &conn,
            JEAN_AGENT_ID,
            Some("task-1"),
            "delete_worktree",
            &serde_json::json!({"worktreeId": "w"}),
        )
        .unwrap();
        assert_eq!(pending_approval_count(&conn, JEAN_AGENT_ID).unwrap(), 1);
        assert!(decide_approval(&conn, id, "approved").unwrap());
        assert!(!decide_approval(&conn, id, "denied").unwrap());
        set_approval_result(&conn, id, "approved", "ok").unwrap();
        let a = get_approval(&conn, id).unwrap().unwrap();
        assert_eq!(a.status, "approved");
        assert_eq!(a.args["worktreeId"], "w");
        assert_eq!(a.session_id.as_deref(), Some("task-1"));
        assert_eq!(pending_approval_count(&conn, JEAN_AGENT_ID).unwrap(), 0);
    }

    fn mem<'a>(agent: Option<&'a str>, content: &'a str) -> NewMemory<'a> {
        NewMemory {
            agent_id: agent,
            project_id: None,
            kind: "rule",
            content,
            pinned: false,
            source_session_id: None,
            expires_at: None,
        }
    }

    #[test]
    fn memory_save_dedupes_and_validates() {
        let conn = db();
        let a = save_memory(&conn, &mem(Some(JEAN_AGENT_ID), "Never push orbit to main")).unwrap();
        let b = save_memory(
            &conn,
            &mem(Some(JEAN_AGENT_ID), "  Never push orbit to main "),
        )
        .unwrap();
        assert_eq!(a.id, b.id);
        // Same text in another scope is a separate entry
        let shared = save_memory(&conn, &mem(None, "Never push orbit to main")).unwrap();
        assert_ne!(shared.id, a.id);
        assert!(save_memory(
            &conn,
            &NewMemory {
                kind: "secret",
                ..mem(None, "x")
            }
        )
        .is_err());
        assert!(save_memory(&conn, &mem(None, "   ")).is_err());
        let long = "x".repeat(MAX_MEMORY_CHARS + 1);
        assert!(save_memory(&conn, &mem(None, &long)).is_err());
    }

    #[test]
    fn memory_search_scopes_fts_and_expiry() {
        let conn = db();
        let other = create_agent(&conn, "Other", "", "blue", "").unwrap();
        save_memory(
            &conn,
            &mem(Some(JEAN_AGENT_ID), "Orbit deploys need approval"),
        )
        .unwrap();
        save_memory(&conn, &mem(None, "User prefers short answers")).unwrap();
        save_memory(
            &conn,
            &mem(Some(&other.id), "Orbit secret plan of other agent"),
        )
        .unwrap();
        save_memory(
            &conn,
            &NewMemory {
                expires_at: Some(1),
                ..mem(Some(JEAN_AGENT_ID), "Orbit old open work")
            },
        )
        .unwrap();

        let hits = search_memories(&conn, JEAN_AGENT_ID, Some("orbit"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "Orbit deploys need approval");
        // Prefix match and syntax-safe input
        assert_eq!(
            search_memories(&conn, JEAN_AGENT_ID, Some("deplo"), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(search_memories(&conn, JEAN_AGENT_ID, Some("\"(* AND"), 10).is_ok());
        // No query: own + shared, not expired, not other agent
        assert_eq!(
            search_memories(&conn, JEAN_AGENT_ID, None, 10)
                .unwrap()
                .len(),
            2
        );
        // UI list includes expired
        assert_eq!(list_memories(&conn, JEAN_AGENT_ID).unwrap().len(), 3);
    }

    #[test]
    fn memory_update_and_forget_respect_ownership() {
        let conn = db();
        let other = create_agent(&conn, "Other", "", "blue", "").unwrap();
        let m = save_memory(&conn, &mem(Some(&other.id), "other fact")).unwrap();
        assert!(update_memory(
            &conn,
            JEAN_AGENT_ID,
            m.id,
            &MemoryPatch {
                pinned: Some(true),
                ..Default::default()
            }
        )
        .is_err());
        assert!(!forget_memory(&conn, JEAN_AGENT_ID, m.id).unwrap());
        let updated = update_memory(
            &conn,
            &other.id,
            m.id,
            &MemoryPatch {
                content: Some("new fact".into()),
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(updated.pinned);
        // FTS index follows updates
        assert_eq!(
            search_memories(&conn, &other.id, Some("new"), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(search_memories(&conn, &other.id, Some("other"), 10)
            .unwrap()
            .is_empty());
        assert!(forget_memory(&conn, &other.id, m.id).unwrap());
        assert!(search_memories(&conn, &other.id, Some("new"), 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn task_worktree_ids_map_back_to_agents() {
        assert_eq!(agent_tasks_worktree_id("jean"), "__agent_tasks_jean__");
        assert_eq!(
            agent_id_from_tasks_worktree("__agent_tasks_jean__"),
            Some("jean")
        );
        assert_eq!(agent_id_from_tasks_worktree("__agent_tasks___"), None);
        assert_eq!(agent_id_from_tasks_worktree("__agent_reviewer__"), None);
        assert!(is_agent_worktree_id("__agent_tasks_release-manager__"));
        // A chat worktree of an agent named "tasks-x" is not a task worktree
        assert_eq!(
            agent_id_from_tasks_worktree(&agent_worktree_id("tasks-x")),
            None
        );
    }

    #[test]
    fn task_lifecycle_and_limits() {
        let conn = db();
        let t = create_task(&conn, JEAN_AGENT_ID, "task-1", "hello check", "schedule").unwrap();
        assert_eq!(t.status, "running");
        assert_eq!(running_task_count(&conn, JEAN_AGENT_ID).unwrap(), 1);
        assert_eq!(mark_task_run_ended(&conn, "task-1", "done", 10).unwrap(), 1);
        assert!(due_task_checks(&conn, 9).unwrap().is_empty());
        assert_eq!(due_task_checks(&conn, 10).unwrap().len(), 1);
        // A task that started work waits for it
        upsert_delegation(&conn, JEAN_AGENT_ID, "worker", "wt", 0, Some("task-1")).unwrap();
        assert_eq!(open_delegations_from(&conn, "task-1").unwrap(), 1);
        finish_task(&conn, t.id, "waiting", "sent work").unwrap();
        assert_eq!(running_task_count(&conn, JEAN_AGENT_ID).unwrap(), 0);
        set_task_running(&conn, "task-1").unwrap();
        finish_task(&conn, t.id, "done", "all good").unwrap();
        assert_eq!(
            list_tasks(&conn, JEAN_AGENT_ID, 10).unwrap()[0]
                .summary
                .as_deref(),
            Some("all good")
        );
        // Archive and delete cycle
        let old = finished_tasks_before(&conn, now() + 1).unwrap();
        assert_eq!(old.len(), 1);
        mark_task_archived(&conn, t.id).unwrap();
        assert!(list_tasks(&conn, JEAN_AGENT_ID, 10).unwrap().is_empty());
        assert_eq!(mark_task_run_ended(&conn, "task-1", "done", 10).unwrap(), 0);
        assert_eq!(archived_tasks_before(&conn, now() + 1).unwrap().len(), 1);
        delete_task(&conn, t.id).unwrap();
        assert!(task_by_session(&conn, "task-1").unwrap().is_none());
    }

    #[test]
    fn notifications_validate_and_mark_read() {
        let conn = db();
        assert!(add_notification(&conn, JEAN_AGENT_ID, None, "loud", "x").is_err());
        assert!(add_notification(&conn, JEAN_AGENT_ID, None, "info", "  ").is_err());
        let n = add_notification(
            &conn,
            JEAN_AGENT_ID,
            Some("task-1"),
            "action",
            "Approve the deploy",
        )
        .unwrap();
        assert_eq!(n.level, "action");
        assert_eq!(unread_notification_count(&conn, JEAN_AGENT_ID).unwrap(), 1);
        mark_notifications_read(&conn, JEAN_AGENT_ID).unwrap();
        assert_eq!(unread_notification_count(&conn, JEAN_AGENT_ID).unwrap(), 0);
        assert!(list_notifications(&conn, JEAN_AGENT_ID, 10).unwrap()[0]
            .read_at
            .is_some());
    }

    #[test]
    fn carry_over_round_trip() {
        let conn = db();
        assert_eq!(get_carry_over(&conn, JEAN_AGENT_ID).unwrap(), None);
        set_carry_over(&conn, JEAN_AGENT_ID, "User: hi").unwrap();
        assert_eq!(
            get_carry_over(&conn, JEAN_AGENT_ID).unwrap().as_deref(),
            Some("User: hi")
        );
    }

    #[test]
    fn v1_database_with_data_upgrades_to_latest() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("{} PRAGMA user_version = 1;", MIGRATIONS[0]))
            .unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, worktree_id, created_at, updated_at) VALUES ('jean', 'Jean', '__jean_agent__', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO delegations (agent_id, session_id, worktree_id, status, created_at, updated_at) VALUES ('jean', 's1', 'wt', 'active', 1, 1)",
            [],
        )
        .unwrap();
        init(&conn).unwrap();
        let d = &list_delegations(&conn, JEAN_AGENT_ID, 10).unwrap()[0];
        assert_eq!(d.session_id, "s1");
        assert_eq!(d.origin_session_id, None);
        create_task(&conn, JEAN_AGENT_ID, "t1", "x", "schedule").unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }
}

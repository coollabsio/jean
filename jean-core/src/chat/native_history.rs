use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::AppHandle;

use super::storage::{load_metadata, with_existing_metadata_mut};
use super::types::{Backend, SessionMetadata};
use crate::http_server::EmitExt;

const MAX_NATIVE_HISTORY_FILES: usize = 10_000;
const MAX_NATIVE_HISTORY_CACHE_ROWS: usize = 500;
const MAX_NATIVE_HISTORY_RESULTS: usize = 100;
const DEFAULT_NATIVE_HISTORY_RESULTS: usize = 5;
const NATIVE_HISTORY_CACHE_TTL: Duration = Duration::from_secs(30);

static NATIVE_HISTORY_CACHE: OnceLock<
    Mutex<HashMap<NativeHistoryCacheKey, NativeHistoryCacheEntry>>,
> = OnceLock::new();
static NATIVE_SESSION_TRACKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCliHistorySession {
    pub backend: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: u64,
    pub resume_args: Vec<String>,
    pub source_path: String,
}

#[derive(Debug, Clone, Eq)]
struct NativeHistoryCacheKey {
    backend: String,
    worktree_path: String,
}

impl PartialEq for NativeHistoryCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.backend == other.backend && self.worktree_path == other.worktree_path
    }
}

impl Hash for NativeHistoryCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.backend.hash(state);
        self.worktree_path.hash(state);
    }
}

#[derive(Debug, Clone)]
struct NativeHistoryCacheEntry {
    expires_at: Instant,
    sessions: Vec<NativeCliHistorySession>,
}

pub async fn list_native_cli_sessions(
    worktree_path: String,
    backend: String,
    search_query: Option<String>,
    result_limit: Option<usize>,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let query = normalize_search_query(search_query.as_deref());
    let limit = result_limit
        .unwrap_or(if query.is_some() {
            MAX_NATIVE_HISTORY_RESULTS
        } else {
            DEFAULT_NATIVE_HISTORY_RESULTS
        })
        .clamp(1, MAX_NATIVE_HISTORY_RESULTS);
    let sessions = get_cached_native_sessions(&worktree_path, &backend)?;
    Ok(filter_cached_native_sessions(
        &sessions,
        query.as_deref(),
        limit,
    ))
}

#[derive(Debug, PartialEq, Eq)]
enum NewNativeSession {
    Pending,
    Found(String),
    Ambiguous,
}

fn find_new_native_session_id(
    known_session_ids: &HashSet<String>,
    current_session_ids: Vec<String>,
) -> NewNativeSession {
    let mut new_ids = current_session_ids
        .into_iter()
        .filter(|id| !known_session_ids.contains(id))
        .collect::<Vec<_>>();
    new_ids.sort();
    new_ids.dedup();
    match new_ids.as_slice() {
        [] => NewNativeSession::Pending,
        [id] => NewNativeSession::Found(id.clone()),
        _ => NewNativeSession::Ambiguous,
    }
}

fn persist_native_cli_session_id(
    app: &AppHandle,
    jean_session_id: &str,
    backend: &str,
    native_session_id: &str,
) -> Result<(), String> {
    with_existing_metadata_mut(app, jean_session_id, |metadata| {
        if metadata.primary_surface.as_deref() != Some("terminal") {
            return Err(format!(
                "Session {jean_session_id} is not a terminal session"
            ));
        }

        match (backend, &metadata.backend) {
            ("claude", Backend::Claude) => {
                metadata.claude_session_id = Some(native_session_id.to_string())
            }
            ("codex", Backend::Codex) => {
                metadata.codex_thread_id = Some(native_session_id.to_string())
            }
            ("opencode", Backend::Opencode) => {
                metadata.opencode_session_id = Some(native_session_id.to_string())
            }
            _ => {
                return Err(format!(
                    "Backend {backend} does not match session {jean_session_id}"
                ));
            }
        }
        Ok(())
    })??;

    if let Err(error) = app.emit_all(
        "cache:invalidate",
        &serde_json::json!({ "keys": ["sessions"] }),
    ) {
        log::error!("Failed to invalidate sessions after native CLI binding: {error}");
    }
    Ok(())
}

fn validate_native_cli_tracking_metadata(
    metadata: &SessionMetadata,
    backend: &str,
) -> Result<(), String> {
    if metadata.primary_surface.as_deref() != Some("terminal") {
        return Err(format!("Session {} is not a terminal session", metadata.id));
    }

    match (backend, &metadata.backend) {
        ("codex", Backend::Codex) | ("opencode", Backend::Opencode) => Ok(()),
        _ => Err(format!(
            "Backend {backend} does not match session {}",
            metadata.id
        )),
    }
}

pub async fn bind_native_cli_session(
    app: AppHandle,
    session_id: String,
    backend: String,
    native_session_id: String,
) -> Result<(), String> {
    persist_native_cli_session_id(&app, &session_id, &backend, &native_session_id)
}

/// Snapshot native history before a new PTY starts, then bind the one newly
/// created CLI conversation to its Jean terminal session. Ambiguous matches
/// are never guessed.
pub async fn track_native_cli_session(
    app: AppHandle,
    worktree_path: String,
    session_id: String,
    backend: String,
) -> Result<(), String> {
    if backend != "codex" && backend != "opencode" {
        return Err(format!(
            "Native CLI tracking is not supported for backend {backend}"
        ));
    }
    let metadata = load_metadata(&app, &session_id)?
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    validate_native_cli_tracking_metadata(&metadata, &backend)?;

    let known_session_ids = load_native_session_ids_uncached(&worktree_path, &backend)?
        .into_iter()
        .collect::<HashSet<_>>();
    let trackers = NATIVE_SESSION_TRACKERS.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut active = trackers
            .lock()
            .map_err(|_| "Native session tracker lock poisoned".to_string())?;
        if !active.insert(session_id.clone()) {
            return Ok(());
        }
    }

    tauri::async_runtime::spawn(async move {
        const FAST_ATTEMPTS: usize = 90;
        const MAX_ATTEMPTS: usize = 261;
        for attempt in 0..MAX_ATTEMPTS {
            match load_native_session_ids_uncached(&worktree_path, &backend) {
                Ok(current_ids) => {
                    match find_new_native_session_id(&known_session_ids, current_ids) {
                        NewNativeSession::Pending => {}
                        NewNativeSession::Found(native_session_id) => {
                            match persist_native_cli_session_id(
                                &app,
                                &session_id,
                                &backend,
                                &native_session_id,
                            ) {
                                Ok(()) => log::info!(
                                    "Bound Jean terminal session {session_id} to {backend} session {native_session_id}"
                                ),
                                Err(error) => log::warn!(
                                    "Failed to bind Jean terminal session {session_id}: {error}"
                                ),
                            }
                            break;
                        }
                        NewNativeSession::Ambiguous => {
                            log::warn!(
                                "Refusing to guess native {backend} session for Jean session {session_id}: multiple new sessions appeared"
                            );
                            break;
                        }
                    }
                }
                Err(error) => {
                    log::debug!(
                        "Native {backend} session tracking scan failed for {session_id}: {error}"
                    );
                }
            }
            let poll_delay = if attempt < FAST_ATTEMPTS { 1 } else { 10 };
            tokio::time::sleep(Duration::from_secs(poll_delay)).await;
        }

        if let Ok(mut active) = trackers.lock() {
            active.remove(&session_id);
        }
    });

    Ok(())
}

fn get_cached_native_sessions(
    worktree_path: &str,
    backend: &str,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let key = NativeHistoryCacheKey {
        backend: backend.to_string(),
        worktree_path: canonical_path_key(worktree_path),
    };
    let now = Instant::now();
    let cache = NATIVE_HISTORY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Ok(cache_guard) = cache.lock() {
        if let Some(entry) = cache_guard.get(&key) {
            if entry.expires_at > now {
                return Ok(entry.sessions.clone());
            }
        }
    }

    let sessions = load_native_sessions_uncached(worktree_path, backend)?;
    if let Ok(mut cache_guard) = cache.lock() {
        cache_guard.insert(
            key,
            NativeHistoryCacheEntry {
                expires_at: now + NATIVE_HISTORY_CACHE_TTL,
                sessions: sessions.clone(),
            },
        );
    }
    Ok(sessions)
}

fn load_native_sessions_uncached(
    worktree_path: &str,
    backend: &str,
) -> Result<Vec<NativeCliHistorySession>, String> {
    match backend {
        "codex" => list_codex_sessions(worktree_path, None, MAX_NATIVE_HISTORY_CACHE_ROWS),
        "claude" => list_claude_sessions(worktree_path, None, MAX_NATIVE_HISTORY_CACHE_ROWS),
        "opencode" => list_opencode_sessions(worktree_path, None, MAX_NATIVE_HISTORY_CACHE_ROWS),
        "cursor" => list_cursor_sessions(worktree_path, None, MAX_NATIVE_HISTORY_CACHE_ROWS),
        "commandcode" => Ok(Vec::new()),
        other => Err(format!("Unsupported native CLI history backend: {other}")),
    }
}

fn load_native_session_ids_uncached(
    worktree_path: &str,
    backend: &str,
) -> Result<Vec<String>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };

    let mut ids: Vec<String> = match backend {
        "codex" => {
            let root = home.join(".codex").join("sessions");
            if !root.exists() {
                return Ok(Vec::new());
            }
            collect_jsonl_files(&root, Some("rollout-"))?
                .into_iter()
                .filter_map(|path| parse_codex_session_identity(&path, worktree_path))
                .collect()
        }
        "opencode" => {
            let root = home
                .join(".local")
                .join("share")
                .join("opencode")
                .join("storage")
                .join("session");
            if !root.exists() {
                return Ok(Vec::new());
            }
            collect_files_with_extension(&root, "json")?
                .into_iter()
                .filter_map(|path| parse_opencode_session_identity(&path, worktree_path))
                .collect()
        }
        other => return Err(format!("Unsupported native CLI tracking backend: {other}")),
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn filter_cached_native_sessions(
    sessions: &[NativeCliHistorySession],
    query: Option<&str>,
    limit: usize,
) -> Vec<NativeCliHistorySession> {
    sessions
        .iter()
        .filter(|session| native_session_matches_query(session, query))
        .take(limit)
        .cloned()
        .collect()
}

fn list_codex_sessions(
    worktree_path: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for path in collect_jsonl_files(&root, Some("rollout-"))? {
        if let Some(session) = parse_codex_session_file(&path, worktree_path) {
            push_if_matches(&mut results, session, query);
        }
    }
    sort_and_limit(results, limit)
}

fn list_claude_sessions(
    worktree_path: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let projects_root = home.join(".claude").join("projects");
    if !projects_root.exists() {
        return Ok(Vec::new());
    }

    let escaped_dir = projects_root.join(escape_claude_project_dir(worktree_path));
    let search_roots = if escaped_dir.exists() {
        vec![escaped_dir]
    } else {
        vec![projects_root]
    };

    let mut results = Vec::new();
    for root in search_roots {
        for path in collect_jsonl_files(&root, None)? {
            if let Some(session) = parse_claude_session_file(&path, worktree_path) {
                push_if_matches(&mut results, session, query);
            }
        }
    }
    sort_and_limit(results, limit)
}

fn list_cursor_sessions(
    worktree_path: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let transcripts_root = home
        .join(".cursor")
        .join("projects")
        .join(escape_cursor_project_dir(worktree_path))
        .join("agent-transcripts");
    if !transcripts_root.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for path in collect_jsonl_files(&transcripts_root, None)? {
        if let Some(session) = parse_cursor_session_file(&path, worktree_path) {
            push_if_matches(&mut results, session, query);
        }
    }
    sort_and_limit(results, limit)
}

fn list_opencode_sessions(
    worktree_path: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<NativeCliHistorySession>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let sessions_root = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("storage")
        .join("session");
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for path in collect_files_with_extension(&sessions_root, "json")? {
        if let Some(session) = parse_opencode_session_file(&path, worktree_path) {
            push_if_matches(&mut results, session, query);
        }
    }
    sort_and_limit(results, limit)
}

fn collect_jsonl_files(root: &Path, filename_prefix: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_jsonl_files_inner(root, filename_prefix, &mut files)?;
    Ok(files)
}

fn collect_jsonl_files_inner(
    root: &Path,
    filename_prefix: Option<&str>,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if files.len() >= MAX_NATIVE_HISTORY_FILES {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_NATIVE_HISTORY_FILES {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files_inner(&path, filename_prefix, files)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(prefix) = filename_prefix {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with(prefix) {
                continue;
            }
        }
        files.push(path);
    }
    Ok(())
}

fn collect_files_with_extension(root: &Path, extension: &str) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_with_extension_inner(root, extension, &mut files)?;
    Ok(files)
}

fn collect_files_with_extension_inner(
    root: &Path,
    extension: &str,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if files.len() >= MAX_NATIVE_HISTORY_FILES {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_NATIVE_HISTORY_FILES {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_files_with_extension_inner(&path, extension, files)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) == Some(extension) {
            files.push(path);
        }
    }
    Ok(())
}

fn parse_codex_session_file(path: &Path, worktree_path: &str) -> Option<NativeCliHistorySession> {
    let contents = fs::read_to_string(path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut title = None;
    let mut source = None;
    let mut originator = None;

    for line in contents.lines().take(500) {
        let value: Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            let payload = value.get("payload")?;
            id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            source = payload
                .get("source")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            originator = payload
                .get("originator")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }

        if title.is_none() {
            title = codex_title_from_line(&value);
        }

        if id.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
    }

    let id = id?;
    let cwd = cwd?;
    // Match Codex TUI's resume picker: it includes normal saved sessions for
    // the cwd, including Jean-created Codex sessions, but excludes one-shot
    // `codex exec` history entries.
    if source.as_deref() == Some("exec") || originator.as_deref() == Some("codex_exec") {
        return None;
    }
    if !same_path(&cwd, worktree_path) {
        return None;
    }
    let title = title?;
    let updated_at = file_updated_at(path);
    Some(NativeCliHistorySession {
        backend: "codex".to_string(),
        id: id.clone(),
        title,
        cwd,
        updated_at,
        resume_args: vec!["resume".to_string(), id],
        source_path: path.to_string_lossy().to_string(),
    })
}

fn parse_codex_session_identity(path: &Path, worktree_path: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    for line in contents.lines().take(100) {
        let value: Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload")?;
        if payload.get("source").and_then(Value::as_str) == Some("exec")
            || payload.get("originator").and_then(Value::as_str) == Some("codex_exec")
        {
            return None;
        }
        let cwd = payload.get("cwd").and_then(Value::as_str)?;
        if !same_path(cwd, worktree_path) {
            return None;
        }
        return payload
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    None
}

fn codex_title_from_line(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("event_msg") {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(Value::as_str) == Some("user_message") {
            return trim_codex_user_title(payload.get("message")?.as_str()?);
        }
    }

    if value.get("type").and_then(Value::as_str) == Some("response_item") {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(Value::as_str) == Some("message")
            && payload.get("role").and_then(Value::as_str) == Some("user")
        {
            if let Some(content) = payload.get("content").and_then(Value::as_array) {
                for item in content {
                    if item.get("type").and_then(Value::as_str) == Some("input_text") {
                        if let Some(title) = trim_codex_user_title(item.get("text")?.as_str()?) {
                            return Some(title);
                        }
                    }
                }
            }
        }
    }
    None
}

fn trim_codex_user_title(value: &str) -> Option<String> {
    if is_codex_context_message(value) {
        return None;
    }
    trim_title(value)
}

fn is_codex_context_message(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with("# AGENTS.md instructions for ")
        || trimmed.starts_with("# CLAUDE.md instructions for ")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<permissions instructions>")
        || trimmed.starts_with("<turn_aborted>")
        || trimmed.starts_with("<user_editable_context>")
}

fn parse_claude_session_file(path: &Path, worktree_path: &str) -> Option<NativeCliHistorySession> {
    let contents = fs::read_to_string(path).ok()?;
    let mut id = path.file_stem()?.to_str()?.to_string();
    let mut cwd = None;
    let mut title = None;
    let mut slug = None;

    for line in contents.lines().take(200) {
        let value: Value = serde_json::from_str(line).ok()?;
        if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
            id = session_id.to_string();
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        if slug.is_none() {
            slug = value
                .get("slug")
                .and_then(Value::as_str)
                .map(|s| humanize_slug(s));
        }
        if title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("user")
            && value.get("isSidechain").and_then(Value::as_bool) != Some(true)
        {
            if let Some(message) = value.get("message") {
                if let Some(content) = message.get("content") {
                    title = title_from_claude_content(content);
                }
            }
        }

        if cwd.is_some() && title.is_some() {
            break;
        }
    }

    let cwd = cwd?;
    if !same_path(&cwd, worktree_path) {
        return None;
    }
    let updated_at = file_updated_at(path);
    Some(NativeCliHistorySession {
        backend: "claude".to_string(),
        id: id.clone(),
        title: title
            .or(slug)
            .unwrap_or_else(|| "Claude session".to_string()),
        cwd,
        updated_at,
        resume_args: vec!["--resume".to_string(), id],
        source_path: path.to_string_lossy().to_string(),
    })
}

fn title_from_claude_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return trim_claude_user_title(text);
    }
    if let Some(items) = content.as_array() {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(title) = trim_claude_user_title(item.get("text")?.as_str()?) {
                    return Some(title);
                }
            }
        }
    }
    None
}

fn trim_claude_user_title(value: &str) -> Option<String> {
    if is_native_context_message(value) {
        return None;
    }
    trim_title(value)
}

fn parse_cursor_session_file(path: &Path, worktree_path: &str) -> Option<NativeCliHistorySession> {
    let contents = fs::read_to_string(path).ok()?;
    let id = path.file_stem()?.to_str()?.to_string();
    let mut title = None;

    for line in contents.lines().take(500) {
        let value: Value = serde_json::from_str(line).ok()?;
        if title.is_none()
            && value.get("role").and_then(Value::as_str) == Some("user")
            && value.get("isSidechain").and_then(Value::as_bool) != Some(true)
        {
            if let Some(message) = value.get("message") {
                if let Some(content) = message.get("content") {
                    title = title_from_cursor_content(content);
                }
            }
        }

        if title.is_some() {
            break;
        }
    }

    let title = title?;
    let updated_at = file_updated_at(path);
    Some(NativeCliHistorySession {
        backend: "cursor".to_string(),
        id: id.clone(),
        title,
        cwd: worktree_path.to_string(),
        updated_at,
        resume_args: vec!["--resume".to_string(), id],
        source_path: path.to_string_lossy().to_string(),
    })
}

fn parse_opencode_session_file(
    path: &Path,
    worktree_path: &str,
) -> Option<NativeCliHistorySession> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let cwd = value
        .get("directory")
        .or_else(|| value.get("path"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| opencode_project_worktree_from_path(path))?;
    if !same_path(&cwd, worktree_path) {
        return None;
    }

    let title = trim_title(value.get("title").and_then(Value::as_str)?)?;
    let updated_at = value
        .get("time")
        .and_then(|time| time.get("updated").or_else(|| time.get("created")))
        .and_then(Value::as_u64)
        .map(|millis| millis / 1000)
        .unwrap_or_else(|| file_updated_at(path));

    Some(NativeCliHistorySession {
        backend: "opencode".to_string(),
        id: id.clone(),
        title,
        cwd,
        updated_at,
        resume_args: vec!["--session".to_string(), id],
        source_path: path.to_string_lossy().to_string(),
    })
}

fn parse_opencode_session_identity(path: &Path, worktree_path: &str) -> Option<String> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let cwd = value
        .get("directory")
        .or_else(|| value.get("path"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| opencode_project_worktree_from_path(path))?;
    if !same_path(&cwd, worktree_path) {
        return None;
    }
    value
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn opencode_project_worktree_from_path(path: &Path) -> Option<String> {
    let project_id = path.parent()?.file_name()?.to_str()?;
    let project_path = dirs::home_dir()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("storage")
        .join("project")
        .join(format!("{project_id}.json"));
    let value: Value = serde_json::from_str(&fs::read_to_string(project_path).ok()?).ok()?;
    value
        .get("worktree")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn title_from_cursor_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return trim_cursor_user_title(text);
    }
    if let Some(items) = content.as_array() {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(title) = trim_cursor_user_title(item.get("text")?.as_str()?) {
                    return Some(title);
                }
            }
        }
    }
    None
}

fn trim_cursor_user_title(value: &str) -> Option<String> {
    if is_native_context_message(value) {
        return None;
    }
    trim_title(&strip_wrapping_tag(value, "user_query"))
}

fn file_updated_at(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn trim_title(value: &str) -> Option<String> {
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = one_line.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.chars().count() > 96 {
        Some(trimmed.chars().take(93).collect::<String>() + "…")
    } else {
        Some(trimmed.to_string())
    }
}

fn humanize_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_claude_project_dir(path: &str) -> String {
    path.replace('/', "-")
}

fn escape_cursor_project_dir(path: &str) -> String {
    path.trim_start_matches('/').replace('/', "-")
}

fn same_path(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        Path::new(value)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(value))
    };
    normalize(a) == normalize(b)
}

fn canonical_path_key(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn sort_and_limit(
    mut sessions: Vec<NativeCliHistorySession>,
    limit: usize,
) -> Result<Vec<NativeCliHistorySession>, String> {
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    sessions.truncate(limit);
    Ok(sessions)
}

fn push_if_matches(
    results: &mut Vec<NativeCliHistorySession>,
    session: NativeCliHistorySession,
    query: Option<&str>,
) {
    if native_session_matches_query(&session, query) {
        results.push(session);
    }
}

fn native_session_matches_query(session: &NativeCliHistorySession, query: Option<&str>) -> bool {
    let Some(query) = query else {
        return true;
    };
    let haystack = [
        session.backend.as_str(),
        session.id.as_str(),
        session.title.as_str(),
        session.cwd.as_str(),
        session.source_path.as_str(),
        &session.resume_args.join(" "),
    ]
    .join(" ")
    .to_lowercase();
    haystack.contains(query)
}

fn normalize_search_query(value: Option<&str>) -> Option<String> {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

fn is_native_context_message(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with("# AGENTS.md instructions for ")
        || trimmed.starts_with("# CLAUDE.md instructions for ")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<permissions instructions>")
        || trimmed.starts_with("<turn_aborted>")
        || trimmed.starts_with("<user_editable_context>")
        || trimmed.starts_with("<local-command-caveat>")
}

fn strip_wrapping_tag(value: &str, tag: &str) -> String {
    let trimmed = value.trim();
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    trimmed
        .strip_prefix(&start)
        .and_then(|value| value.strip_suffix(&end))
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_session(id: usize, updated_at: u64, title: &str) -> NativeCliHistorySession {
        NativeCliHistorySession {
            backend: "claude".to_string(),
            id: format!("session-{id}"),
            title: title.to_string(),
            cwd: "/tmp/worktree".to_string(),
            updated_at,
            resume_args: vec!["--resume".to_string(), format!("session-{id}")],
            source_path: format!("/tmp/session-{id}.jsonl"),
        }
    }

    #[test]
    fn native_session_tracking_requires_one_unambiguous_new_id() {
        let known = HashSet::from(["existing".to_string()]);

        assert_eq!(
            find_new_native_session_id(&known, vec!["existing".to_string()]),
            NewNativeSession::Pending
        );
        assert_eq!(
            find_new_native_session_id(
                &known,
                vec!["existing".to_string(), "new-session".to_string()]
            ),
            NewNativeSession::Found("new-session".to_string())
        );
        assert_eq!(
            find_new_native_session_id(
                &known,
                vec![
                    "existing".to_string(),
                    "new-a".to_string(),
                    "new-b".to_string()
                ]
            ),
            NewNativeSession::Ambiguous
        );
    }

    #[test]
    fn native_session_tracking_validation_requires_matching_terminal_metadata() {
        let mut metadata = crate::chat::types::SessionMetadata::new(
            "jean-session".to_string(),
            "worktree-1".to_string(),
            "Codex".to_string(),
            0,
        );
        metadata.backend = Backend::Codex;
        metadata.primary_surface = Some("terminal".to_string());

        assert!(validate_native_cli_tracking_metadata(&metadata, "codex").is_ok());
        assert!(validate_native_cli_tracking_metadata(&metadata, "opencode").is_err());

        metadata.primary_surface = Some("chat".to_string());
        assert!(validate_native_cli_tracking_metadata(&metadata, "codex").is_err());
    }

    #[test]
    fn native_history_default_returns_latest_five_from_cache() {
        let sessions = (0..10)
            .map(|index| test_session(index, index as u64, &format!("task {index}")))
            .collect::<Vec<_>>();

        let results =
            filter_cached_native_sessions(&sessions, None, DEFAULT_NATIVE_HISTORY_RESULTS);

        assert_eq!(results.len(), 5);
        assert_eq!(results[0].title, "task 0");
        assert_eq!(results[4].title, "task 4");
    }

    #[test]
    fn native_history_cache_caps_to_newest_five_hundred() {
        let sessions = (0..=MAX_NATIVE_HISTORY_CACHE_ROWS)
            .map(|index| {
                test_session(
                    index,
                    (MAX_NATIVE_HISTORY_CACHE_ROWS - index) as u64,
                    &format!("task {index}"),
                )
            })
            .collect::<Vec<_>>();

        let capped = sort_and_limit(sessions, MAX_NATIVE_HISTORY_CACHE_ROWS).unwrap();
        let row_500 =
            filter_cached_native_sessions(&capped, Some("task 499"), MAX_NATIVE_HISTORY_RESULTS);
        let row_501 =
            filter_cached_native_sessions(&capped, Some("task 500"), MAX_NATIVE_HISTORY_RESULTS);

        assert_eq!(capped.len(), MAX_NATIVE_HISTORY_CACHE_ROWS);
        assert_eq!(row_500.len(), 1);
        assert!(row_501.is_empty());
    }

    #[test]
    fn codex_title_reads_event_user_message() {
        let value: Value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "hello from codex"
            }
        });
        assert_eq!(
            codex_title_from_line(&value).as_deref(),
            Some("hello from codex")
        );
    }

    #[test]
    fn claude_project_dir_escape_matches_native_layout() {
        assert_eq!(
            escape_claude_project_dir("/Users/heyandras/devel/coolify.io"),
            "-Users-heyandras-devel-coolify.io"
        );
    }

    #[test]
    fn codex_parser_keeps_jean_sessions() {
        let dir =
            std::env::temp_dir().join(format!("jean-native-history-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-jean.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "jean-session",
                    "cwd": "/tmp/worktree",
                    "originator": "jean",
                    "source": "vscode"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "name a session"}
            })
        )
        .unwrap();

        let parsed = parse_codex_session_file(&path, "/tmp/worktree").unwrap();
        assert_eq!(parsed.id, "jean-session");
        assert_eq!(parsed.title, "name a session");
        assert_eq!(parsed.resume_args, vec!["resume", "jean-session"]);
        assert_eq!(
            parse_codex_session_identity(&path, "/tmp/worktree").as_deref(),
            Some("jean-session")
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn codex_parser_ignores_exec_sessions() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-exec-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-exec.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "exec-session",
                    "cwd": "/tmp/worktree",
                    "originator": "codex_exec",
                    "source": "exec"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "one shot task"}
            })
        )
        .unwrap();

        assert!(parse_codex_session_file(&path, "/tmp/worktree").is_none());
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn codex_parser_keeps_cli_sessions() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-cli-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-cli.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "cli-session",
                    "cwd": "/tmp/worktree",
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "real cli task"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}]
                }
            })
        )
        .unwrap();

        let parsed = parse_codex_session_file(&path, "/tmp/worktree").unwrap();
        assert_eq!(parsed.id, "cli-session");
        assert_eq!(parsed.title, "real cli task");
        assert_eq!(parsed.resume_args, vec!["resume", "cli-session"]);
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn codex_parser_skips_context_titles_and_uses_real_prompt() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-context-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-context.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "context-session",
                    "cwd": "/tmp/worktree",
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "# AGENTS.md instructions for /tmp/worktree\n\n<INSTRUCTIONS>\n/Users/heyandras/.codex/RTK.md\n</INSTRUCTIONS>"
                        },
                        {
                            "type": "input_text",
                            "text": "<environment_context>\n  <cwd>/tmp/worktree</cwd>\n</environment_context>"
                        }
                    ]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "hello"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "hello back"}
            })
        )
        .unwrap();

        let parsed = parse_codex_session_file(&path, "/tmp/worktree").unwrap();
        assert_eq!(parsed.title, "hello");
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn codex_parser_drops_context_only_cli_sessions() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-context-only-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-context-only.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "context-only-session",
                    "cwd": "/tmp/worktree",
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "# AGENTS.md instructions for /tmp/worktree"
                        }
                    ]
                }
            })
        )
        .unwrap();

        assert!(parse_codex_session_file(&path, "/tmp/worktree").is_none());
        assert_eq!(
            parse_codex_session_identity(&path, "/tmp/worktree").as_deref(),
            Some("context-only-session")
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn codex_parser_keeps_prompt_only_tui_sessions() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-prompt-only-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("rollout-prompt-only.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "aborted-session",
                    "cwd": "/tmp/worktree",
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "ps -ef"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "turn_aborted"}
            })
        )
        .unwrap();

        let parsed = parse_codex_session_file(&path, "/tmp/worktree").unwrap();
        assert_eq!(parsed.id, "aborted-session");
        assert_eq!(parsed.title, "ps -ef");
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn opencode_identity_is_available_before_a_title_exists() {
        let dir = std::env::temp_dir().join(format!(
            "jean-native-history-test-opencode-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("session.json");
        fs::write(
            &path,
            serde_json::json!({
                "id": "opencode-session",
                "directory": "/tmp/worktree"
            })
            .to_string(),
        )
        .unwrap();

        assert!(parse_opencode_session_file(&path, "/tmp/worktree").is_none());
        assert_eq!(
            parse_opencode_session_identity(&path, "/tmp/worktree").as_deref(),
            Some("opencode-session")
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }
}

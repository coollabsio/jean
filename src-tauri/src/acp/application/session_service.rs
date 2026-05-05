use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock};

use crate::acp::application::{session_state, supervisor};
use crate::acp::domain::session::SessionInfoState;
use crate::acp::infrastructure::session_log::{Direction, SessionLog};
use crate::acp::infrastructure::snapshot_store::PairStatus;
use crate::acp::provider::AcpProvider;

static JEAN_SESSION_TXNS: Lazy<RwLock<std::collections::HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| RwLock::new(std::collections::HashMap::new()));

#[derive(Debug, Clone)]
pub struct OpenSessionResult {
    pub session_id: String,
    pub provider: String,
    pub config_options: Value,
    pub available_commands: Value,
    pub log_path: String,
    pub resumed: bool,
    pub title: Option<String>,
    pub prompt_image: bool,
}

#[derive(Debug, Clone)]
pub struct LocalSessionState {
    pub exists: bool,
    pub snapshot: Option<SessionInfoState>,
    pub log_entries: Vec<Value>,
}

pub async fn create_session(
    app: AppHandle,
    jean_session_id: String,
    cwd: String,
    provider: String,
) -> Result<OpenSessionResult, String> {
    let txn = jean_session_txn(&jean_session_id).await;
    let _txn = txn.lock().await;
    let provider = AcpProvider::from_wire(provider)?;
    let cwd_path = validate_cwd(&cwd)?;

    let status = session_state::pair_status(&app, &jean_session_id)?;
    validate_create_status(&status, &jean_session_id)?;

    match status {
        PairStatus::Neither => {
            create_fresh_session(&app, provider, jean_session_id, cwd_path).await
        }
        PairStatus::Both => unreachable!(),
        PairStatus::OnlySnapshot(_) | PairStatus::OnlyEvents(_) => unreachable!(),
    }
}

pub async fn resume_session(
    app: AppHandle,
    jean_session_id: String,
    cwd: String,
) -> Result<OpenSessionResult, String> {
    let txn = jean_session_txn(&jean_session_id).await;
    let _txn = txn.lock().await;
    let cwd_path = validate_cwd(&cwd)?;

    let status = session_state::pair_status(&app, &jean_session_id)?;
    validate_resume_status(&status, &jean_session_id)?;

    match status {
        PairStatus::Both => resume_existing_session(&app, jean_session_id, cwd_path).await,
        PairStatus::Neither => unreachable!(),
        PairStatus::OnlySnapshot(_) | PairStatus::OnlyEvents(_) => unreachable!(),
    }
}

pub async fn load_session_log(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<Vec<Value>, String> {
    let path = session_state::events_path(app, jean_session_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("read session log {path:?}: {e}"))?;
    let mut entries = Vec::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => entries.push(v),
            Err(e) => log::warn!("[acp] skipping malformed log line: {e}"),
        }
    }
    Ok(entries)
}

pub async fn load_local_session_state(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<LocalSessionState, String> {
    let status = session_state::pair_status(app, jean_session_id)?;
    if let Some(err) = status.corruption_error(jean_session_id) {
        return Err(err);
    }

    match status {
        PairStatus::Neither => Ok(LocalSessionState {
            exists: false,
            snapshot: None,
            log_entries: Vec::new(),
        }),
        PairStatus::Both => Ok(LocalSessionState {
            exists: true,
            snapshot: Some(session_state::current_session_info(app, jean_session_id)?),
            log_entries: load_session_log(app, jean_session_id).await?,
        }),
        PairStatus::OnlySnapshot(_) | PairStatus::OnlyEvents(_) => unreachable!(),
    }
}

pub(crate) fn resolve_bound_session(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<(AcpProvider, String), String> {
    let binding = session_state::resolve_binding(app, jean_session_id)?
        .ok_or_else(|| format!("ACP session snapshot missing for {jean_session_id}"))?;
    Ok((binding.provider, binding.acp_session_id))
}

async fn resume_existing_session(
    app: &AppHandle,
    jean_session_id: String,
    cwd_path: PathBuf,
) -> Result<OpenSessionResult, String> {
    let binding = session_state::resolve_binding(app, &jean_session_id)?
        .ok_or_else(|| format!("snapshot vanished mid-call for {jean_session_id}"))?;
    let provider = binding.provider;
    let prompt_image = supervisor::prompt_image_supported(app, provider).await;

    let prior_acp_id = binding.acp_session_id;
    let log = Arc::new(SessionLog::open(app, &jean_session_id)?);
    supervisor::register_session_log(app, provider, prior_acp_id.clone(), log).await?;

    let config_options = if supervisor::session_resume_supported(app, provider).await {
        let response = supervisor::resume_session(app, provider, prior_acp_id.clone(), cwd_path)
            .await
            .map_err(|e| {
                format!(
                    "session/resume failed for jean session {jean_session_id} \
                     (acp id {prior_acp_id}): {e}. Refusing to silently start \
                     a fresh session."
                )
            })?;
        serde_json::to_value(&response.config_options).unwrap_or(Value::Null)
    } else if supervisor::load_session_supported(app, provider).await {
        let response = supervisor::load_session(app, provider, prior_acp_id.clone(), cwd_path)
            .await
            .map_err(|e| {
                format!(
                    "session/load failed for jean session {jean_session_id} \
                     (acp id {prior_acp_id}): {e}. Refusing to silently start \
                     a fresh session."
                )
            })?;
        serde_json::to_value(&response.config_options).unwrap_or(Value::Null)
    } else {
        return Err(format!(
            "ACP provider {provider} does not advertise sessionCapabilities.resume or loadSession; \
             cannot restore jean session {jean_session_id} without losing prior conversation context."
        ));
    };

    let state = session_state::refresh_session(
        app,
        &jean_session_id,
        provider,
        &prior_acp_id,
        config_options,
        prompt_image,
    )
    .await?;
    let log_path = session_state::events_path(app, &jean_session_id)?;

    Ok(OpenSessionResult {
        session_id: state.session_id,
        provider: state.provider,
        config_options: state.config_options,
        available_commands: state.available_commands,
        log_path: log_path.to_string_lossy().to_string(),
        resumed: true,
        title: state.title,
        prompt_image,
    })
}

async fn create_fresh_session(
    app: &AppHandle,
    provider: AcpProvider,
    jean_session_id: String,
    cwd_path: PathBuf,
) -> Result<OpenSessionResult, String> {
    let response = supervisor::create_session(app, provider, cwd_path.clone()).await?;
    let session_id_str = response.session_id.0.as_ref().to_string();
    let prompt_image = supervisor::prompt_image_supported(app, provider).await;

    session_state::seed_new_session(
        app,
        jean_session_id.clone(),
        provider,
        session_id_str.clone(),
        serde_json::to_value(&response.config_options).unwrap_or(Value::Null),
        prompt_image,
    )
    .await?;
    session_state::reset_events_file(app, &jean_session_id)?;
    let log = Arc::new(SessionLog::open(app, &jean_session_id)?);

    log.append(
        Direction::ClientToAgent,
        &serde_json::json!({
            "method": "session/new",
            "params": { "cwd": cwd_path },
        }),
    );
    if let Ok(v) = serde_json::to_value(&response) {
        log.append(
            Direction::AgentToClient,
            &serde_json::json!({ "method": "session/new", "result": v }),
        );
    }

    let state =
        supervisor::register_session_log(app, provider, session_id_str.clone(), log).await?;
    let log_path = session_state::events_path(app, &jean_session_id)?;

    Ok(OpenSessionResult {
        session_id: state.session_id,
        provider: state.provider,
        config_options: state.config_options,
        available_commands: state.available_commands,
        log_path: log_path.to_string_lossy().to_string(),
        resumed: false,
        title: state.title,
        prompt_image,
    })
}

fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    let cwd_path = PathBuf::from(cwd);
    if cwd.is_empty() || !cwd_path.is_absolute() {
        return Err(format!(
            "ACP session cwd must be an absolute path; got {cwd:?}"
        ));
    }
    Ok(cwd_path)
}

fn validate_create_status(status: &PairStatus, jean_session_id: &str) -> Result<(), String> {
    if let Some(err) = status.corruption_error(jean_session_id) {
        return Err(err);
    }
    if matches!(status, PairStatus::Both) {
        return Err(format!(
            "ACP session already exists for jean session {jean_session_id}; use resume instead"
        ));
    }
    Ok(())
}

fn validate_resume_status(status: &PairStatus, jean_session_id: &str) -> Result<(), String> {
    if let Some(err) = status.corruption_error(jean_session_id) {
        return Err(err);
    }
    if matches!(status, PairStatus::Neither) {
        return Err(format!(
            "ACP session does not exist for jean session {jean_session_id}; create it first"
        ));
    }
    Ok(())
}

async fn jean_session_txn(jean_session_id: &str) -> Arc<Mutex<()>> {
    if let Some(txn) = JEAN_SESSION_TXNS.read().await.get(jean_session_id).cloned() {
        return txn;
    }
    let mut txns = JEAN_SESSION_TXNS.write().await;
    txns.entry(jean_session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

//! Chat-to-chat delegation through Jean MCP `send_chat_message`.
//!
//! A chat session (the lead) that sends work to another session (a child)
//! gets the end of that run back as a message queued into its own session.
//! The link lives on the child's metadata (`delegated_by`) and is armed by
//! the MCP send; the first run end after that records an outcome on the link
//! and disarms it. Runs the user starts by typing in the child, and runs
//! started by queued update messages, are not armed and never report. If the
//! child was busy when the MCP message arrived, the link stays armed and the
//! run that was already going reports instead.
//!
//! Outcomes reach the lead in batches: when a child ends and no sibling is
//! still working, every outcome not yet reported goes into one queued
//! message. A child that needs the user (plan approval, question) is reported
//! at once. The update turn runs without the recap instruction; the user
//! follows the children in the lead's sub-session panel.

use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::run_log::load_session_messages_window;
use super::storage::{list_all_session_ids, load_metadata, with_existing_metadata_mut};
use super::types::{
    DelegationOutcome, DelegationStatus, MessageRole, RunStatus, SessionDelegation, SessionMetadata,
};

/// Longest chain a chat session may extend: a direct send is hop 1.
pub const MAX_HOPS: u8 = 3;
const REPLY_CHARS: usize = 1500;
const UPDATE_HEADER: &str = "[Jean session update]";
const UPDATE_FOOTER: &str =
    "Use read_session_messages for a full transcript. Reply briefly; the user \
                             sees sub-session status in the side panel.";

/// One flush at a time, so two children ending together cannot both collect
/// the same outcomes into two updates.
static FLUSH: Mutex<()> = Mutex::new(());

/// Record `origin` as the sender of `target`'s next run and arm the report.
///
/// The origin's own armed link counts toward the depth: a session that is
/// currently working for someone extends that chain, a session whose link was
/// already reported (or that was never sent work) starts a new one at hop 1.
/// Fails past [`MAX_HOPS`], and while the target is still armed for a
/// different origin. The same origin may re-arm its own target; an outcome it
/// has not received yet stays on the link. A different origin first hands
/// the previous lead that outcome.
pub fn arm(
    app: &AppHandle,
    origin: &SessionMetadata,
    target_session_id: &str,
) -> Result<(), String> {
    if origin.id == target_session_id {
        return Ok(());
    }
    let hop = origin
        .delegated_by
        .as_ref()
        .filter(|link| link.armed)
        .map_or(0, |link| link.hop)
        .saturating_add(1);
    if hop > MAX_HOPS {
        return Err(format!(
            "Delegation depth limit reached: this session is already {MAX_HOPS} hops from the \
             session that started the chain, so it cannot send work to another session."
        ));
    }
    let previous =
        load_metadata(app, target_session_id)?.and_then(|metadata| metadata.delegated_by);
    if let Some(previous) = previous
        .as_ref()
        .filter(|link| link.origin_session_id != origin.id && pending_outcome(link).is_some())
    {
        flush_lead(app, &previous.origin_session_id, true)?;
    }
    let link = SessionDelegation {
        origin_session_id: origin.id.clone(),
        origin_worktree_id: origin.worktree_id.clone(),
        hop,
        armed: true,
        created_at: now(),
        outcome: None,
    };
    with_existing_metadata_mut(app, target_session_id, |metadata| {
        let current = metadata.delegated_by.as_ref();
        if current.is_some_and(|current| current.armed && current.origin_session_id != origin.id) {
            return Err(format!(
                "Session {target_session_id} is already working for another session; wait for \
                 its result or use a different session."
            ));
        }
        let outcome = current
            .filter(|current| current.origin_session_id == origin.id)
            .and_then(|current| current.outcome.clone());
        metadata.delegated_by = Some(SessionDelegation { outcome, ..link });
        Ok(())
    })?
}

/// A run of `session_id` ended (any exit). Record it on the link when the
/// link is armed and hand the lead its update when the batch is ready.
/// Idempotent: the link is disarmed under the metadata lock before anything
/// is sent, so a second call for the same run end does nothing. A session
/// whose last run is still live keeps its link.
pub fn report_run_end(app: &AppHandle, session_id: &str, error: Option<&str>) {
    let armed = load_metadata(app, session_id)
        .ok()
        .flatten()
        .is_some_and(|metadata| {
            metadata
                .delegated_by
                .as_ref()
                .is_some_and(|link| link.armed)
        });
    if !armed {
        return;
    }
    if let Err(e) = report_armed_run_end(app, session_id, error) {
        log::warn!("[Delegation] report for session {session_id} failed: {e}");
    }
}

fn report_armed_run_end(
    app: &AppHandle,
    session_id: &str,
    error: Option<&str>,
) -> Result<(), String> {
    if super::registry::is_session_actively_managed(session_id) {
        return Ok(());
    }
    let reply = last_reply(app, session_id);
    let Some((lead_id, status)) = with_existing_metadata_mut(app, session_id, |metadata| {
        record_run_end(metadata, error, &reply)
    })?
    else {
        return Ok(());
    };
    log::info!(
        "[Delegation] recorded {} of session {session_id} for lead {lead_id}",
        status.label()
    );
    flush_lead(app, &lead_id, status.needs_user())
}

/// Disarm (or keep armed for a waiting outcome) and record the run end on the
/// link. `None` when nothing is owed: no armed link, or the last run is still
/// live.
fn record_run_end(
    metadata: &mut SessionMetadata,
    error: Option<&str>,
    reply: &str,
) -> Option<(String, DelegationStatus)> {
    let last_run = metadata.runs.last();
    if last_run.is_some_and(|run| matches!(run.status, RunStatus::Running | RunStatus::Resumable)) {
        return None;
    }
    let status = if metadata.waiting_for_input || metadata.has_pending_plan_waiting() {
        match metadata.waiting_for_input_type.as_deref() {
            Some("plan") => DelegationStatus::WaitingPlan,
            _ => DelegationStatus::Question,
        }
    } else if error.is_some()
        || last_run.is_some_and(|run| run.status == RunStatus::Crashed || run.provider_rejected)
    {
        DelegationStatus::Failed
    } else if last_run.is_some_and(|run| run.status == RunStatus::Cancelled) {
        DelegationStatus::Cancelled
    } else {
        DelegationStatus::Done
    };
    let error = match (status, error) {
        (DelegationStatus::Failed, Some(text)) => Some(text.to_string()),
        (DelegationStatus::Failed, None) if last_run.is_some_and(|run| run.provider_rejected) => {
            Some("the provider rejected the request before any output".to_string())
        }
        (DelegationStatus::Failed, None) => Some("the run crashed before finishing".to_string()),
        _ => None,
    };

    let link = metadata.delegated_by.as_mut().filter(|link| link.armed)?;
    link.armed = status.needs_user();
    let mut body = error
        .map(|error| format!("Error: {error}"))
        .unwrap_or_default();
    if !reply.is_empty() {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(reply);
    }
    link.outcome = Some(DelegationOutcome {
        status,
        body,
        ended_at: now(),
        reported_at: None,
    });
    Some((link.origin_session_id.clone(), status))
}

/// Queue one update into `lead_id` carrying every outcome its children have
/// not reported yet. Held back while a child is still working, unless
/// `immediate`. Outcomes are marked reported before the push: a crash in
/// between loses that update, the other order would resend it on every
/// restart.
fn flush_lead(app: &AppHandle, lead_id: &str, immediate: bool) -> Result<(), String> {
    let _one_at_a_time = FLUSH.lock().unwrap_or_else(PoisonError::into_inner);
    let children = children_of(app, lead_id)?;
    if !immediate && children.iter().any(is_working) {
        log::info!("[Delegation] lead {lead_id} still has working sub-sessions; update held");
        return Ok(());
    }
    let mut pending: Vec<(&SessionMetadata, &DelegationOutcome)> = children
        .iter()
        .filter_map(|child| Some((child, pending_outcome(child.delegated_by.as_ref()?)?)))
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    pending.sort_by_key(|(child, outcome)| (outcome.ended_at, child.id.clone()));

    let reported_at = now();
    for (child, _) in &pending {
        with_existing_metadata_mut(app, &child.id, |metadata| {
            if let Some(outcome) = metadata
                .delegated_by
                .as_mut()
                .and_then(|link| link.outcome.as_mut())
            {
                outcome.reported_at = Some(reported_at);
            }
        })?;
    }

    let Some(lead) = load_metadata(app, lead_id)? else {
        log::info!("[Delegation] lead session {lead_id} is gone; dropping its update");
        return Ok(());
    };
    if lead.archived_at.is_some() {
        log::info!("[Delegation] lead session {lead_id} is closed; dropping its update");
        return Ok(());
    }
    // The lead may have moved worktrees since it sent the work.
    let projects = crate::projects::storage::load_projects_data(app)?;
    let Some(worktree) = projects
        .find_worktree(&lead.worktree_id)
        .filter(|worktree| worktree.archived_at.is_none())
    else {
        log::info!(
            "[Delegation] lead worktree {} is gone; dropping update for {lead_id}",
            lead.worktree_id
        );
        return Ok(());
    };

    let text = update_text(&pending);
    super::commands::push_queued_message(
        app,
        worktree.id.clone(),
        worktree.path.clone(),
        lead.id.clone(),
        queued_message(text),
    )?;
    log::info!(
        "[Delegation] reported {} sub-session(s) to lead {lead_id}",
        pending.len()
    );
    Ok(())
}

fn pending_outcome(link: &SessionDelegation) -> Option<&DelegationOutcome> {
    link.outcome
        .as_ref()
        .filter(|outcome| outcome.reported_at.is_none())
}

/// Armed and not waiting for the user: the lead's batch waits for it.
fn is_working(child: &SessionMetadata) -> bool {
    child.delegated_by.as_ref().is_some_and(|link| link.armed)
        && !child.waiting_for_input
        && !child.has_pending_plan_waiting()
}

fn children_of(app: &AppHandle, lead_id: &str) -> Result<Vec<SessionMetadata>, String> {
    let mut children = Vec::new();
    for session_id in list_all_session_ids(app)? {
        let Some(metadata) = load_metadata(app, &session_id).ok().flatten() else {
            continue;
        };
        let is_child = metadata.id != lead_id
            && metadata
                .delegated_by
                .as_ref()
                .is_some_and(|link| link.origin_session_id == lead_id);
        if is_child {
            children.push(metadata);
        }
    }
    Ok(children)
}

/// Runs that ended while Jean was closed reported nothing, and outcomes
/// recorded right before a crash reached no lead. Called once after startup
/// recovery; live runs keep their link and report when they end. Converges:
/// a second sweep finds nothing armed and nothing pending.
pub fn report_armed_links_on_startup(app: &AppHandle) {
    let session_ids = match list_all_session_ids(app) {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("[Delegation] startup sweep could not list sessions: {e}");
            return;
        }
    };
    let mut leads = BTreeSet::new();
    for session_id in session_ids {
        let Some(link) = load_metadata(app, &session_id)
            .ok()
            .flatten()
            .and_then(|metadata| metadata.delegated_by)
        else {
            continue;
        };
        if link.armed {
            report_run_end(app, &session_id, None);
        }
        if pending_outcome(&link).is_some() {
            leads.insert(link.origin_session_id);
        }
    }
    for lead_id in leads {
        if let Err(e) = flush_lead(app, &lead_id, false) {
            log::warn!("[Delegation] startup flush for lead {lead_id} failed: {e}");
        }
    }
}

/// Reports the run end when dropped, so a resume tail reports on every exit.
pub(crate) struct ReportRunEnd {
    app: AppHandle,
    session_id: String,
}

impl ReportRunEnd {
    pub(crate) fn new(app: AppHandle, session_id: String) -> Self {
        Self { app, session_id }
    }
}

impl Drop for ReportRunEnd {
    fn drop(&mut self) {
        report_run_end(&self.app, &self.session_id, None);
    }
}

/// The message the lead receives: one header block per child, then the
/// footer. The frontend parses the header lines of every block.
fn update_text(children: &[(&SessionMetadata, &DelegationOutcome)]) -> String {
    let blocks: Vec<String> = children
        .iter()
        .map(|(child, outcome)| {
            format!(
                "{UPDATE_HEADER}\nsession: {}\nworktree: {}\nname: {}\nstatus: {}\n---\n{}",
                child.id,
                child.worktree_id,
                child.name,
                outcome.status.label(),
                outcome.body
            )
        })
        .collect();
    format!("{}\n\n{UPDATE_FOOTER}", blocks.join("\n\n"))
}

/// Last non-empty assistant reply of the session's last run, truncated.
fn last_reply(app: &AppHandle, session_id: &str) -> String {
    load_session_messages_window(app, session_id, Some(1), None)
        .ok()
        .and_then(|loaded| {
            loaded
                .messages
                .into_iter()
                .rev()
                .find(|m| m.role == MessageRole::Assistant && !m.content.trim().is_empty())
        })
        .map(|m| truncate(&m.content, REPLY_CHARS))
        .unwrap_or_default()
}

/// A queued message without attachments; model, mode and backend are left
/// unset so the lead's own selections apply. `includeRecap: false` keeps the
/// recap table out of the update turn.
fn queued_message(text: String) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "message": text,
        "pendingImages": [],
        "pendingFiles": [],
        "pendingSkills": [],
        "pendingTextFiles": [],
        "includeRecap": false,
    })
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::commands::queued_message_to_send_request;
    use crate::chat::run_log::{start_run, RunLogWriter};
    use crate::chat::storage::save_metadata;

    const FOOTER: &str = "Use read_session_messages for a full transcript. Reply briefly; the user sees sub-session status in the side panel.";

    /// App with one worktree `wt` so a lead's queue can be found.
    fn app() -> (tempfile::TempDir, AppHandle) {
        let temp = tempfile::tempdir().unwrap();
        let app = AppHandle::new(temp.path().to_path_buf(), temp.path().to_path_buf()).unwrap();
        let worktree = serde_json::from_value(json!({
            "id": "wt", "project_id": "project", "name": "base",
            "path": temp.path().to_string_lossy(), "branch": "main",
            "created_at": 1, "session_type": "base"
        }))
        .unwrap();
        crate::projects::storage::save_projects_data(
            &app,
            &crate::projects::types::ProjectsData {
                projects: vec![],
                worktrees: vec![worktree],
            },
        )
        .unwrap();
        (temp, app)
    }

    /// Lead whose drain holds (waiting for input), so queued updates stay
    /// visible to the test instead of being sent.
    fn origin(app: &AppHandle, id: &str) -> SessionMetadata {
        let mut metadata =
            SessionMetadata::new(id.to_string(), "wt".to_string(), "Origin".to_string(), 0);
        metadata.waiting_for_input = true;
        metadata.waiting_for_input_type = Some("question".to_string());
        save_metadata(app, &metadata).unwrap();
        metadata
    }

    fn child(app: &AppHandle, id: &str) -> SessionMetadata {
        let metadata =
            SessionMetadata::new(id.to_string(), "wt".to_string(), "Child".to_string(), 1);
        save_metadata(app, &metadata).unwrap();
        metadata
    }

    fn start(app: &AppHandle, session_id: &str, prompt: &str) -> RunLogWriter {
        let mut writer = start_run(
            app,
            session_id,
            "wt",
            "Child",
            1,
            "user-1",
            prompt,
            None,
            Some("build"),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        writer
            .write_line(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed the bug."}]}}"#,
            )
            .unwrap();
        writer
    }

    fn completed_run(app: &AppHandle, session_id: &str) {
        let mut writer = start(app, session_id, "fix it");
        writer.complete("asst-1", None, None).unwrap();
    }

    fn wait_for(app: &AppHandle, session_id: &str, kind: Option<&str>) {
        with_existing_metadata_mut(app, session_id, |metadata| {
            metadata.waiting_for_input = kind.is_some();
            metadata.waiting_for_input_type = kind.map(str::to_string);
        })
        .unwrap();
    }

    fn queue(app: &AppHandle, session_id: &str) -> Vec<Value> {
        load_metadata(app, session_id)
            .unwrap()
            .unwrap()
            .queued_messages
    }

    fn messages(app: &AppHandle, session_id: &str) -> Vec<String> {
        queue(app, session_id)
            .iter()
            .map(|m| m["message"].as_str().unwrap().to_string())
            .collect()
    }

    fn link(app: &AppHandle, session_id: &str) -> Option<SessionDelegation> {
        load_metadata(app, session_id)
            .unwrap()
            .unwrap()
            .delegated_by
    }

    fn block(session_id: &str, status: &str, body: &str) -> String {
        format!(
            "[Jean session update]\nsession: {session_id}\nworktree: wt\nname: Child\nstatus: {status}\n---\n{body}"
        )
    }

    #[test]
    fn arm_records_link_with_next_hop() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        let recorded = link(&app, "child").unwrap();
        assert_eq!(recorded.origin_session_id, "root");
        assert_eq!(recorded.origin_worktree_id, "wt");
        assert_eq!(recorded.hop, 1);
        assert!(recorded.armed);
        assert_eq!(recorded.outcome, None);

        // The child, still working for root, delegates further: one hop deeper.
        child(&app, "grandchild");
        let mid = load_metadata(&app, "child").unwrap().unwrap();
        arm(&app, &mid, "grandchild").unwrap();
        assert_eq!(link(&app, "grandchild").unwrap().hop, 2);

        // The same origin re-arms its own target.
        arm(&app, &mid, "grandchild").unwrap();
        assert_eq!(link(&app, "grandchild").unwrap().hop, 2);
        assert!(link(&app, "grandchild").unwrap().armed);
    }

    #[test]
    fn arm_rejects_a_fourth_active_link_and_itself() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        for id in ["a", "b", "c", "d"] {
            child(&app, id);
        }
        arm(&app, &root, "a").unwrap();
        let a = load_metadata(&app, "a").unwrap().unwrap();
        arm(&app, &a, "b").unwrap();
        let b = load_metadata(&app, "b").unwrap().unwrap();
        arm(&app, &b, "c").unwrap();
        let c = load_metadata(&app, "c").unwrap().unwrap();
        assert_eq!(link(&app, "c").unwrap().hop, 3);

        let error = arm(&app, &c, "d").unwrap_err();
        assert!(error.contains("3 hops"), "{error}");
        assert_eq!(link(&app, "d"), None);

        arm(&app, &c, "c").unwrap();
        assert_eq!(
            link(&app, "c").unwrap().hop,
            3,
            "self-send leaves the link alone"
        );
    }

    #[test]
    fn hop_counts_only_while_the_caller_is_armed() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "a");
        child(&app, "b");
        arm(&app, &root, "a").unwrap();

        // Ping-pong: a, still working for root, sends back to root.
        let a = load_metadata(&app, "a").unwrap().unwrap();
        arm(&app, &a, "root").unwrap();
        assert_eq!(link(&app, "root").unwrap().hop, 2);

        // a's run ends and reports, so a no longer works for anyone.
        completed_run(&app, "a");
        report_run_end(&app, "a", None);
        assert!(!link(&app, "a").unwrap().armed);

        // The update-driven run in a starts a fresh chain.
        let a = load_metadata(&app, "a").unwrap().unwrap();
        arm(&app, &a, "b").unwrap();
        assert_eq!(link(&app, "b").unwrap().hop, 1);

        // Same for a session whose link was never armed again after disarming,
        // three disarmed hops deep: it is a root.
        let mut stale = origin(&app, "stale");
        stale.delegated_by = Some(SessionDelegation {
            origin_session_id: "above".to_string(),
            origin_worktree_id: "wt".to_string(),
            hop: 3,
            armed: false,
            created_at: 1,
            outcome: None,
        });
        save_metadata(&app, &stale).unwrap();
        child(&app, "fresh");
        arm(&app, &stale, "fresh").unwrap();
        assert_eq!(link(&app, "fresh").unwrap().hop, 1);
    }

    #[tokio::test]
    async fn second_origin_is_refused_while_armed_and_allowed_after_report() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        let other = origin(&app, "other");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();

        let error = arm(&app, &other, "child").unwrap_err();
        assert_eq!(
            error,
            "Session child is already working for another session; wait for its result or use \
             a different session."
        );
        let kept = link(&app, "child").unwrap();
        assert_eq!(kept.origin_session_id, "root");
        assert!(kept.armed);

        completed_run(&app, "child");
        report_run_end(&app, "child", None);
        assert_eq!(queue(&app, "root").len(), 1);

        arm(&app, &other, "child").unwrap();
        let replaced = link(&app, "child").unwrap();
        assert_eq!(replaced.origin_session_id, "other");
        assert!(replaced.armed);
        assert_eq!(
            replaced.outcome, None,
            "root's outcome does not follow the link"
        );
        completed_run(&app, "child");
        report_run_end(&app, "child", None);
        assert_eq!(queue(&app, "other").len(), 1);
        assert_eq!(queue(&app, "root").len(), 1, "root got nothing new");
    }

    #[tokio::test]
    async fn get_session_returns_the_origin_name() {
        let (temp, app) = app();
        let path = temp.path().to_string_lossy().to_string();
        let create = |name: &str| {
            crate::chat::create_session(
                app.clone(),
                "wt".to_string(),
                path.clone(),
                Some(name.to_string()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
        };
        let origin_id = create("Planner").await.unwrap().id;
        let child_id = create("Worker").await.unwrap().id;
        let origin = load_metadata(&app, &origin_id).unwrap().unwrap();
        arm(&app, &origin, &child_id).unwrap();

        let session = crate::chat::get_session(app.clone(), "wt".to_string(), path, child_id, None)
            .await
            .unwrap();
        let delegated_by = session.delegated_by.unwrap();
        assert_eq!(delegated_by.origin_session_id, origin_id);
        assert_eq!(delegated_by.origin_worktree_id, "wt");
        assert_eq!(delegated_by.origin_name.as_deref(), Some("Planner"));
    }

    #[tokio::test]
    async fn session_lists_and_mutations_return_the_lead_link() {
        let (temp, app) = app();
        let path = temp.path().to_string_lossy().to_string();
        let create = |name: &str| {
            crate::chat::create_session(
                app.clone(),
                "wt".to_string(),
                path.clone(),
                Some(name.to_string()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
        };
        let origin_id = create("Planner").await.unwrap().id;
        let child_id = create("Worker").await.unwrap().id;
        let origin = load_metadata(&app, &origin_id).unwrap().unwrap();
        arm(&app, &origin, &child_id).unwrap();

        let summary =
            crate::chat::list_sessions_summary(app.clone(), "wt".to_string(), path.clone())
                .await
                .unwrap();
        let sessions = summary["sessions"].as_array().unwrap();
        let worker = sessions.iter().find(|s| s["id"] == child_id).unwrap();
        assert_eq!(
            worker["delegatedBy"],
            json!({
                "origin_session_id": origin_id,
                "origin_worktree_id": "wt",
                "origin_name": "Planner",
            })
        );
        let planner = sessions.iter().find(|s| s["id"] == origin_id).unwrap();
        assert!(planner["delegatedBy"].is_null());

        // The child's run end shows up on the session the client lists.
        completed_run(&app, &child_id);
        report_run_end(&app, &child_id, None);
        let listed = crate::chat::storage::with_sessions_mut(&app, &path, "wt", |sessions| {
            Ok(sessions.find_session(&child_id).cloned())
        })
        .unwrap()
        .unwrap();
        let delegated_by = listed.delegated_by.unwrap();
        assert_eq!(delegated_by.origin_name.as_deref(), Some("Planner"));
        let outcome = delegated_by.outcome.unwrap();
        assert_eq!(outcome.status, DelegationStatus::Done);
        assert_eq!(outcome.body, "Fixed the bug.");
        assert!(outcome.reported_at.is_some());
    }

    #[tokio::test]
    async fn armed_run_end_enqueues_one_update_without_recap_and_disarms() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");

        report_run_end(&app, "child", None);
        report_run_end(&app, "child", None);

        let queued = queue(&app, "root");
        assert_eq!(queued.len(), 1, "{queued:?}");
        assert_eq!(
            queued[0]["message"],
            format!("{}\n\n{FOOTER}", block("child", "done", "Fixed the bug."))
        );
        assert!(queued[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
        for key in [
            "pendingImages",
            "pendingFiles",
            "pendingSkills",
            "pendingTextFiles",
        ] {
            assert_eq!(queued[0][key], json!([]), "{key}");
        }
        assert_eq!(queued[0]["includeRecap"], json!(false));
        let request = queued_message_to_send_request(&app, &queued[0])
            .await
            .unwrap();
        assert_eq!(request.include_recap, Some(false));

        let recorded = link(&app, "child").unwrap();
        assert!(!recorded.armed);
        let outcome = recorded.outcome.unwrap();
        assert_eq!(outcome.status, DelegationStatus::Done);
        assert!(outcome.reported_at.is_some());
    }

    #[tokio::test]
    async fn siblings_report_in_one_update_when_the_last_one_ends() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "a");
        child(&app, "b");
        arm(&app, &root, "a").unwrap();
        arm(&app, &root, "b").unwrap();

        completed_run(&app, "a");
        report_run_end(&app, "a", None);
        assert_eq!(queue(&app, "root"), Vec::<Value>::new(), "b still works");
        let a = link(&app, "a").unwrap();
        assert!(!a.armed);
        assert_eq!(a.outcome.unwrap().reported_at, None);

        let mut writer = start(&app, "b", "fix it");
        writer.cancel(Some("asst-1"), None).unwrap();
        report_run_end(&app, "b", Some("claude exited with status 1"));

        assert_eq!(
            messages(&app, "root"),
            vec![format!(
                "{}\n\n{}\n\n{FOOTER}",
                block("a", "done", "Fixed the bug."),
                block(
                    "b",
                    "failed",
                    "Error: claude exited with status 1\n\nFixed the bug."
                )
            )]
        );
        for id in ["a", "b"] {
            let recorded = link(&app, id).unwrap();
            assert!(!recorded.armed, "{id}");
            assert!(recorded.outcome.unwrap().reported_at.is_some(), "{id}");
        }

        // A later run end on an unarmed child adds nothing.
        completed_run(&app, "a");
        report_run_end(&app, "a", None);
        assert_eq!(queue(&app, "root").len(), 1);
    }

    #[tokio::test]
    async fn a_child_that_needs_the_user_reports_at_once_with_pending_siblings() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "a");
        child(&app, "b");
        child(&app, "c");
        for id in ["a", "b", "c"] {
            arm(&app, &root, id).unwrap();
        }
        completed_run(&app, "a");
        report_run_end(&app, "a", None);
        assert_eq!(queue(&app, "root").len(), 0);

        completed_run(&app, "b");
        wait_for(&app, "b", Some("plan"));
        report_run_end(&app, "b", None);

        assert_eq!(
            messages(&app, "root"),
            vec![format!(
                "{}\n\n{}\n\n{FOOTER}",
                block("a", "done", "Fixed the bug."),
                block("b", "waiting_plan", "Fixed the bug.")
            )]
        );
        assert!(link(&app, "b").unwrap().armed, "waiting re-arms");
        assert!(link(&app, "c").unwrap().armed, "c still works");

        // c ends: b waits for the user, so it does not hold the batch.
        completed_run(&app, "c");
        report_run_end(&app, "c", None);
        assert_eq!(
            messages(&app, "root")[1],
            format!("{}\n\n{FOOTER}", block("c", "done", "Fixed the bug."))
        );

        // The user approved and b's next run finished.
        wait_for(&app, "b", None);
        completed_run(&app, "b");
        report_run_end(&app, "b", None);
        assert!(!link(&app, "b").unwrap().armed);
        assert_eq!(
            messages(&app, "root")[2],
            format!("{}\n\n{FOOTER}", block("b", "done", "Fixed the bug."))
        );
        assert_eq!(queue(&app, "root").len(), 3);
    }

    #[tokio::test]
    async fn question_reports_with_question_status() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        wait_for(&app, "child", Some("question"));
        report_run_end(&app, "child", None);
        assert!(messages(&app, "root")[0].contains("\nstatus: question\n"));
        assert!(link(&app, "child").unwrap().armed);
    }

    #[tokio::test]
    async fn unarmed_run_end_enqueues_nothing() {
        let (_temp, app) = app();
        origin(&app, "root");
        let mut unlinked = child(&app, "typed");
        completed_run(&app, "typed");
        report_run_end(&app, "typed", None);

        unlinked.delegated_by = Some(SessionDelegation {
            origin_session_id: "root".to_string(),
            origin_worktree_id: "wt".to_string(),
            hop: 1,
            armed: false,
            created_at: 1,
            outcome: None,
        });
        save_metadata(&app, &unlinked).unwrap();
        report_run_end(&app, "typed", None);

        assert_eq!(queue(&app, "root"), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn cancelled_and_crashed_runs_map_to_their_status() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "cancelled");
        arm(&app, &root, "cancelled").unwrap();
        let mut writer = start(&app, "cancelled", "fix it");
        writer.cancel(Some("asst-1"), None).unwrap();
        report_run_end(&app, "cancelled", None);

        child(&app, "crashed");
        arm(&app, &root, "crashed").unwrap();
        let mut writer = start(&app, "crashed", "fix it");
        writer.crash().unwrap();
        report_run_end(&app, "crashed", None);

        let messages = messages(&app, "root");
        let statuses: Vec<&str> = messages
            .iter()
            .map(|m| {
                m.lines()
                    .find_map(|line| line.strip_prefix("status: "))
                    .unwrap()
            })
            .collect();
        assert_eq!(statuses, vec!["cancelled", "failed"]);
        assert!(
            messages[1].contains("---\nError: the run crashed before finishing\n\nFixed the bug.")
        );
    }

    #[tokio::test]
    async fn live_run_keeps_the_link_and_reports_nothing() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "busy");
        arm(&app, &root, "busy").unwrap();
        let _writer = start(&app, "busy", "still going");

        // The MCP send was rejected because the session was busy.
        report_run_end(&app, "busy", Some("Session already has an active request"));

        assert_eq!(queue(&app, "root"), Vec::<Value>::new());
        let kept = link(&app, "busy").unwrap();
        assert!(kept.armed);
        assert_eq!(kept.outcome, None);
    }

    #[tokio::test]
    async fn archived_origin_is_skipped_and_the_outcome_reported() {
        let (_temp, app) = app();
        let mut root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        root.archived_at = Some(5);
        save_metadata(&app, &root).unwrap();

        report_run_end(&app, "child", None);

        assert_eq!(queue(&app, "root"), Vec::<Value>::new());
        let recorded = link(&app, "child").unwrap();
        assert!(!recorded.armed);
        assert!(recorded.outcome.unwrap().reported_at.is_some());
    }

    #[tokio::test]
    async fn missing_origin_is_skipped() {
        let (temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        crate::chat::purge_session(&app, "wt", &temp.path().to_string_lossy(), "root").unwrap();

        report_run_end(&app, "child", None);
        assert!(!link(&app, "child").unwrap().armed);
    }

    #[tokio::test]
    async fn another_lead_gets_its_pending_outcome_before_the_link_moves() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        let other = origin(&app, "other");
        child(&app, "a");
        child(&app, "b");
        arm(&app, &root, "a").unwrap();
        arm(&app, &root, "b").unwrap();
        completed_run(&app, "a");
        report_run_end(&app, "a", None);
        assert_eq!(queue(&app, "root").len(), 0, "held for b");

        arm(&app, &other, "a").unwrap();

        assert_eq!(
            messages(&app, "root"),
            vec![format!(
                "{}\n\n{FOOTER}",
                block("a", "done", "Fixed the bug.")
            )]
        );
        let moved = link(&app, "a").unwrap();
        assert_eq!(moved.origin_session_id, "other");
        assert_eq!(moved.outcome, None);
    }

    #[tokio::test]
    async fn startup_sweep_holds_for_live_runs_and_converges() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "finished");
        arm(&app, &root, "finished").unwrap();
        completed_run(&app, "finished");
        child(&app, "running");
        arm(&app, &root, "running").unwrap();
        let mut writer = start(&app, "running", "still going");
        child(&app, "typed");
        completed_run(&app, "typed");

        report_armed_links_on_startup(&app);
        report_armed_links_on_startup(&app);

        assert_eq!(
            queue(&app, "root"),
            Vec::<Value>::new(),
            "running holds the batch"
        );
        let finished = link(&app, "finished").unwrap();
        assert!(!finished.armed);
        assert_eq!(finished.outcome.unwrap().reported_at, None);
        assert!(link(&app, "running").unwrap().armed);
        assert_eq!(link(&app, "typed"), None);

        writer.complete("asst-1", None, None).unwrap();
        report_run_end(&app, "running", None);
        assert_eq!(
            messages(&app, "root"),
            vec![format!(
                "{}\n\n{}\n\n{FOOTER}",
                block("finished", "done", "Fixed the bug."),
                block("running", "done", "Fixed the bug.")
            )]
        );
    }

    #[tokio::test]
    async fn startup_sweep_sends_outcomes_recorded_before_a_crash() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "a");
        child(&app, "b");
        arm(&app, &root, "a").unwrap();
        arm(&app, &root, "b").unwrap();
        completed_run(&app, "a");
        completed_run(&app, "b");
        // Both outcomes were recorded, then Jean died before the flush.
        for id in ["a", "b"] {
            with_existing_metadata_mut(&app, id, |metadata| {
                record_run_end(metadata, None, "Fixed the bug.");
            })
            .unwrap();
        }
        assert_eq!(queue(&app, "root"), Vec::<Value>::new());

        report_armed_links_on_startup(&app);
        report_armed_links_on_startup(&app);

        assert_eq!(
            messages(&app, "root"),
            vec![format!(
                "{}\n\n{}\n\n{FOOTER}",
                block("a", "done", "Fixed the bug."),
                block("b", "done", "Fixed the bug.")
            )]
        );
    }

    #[test]
    fn reply_is_truncated_to_the_limit() {
        let mut metadata = SessionMetadata::new(
            "child".to_string(),
            "wt".to_string(),
            "Child".to_string(),
            1,
        );
        metadata.delegated_by = Some(SessionDelegation {
            origin_session_id: "root".to_string(),
            origin_worktree_id: "wt".to_string(),
            hop: 1,
            armed: true,
            created_at: 1,
            outcome: None,
        });
        let long = "x".repeat(REPLY_CHARS + 10);
        record_run_end(&mut metadata, None, &truncate(&long, REPLY_CHARS)).unwrap();
        let outcome = metadata
            .delegated_by
            .as_ref()
            .unwrap()
            .outcome
            .as_ref()
            .unwrap();
        let text = update_text(&[(&metadata, outcome)]);
        let body = text.split_once("---\n").unwrap().1;
        assert!(body.starts_with(&"x".repeat(REPLY_CHARS)));
        assert!(body.ends_with(&format!("…\n\n{FOOTER}")));
    }
}

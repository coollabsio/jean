//! Chat-to-chat delegation through Jean MCP `send_chat_message`.
//!
//! A chat session that sends work to another session gets the end of that
//! run back as a message queued into its own session. The link lives on the
//! child's metadata (`delegated_by`) and is armed by the MCP send; the first
//! run end after that reports and disarms it. Runs the user starts by typing
//! in the child, and runs started by queued update messages, are not armed
//! and never report. If the child was busy when the MCP message arrived, the
//! link stays armed and the run that was already going reports instead.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::run_log::load_session_messages_window;
use super::storage::{list_all_session_ids, load_metadata, with_existing_metadata_mut};
use super::types::{MessageRole, RunStatus, SessionDelegation, SessionMetadata};

/// Longest chain a chat session may extend: a direct send is hop 1.
pub const MAX_HOPS: u8 = 3;
const REPLY_CHARS: usize = 1500;
const UPDATE_HEADER: &str = "[Jean session update]";
const TRANSCRIPT_HINT: &str = "Use read_session_messages for the full transcript.";

/// Record `origin` as the sender of `target`'s next run and arm the report.
///
/// The origin's own armed link counts toward the depth: a session that is
/// currently working for someone extends that chain, a session whose link was
/// already reported (or that was never sent work) starts a new one at hop 1.
/// Fails past [`MAX_HOPS`], and while the target is still armed for a
/// different origin. The same origin may re-arm its own target.
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
    let link = SessionDelegation {
        origin_session_id: origin.id.clone(),
        origin_worktree_id: origin.worktree_id.clone(),
        hop,
        armed: true,
        created_at: now(),
    };
    with_existing_metadata_mut(app, target_session_id, |metadata| {
        let armed_for_other = metadata
            .delegated_by
            .as_ref()
            .is_some_and(|current| current.armed && current.origin_session_id != origin.id);
        if armed_for_other {
            return Err(format!(
                "Session {target_session_id} is already working for another session; wait for \
                 its result or use a different session."
            ));
        }
        metadata.delegated_by = Some(link);
        Ok(())
    })?
}

/// Outcome of a finished run, as reported to the origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Done,
    Failed,
    Cancelled,
    WaitingPlan,
    Question,
}

impl Outcome {
    fn label(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::WaitingPlan => "waiting_plan",
            Self::Question => "question",
        }
    }

    /// The user still has to answer, so the run after their answer reports too.
    fn keeps_link_armed(self) -> bool {
        matches!(self, Self::WaitingPlan | Self::Question)
    }
}

/// What the child's metadata said when its armed link was taken.
struct RunEnd {
    origin_session_id: String,
    session_id: String,
    worktree_id: String,
    name: String,
    outcome: Outcome,
    error: Option<String>,
}

/// A run of `session_id` ended (any exit). Report it to the origin when the
/// link is armed. Idempotent: the link is disarmed under the metadata lock
/// before anything is sent, so a second call for the same run end does
/// nothing. A session whose last run is still live keeps its link.
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
    let Some(run_end) =
        with_existing_metadata_mut(app, session_id, |metadata| take_run_end(metadata, error))?
    else {
        return Ok(());
    };

    let Some(origin) = load_metadata(app, &run_end.origin_session_id)? else {
        log::info!(
            "[Delegation] origin session {} is gone; dropping update from {session_id}",
            run_end.origin_session_id
        );
        return Ok(());
    };
    if origin.archived_at.is_some() {
        log::info!(
            "[Delegation] origin session {} is closed; dropping update from {session_id}",
            origin.id
        );
        return Ok(());
    }
    // The origin may have moved worktrees since it sent the work.
    let projects = crate::projects::storage::load_projects_data(app)?;
    let Some(worktree) = projects
        .find_worktree(&origin.worktree_id)
        .filter(|worktree| worktree.archived_at.is_none())
    else {
        log::info!(
            "[Delegation] origin worktree {} is gone; dropping update from {session_id}",
            origin.worktree_id
        );
        return Ok(());
    };

    let reply = last_reply(app, session_id);
    let text = update_text(&run_end, &reply);
    super::commands::push_queued_message(
        app,
        worktree.id.clone(),
        worktree.path.clone(),
        origin.id.clone(),
        queued_message(text),
    )?;
    log::info!(
        "[Delegation] reported {} of session {session_id} to origin {}",
        run_end.outcome.label(),
        origin.id
    );
    Ok(())
}

/// Disarm (or keep armed for a waiting outcome) and describe the run end.
/// `None` when nothing is owed: no armed link, or the last run is still live.
fn take_run_end(metadata: &mut SessionMetadata, error: Option<&str>) -> Option<RunEnd> {
    let last_run = metadata.runs.last();
    if last_run.is_some_and(|run| matches!(run.status, RunStatus::Running | RunStatus::Resumable)) {
        return None;
    }
    let outcome = if metadata.waiting_for_input || metadata.has_pending_plan_waiting() {
        match metadata.waiting_for_input_type.as_deref() {
            Some("plan") => Outcome::WaitingPlan,
            _ => Outcome::Question,
        }
    } else if error.is_some()
        || last_run.is_some_and(|run| run.status == RunStatus::Crashed || run.provider_rejected)
    {
        Outcome::Failed
    } else if last_run.is_some_and(|run| run.status == RunStatus::Cancelled) {
        Outcome::Cancelled
    } else {
        Outcome::Done
    };
    let error = match (outcome, error) {
        (Outcome::Failed, Some(text)) => Some(text.to_string()),
        (Outcome::Failed, None) if last_run.is_some_and(|run| run.provider_rejected) => {
            Some("the provider rejected the request before any output".to_string())
        }
        (Outcome::Failed, None) => Some("the run crashed before finishing".to_string()),
        _ => None,
    };

    let link = metadata.delegated_by.as_mut().filter(|link| link.armed)?;
    link.armed = outcome.keeps_link_armed();
    Some(RunEnd {
        origin_session_id: link.origin_session_id.clone(),
        session_id: metadata.id.clone(),
        worktree_id: metadata.worktree_id.clone(),
        name: metadata.name.clone(),
        outcome,
        error,
    })
}

/// Runs that ended while Jean was closed reported nothing. Called once after
/// startup recovery; live runs keep their link and report when they end.
pub fn report_armed_links_on_startup(app: &AppHandle) {
    let session_ids = match list_all_session_ids(app) {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("[Delegation] startup sweep could not list sessions: {e}");
            return;
        }
    };
    for session_id in session_ids {
        report_run_end(app, &session_id, None);
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

/// The message the origin receives. The frontend parses the header lines.
fn update_text(run_end: &RunEnd, reply: &str) -> String {
    let mut body = String::new();
    if let Some(error) = &run_end.error {
        body.push_str(&format!("Error: {error}\n\n"));
    }
    if !reply.is_empty() {
        body.push_str(reply);
        body.push_str("\n\n");
    }
    body.push_str(TRANSCRIPT_HINT);
    format!(
        "{UPDATE_HEADER}\nsession: {}\nworktree: {}\nname: {}\nstatus: {}\n---\n{body}",
        run_end.session_id,
        run_end.worktree_id,
        run_end.name,
        run_end.outcome.label()
    )
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
/// unset so the origin's own selections apply.
fn queued_message(text: String) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "message": text,
        "pendingImages": [],
        "pendingFiles": [],
        "pendingSkills": [],
        "pendingTextFiles": [],
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
    use crate::chat::run_log::{start_run, RunLogWriter};
    use crate::chat::storage::save_metadata;

    /// App with one worktree `wt` so an origin's queue can be found.
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

    /// Origin whose drain holds (waiting for input), so queued updates stay
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

    fn queue(app: &AppHandle, session_id: &str) -> Vec<Value> {
        load_metadata(app, session_id)
            .unwrap()
            .unwrap()
            .queued_messages
    }

    fn link(app: &AppHandle, session_id: &str) -> Option<SessionDelegation> {
        load_metadata(app, session_id)
            .unwrap()
            .unwrap()
            .delegated_by
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
    async fn armed_run_end_enqueues_one_update_and_disarms() {
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
            "[Jean session update]\nsession: child\nworktree: wt\nname: Child\nstatus: done\n---\nFixed the bug.\n\nUse read_session_messages for the full transcript."
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
        assert!(!link(&app, "child").unwrap().armed);
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
        });
        save_metadata(&app, &unlinked).unwrap();
        report_run_end(&app, "typed", None);

        assert_eq!(queue(&app, "root"), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn failed_run_reports_the_error_and_the_partial_reply() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        let mut writer = start(&app, "child", "fix it");
        writer.cancel(Some("asst-1"), None).unwrap();

        report_run_end(&app, "child", Some("claude exited with status 1"));

        let queued = queue(&app, "root");
        assert_eq!(queued.len(), 1);
        assert_eq!(
            queued[0]["message"],
            "[Jean session update]\nsession: child\nworktree: wt\nname: Child\nstatus: failed\n---\nError: claude exited with status 1\n\nFixed the bug.\n\nUse read_session_messages for the full transcript."
        );
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

        let queued = queue(&app, "root");
        let statuses: Vec<&str> = queued
            .iter()
            .map(|m| {
                m["message"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .find_map(|line| line.strip_prefix("status: "))
                    .unwrap()
            })
            .collect();
        assert_eq!(statuses, vec!["cancelled", "failed"]);
        assert!(queued[1]["message"]
            .as_str()
            .unwrap()
            .contains("Error: the run crashed before finishing"));
    }

    #[tokio::test]
    async fn waiting_plan_reports_and_keeps_the_link_armed() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        with_existing_metadata_mut(&app, "child", |metadata| {
            metadata.waiting_for_input = true;
            metadata.waiting_for_input_type = Some("plan".to_string());
        })
        .unwrap();

        report_run_end(&app, "child", None);
        assert!(link(&app, "child").unwrap().armed, "waiting re-arms");
        let first = queue(&app, "root");
        assert_eq!(first.len(), 1);
        assert!(first[0]["message"]
            .as_str()
            .unwrap()
            .contains("\nstatus: waiting_plan\n"));

        // The user approved and the next run finished.
        with_existing_metadata_mut(&app, "child", |metadata| {
            metadata.waiting_for_input = false;
            metadata.waiting_for_input_type = None;
        })
        .unwrap();
        completed_run(&app, "child");
        report_run_end(&app, "child", None);
        assert!(!link(&app, "child").unwrap().armed);
        let second = queue(&app, "root");
        assert_eq!(second.len(), 2);
        assert!(second[1]["message"]
            .as_str()
            .unwrap()
            .contains("\nstatus: done\n"));
    }

    #[tokio::test]
    async fn question_reports_with_question_status() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        with_existing_metadata_mut(&app, "child", |metadata| {
            metadata.waiting_for_input = true;
            metadata.waiting_for_input_type = Some("question".to_string());
        })
        .unwrap();
        report_run_end(&app, "child", None);
        let queued = queue(&app, "root");
        assert!(queued[0]["message"]
            .as_str()
            .unwrap()
            .contains("\nstatus: question\n"));
        assert!(link(&app, "child").unwrap().armed);
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
        assert!(link(&app, "busy").unwrap().armed);
    }

    #[tokio::test]
    async fn archived_origin_is_skipped_and_the_link_disarmed() {
        let (_temp, app) = app();
        let mut root = origin(&app, "root");
        child(&app, "child");
        arm(&app, &root, "child").unwrap();
        completed_run(&app, "child");
        root.archived_at = Some(5);
        save_metadata(&app, &root).unwrap();

        report_run_end(&app, "child", None);

        assert_eq!(queue(&app, "root"), Vec::<Value>::new());
        assert!(!link(&app, "child").unwrap().armed);
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
    async fn startup_sweep_reports_finished_children_once() {
        let (_temp, app) = app();
        let root = origin(&app, "root");
        child(&app, "finished");
        arm(&app, &root, "finished").unwrap();
        completed_run(&app, "finished");
        child(&app, "running");
        arm(&app, &root, "running").unwrap();
        let _writer = start(&app, "running", "still going");
        child(&app, "typed");
        completed_run(&app, "typed");

        report_armed_links_on_startup(&app);
        report_armed_links_on_startup(&app);

        let queued = queue(&app, "root");
        assert_eq!(queued.len(), 1, "{queued:?}");
        assert!(queued[0]["message"]
            .as_str()
            .unwrap()
            .starts_with("[Jean session update]\nsession: finished\n"));
        assert!(!link(&app, "finished").unwrap().armed);
        assert!(link(&app, "running").unwrap().armed);
        assert_eq!(link(&app, "typed"), None);
    }

    #[test]
    fn reply_is_truncated_to_the_limit() {
        let run_end = RunEnd {
            origin_session_id: "root".to_string(),
            session_id: "child".to_string(),
            worktree_id: "wt".to_string(),
            name: "Child".to_string(),
            outcome: Outcome::Done,
            error: None,
        };
        let long = "x".repeat(REPLY_CHARS + 10);
        let text = update_text(&run_end, &truncate(&long, REPLY_CHARS));
        let body = text.split_once("---\n").unwrap().1;
        assert!(body.starts_with(&"x".repeat(REPLY_CHARS)));
        assert!(body.contains("…\n\nUse read_session_messages"));
    }
}

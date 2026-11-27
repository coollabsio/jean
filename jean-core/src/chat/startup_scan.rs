//! The one pass over session metadata at startup. It fills the run-state
//! index, restores scheduled wakeups, repairs runs a crash left unfinished,
//! resumes the ones still alive, and reports delegated runs that ended while
//! Jean was closed.
//!
//! The pass runs on a blocking thread so the caller returns at once. The
//! index stays "loading" until the pass ends, so `get_run_states`,
//! `check_resumable_sessions` and `/api/init` wait for its result.

use tauri::AppHandle;

use super::run_state_index::{LoadClaim, RunStateIndex};
use super::types::{SessionDelegation, SessionMetadata};
use super::wakeup::PersistedWakeup;

/// What the startup consumers need from session metadata.
#[derive(Default)]
pub struct StartupScan {
    pub wakeups: Vec<PersistedWakeup>,
    /// Every delegation link, keyed by the delegated session.
    pub delegations: Vec<(String, SessionDelegation)>,
}

impl StartupScan {
    fn visit(&mut self, metadata: &SessionMetadata) {
        if let Some(wakeup) = &metadata.scheduled_wakeup {
            self.wakeups.push(PersistedWakeup {
                session_id: metadata.id.clone(),
                worktree_id: metadata.worktree_id.clone(),
                wakeup: wakeup.clone(),
            });
        }
        if let Some(link) = &metadata.delegated_by {
            self.delegations.push((metadata.id.clone(), link.clone()));
        }
    }

    /// Read every session's metadata once. Also fills the run-state index.
    pub fn collect(app: &AppHandle) -> Result<Self, String> {
        let mut scan = Self::default();
        super::storage::scan_all_metadata(app, |metadata| scan.visit(metadata))?;
        Ok(scan)
    }
}

/// Start the startup pass in the background. The index is claimed before
/// this returns, so a reader that arrives first waits for the pass instead of
/// scanning on its own.
pub fn start(app: &AppHandle) {
    let claim = RunStateIndex::for_app(app).claim_load();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&app, claim));
}

/// Resolves when the startup pass has ended. The headless server awaits this
/// before it accepts clients.
pub async fn finished(app: &AppHandle) -> Result<(), String> {
    super::run_state_index::loaded_index(app).await.map(|_| ())
}

fn run(app: &AppHandle, claim: Option<LoadClaim>) {
    let started = std::time::Instant::now();
    let scan = match StartupScan::collect(app) {
        Ok(scan) => scan,
        Err(error) => {
            log::warn!("Startup session scan failed: {error}");
            return;
        }
    };
    let scanned = started.elapsed();
    super::wakeup::restore(scan.wakeups);
    // Finish runs orphaned by a crash/reboot before any client is answered.
    // Headless servers otherwise only recover on a full page load, so an
    // open web tab that just reconnects keeps showing the dead run as running.
    // Runs whose detached host survived the restart are resumed here, by the
    // server that owns them, so a headless server with no client (or only a
    // native desktop connected remotely) keeps tailing them.
    let unfinished = RunStateIndex::for_app(app).unfinished_session_ids();
    match super::run_log::recover_incomplete_runs_for(app, unfinished) {
        Ok(recovered) => super::resume_recovered_runs(app.clone(), recovered),
        Err(error) => log::warn!("Failed to recover incomplete runs: {error}"),
    }
    // Delegated runs that ended while Jean was closed still owe their origin
    // an update. Live runs were just resumed above and report when they end.
    super::delegation::report_armed_links_on_startup(app, scan.delegations);
    if let Some(claim) = claim {
        claim.finish();
    }
    log::info!(
        "Startup session pass took {:?} (metadata scan {scanned:?})",
        started.elapsed()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::registry;
    use crate::chat::run_log::{start_run, RunLogWriter};
    use crate::chat::storage::{
        delete_session_data, load_metadata, save_metadata, with_existing_metadata_mut,
    };
    use crate::chat::types::{RunState, RunStateStatus, RunStatus, ScheduledWakeup};
    use crate::chat::{check_resumable_sessions, get_run_states};

    fn new_app(dir: &std::path::Path) -> AppHandle {
        AppHandle::new(dir.to_path_buf(), dir.to_path_buf()).unwrap()
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn start(app: &AppHandle, session_id: &str) -> RunLogWriter {
        start_run(
            app,
            session_id,
            "wt",
            "Session",
            0,
            "user-1",
            "hi",
            None,
            Some("build"),
            None,
            None,
            None,
            None,
        )
        .unwrap()
    }

    fn session(app: &AppHandle, session_id: &str) {
        save_metadata(
            app,
            &SessionMetadata::new(session_id.into(), "wt".into(), "Session".into(), 0),
        )
        .unwrap();
    }

    fn sorted(mut states: Vec<RunState>) -> Vec<RunState> {
        states.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        states
    }

    fn statuses(states: &[RunState]) -> Vec<(&str, RunStateStatus)> {
        states
            .iter()
            .map(|state| (state.session_id.as_str(), state.status))
            .collect()
    }

    /// `get_run_states` as it was before the index: list the data directory
    /// and parse every metadata file on each call.
    fn disk_scan_run_states(app: &AppHandle, session_ids: Option<Vec<String>>) -> Vec<RunState> {
        let explicit = session_ids.is_some();
        let session_ids =
            session_ids.unwrap_or_else(|| crate::chat::storage::list_all_session_ids(app).unwrap());
        let managed = registry::get_actively_managed_sessions();
        let mut loaded = Vec::new();
        let mut to_repair = Vec::new();
        for session_id in session_ids {
            if let Ok(Some(metadata)) = load_metadata(app, &session_id) {
                let unfinished = metadata
                    .runs
                    .iter()
                    .any(|run| matches!(run.status, RunStatus::Running | RunStatus::Resumable));
                if unfinished && !managed.contains(&session_id) {
                    to_repair.push(session_id);
                }
                loaded.push(metadata);
            }
        }
        crate::chat::run_log::recover_incomplete_runs_for(app, to_repair.clone()).unwrap();
        for metadata in &mut loaded {
            if to_repair.contains(&metadata.id) {
                *metadata = load_metadata(app, &metadata.id).unwrap().unwrap();
            }
        }
        loaded
            .into_iter()
            .map(|metadata| metadata.run_state(managed.contains(&metadata.id)))
            .filter(|state| explicit || state.status.is_live())
            .collect()
    }

    #[test]
    fn run_states_follow_run_start_completion_cancel_and_delete() {
        let _registry = registry::TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app = new_app(temp.path());
        let ids = || Some(vec!["done".to_string(), "stopped".to_string()]);
        block_on(async {
            // The index is loaded from an empty directory here. Every later
            // answer can only come from the writes that follow.
            assert_eq!(get_run_states(app.clone(), None).await.unwrap(), vec![]);

            let mut done = start(&app, "done");
            let mut stopped = start(&app, "stopped");
            assert!(registry::register_process("done".into(), u32::MAX));
            assert!(registry::register_process("stopped".into(), u32::MAX - 1));
            let running = sorted(get_run_states(app.clone(), None).await.unwrap());
            assert_eq!(
                statuses(&running),
                vec![
                    ("done", RunStateStatus::Running),
                    ("stopped", RunStateStatus::Running)
                ]
            );
            assert_eq!(running[0].run_id.as_deref(), Some(done.run_id()));
            assert_eq!(running[0].execution_mode.as_deref(), Some("build"));

            done.complete("asst-1", None, None).unwrap();
            stopped.cancel(None, None).unwrap();
            registry::cleanup_session_registrations("done");
            registry::cleanup_session_registrations("stopped");

            let finished = get_run_states(app.clone(), ids()).await.unwrap();
            assert_eq!(
                statuses(&finished),
                vec![
                    ("done", RunStateStatus::Idle),
                    ("stopped", RunStateStatus::Cancelled)
                ]
            );
            assert_eq!(finished[0].status_version, 1);
            assert_eq!(finished[1].status_version, 1);
            assert_eq!(finished, disk_scan_run_states(&app, ids()));
            assert_eq!(get_run_states(app.clone(), None).await.unwrap(), vec![]);

            with_existing_metadata_mut(&app, "done", |metadata| {
                metadata.waiting_for_input = true;
                metadata.waiting_for_input_type = Some("question".into());
            })
            .unwrap();
            delete_session_data(&app, "stopped").unwrap();
            let remaining = get_run_states(app.clone(), ids()).await.unwrap();
            assert_eq!(statuses(&remaining), vec![("done", RunStateStatus::Idle)]);
            assert!(remaining[0].waiting_for_input);
            assert_eq!(
                remaining[0].waiting_for_input_type.as_deref(),
                Some("question")
            );
        });
    }

    /// Sessions in every run state, plus a directory with no metadata and one
    /// with a corrupt file.
    fn fixture(app: &AppHandle) -> Vec<String> {
        session(app, "no-runs");
        start(app, "completed")
            .complete("asst-1", None, None)
            .unwrap();
        start(app, "cancelled").cancel(None, None).unwrap();
        start(app, "crashed").mark_crashed().unwrap();
        drop(start(app, "orphan"));
        start(app, "codex").set_codex_ids("thread-1", None).unwrap();
        start(app, "managed").set_pid(u32::MAX).unwrap();
        // An unfinished run that is not the latest one.
        drop(start(app, "old-orphan"));
        start(app, "old-orphan")
            .complete("asst-2", None, None)
            .unwrap();
        session(app, "waiting");
        with_existing_metadata_mut(app, "waiting", |metadata| {
            metadata.waiting_for_input = true;
            metadata.waiting_for_input_type = Some("plan".into());
        })
        .unwrap();
        let data_dir = crate::chat::storage::get_data_dir(app).unwrap();
        std::fs::create_dir_all(data_dir.join("empty-dir")).unwrap();
        std::fs::create_dir_all(data_dir.join("corrupt")).unwrap();
        std::fs::write(data_dir.join("corrupt/metadata.json"), "{ not json").unwrap();
        [
            "no-runs",
            "completed",
            "cancelled",
            "crashed",
            "orphan",
            "codex",
            "managed",
            "old-orphan",
            "waiting",
            "empty-dir",
            "corrupt",
            "never-existed",
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn get_run_states_matches_the_disk_scan_after_a_restart() {
        let _registry = registry::TEST_LOCK.lock().unwrap();
        let index_dir = tempfile::tempdir().unwrap();
        let disk_dir = tempfile::tempdir().unwrap();
        let ids = fixture(&new_app(index_dir.path()));
        fixture(&new_app(disk_dir.path()));
        // New handles hold no index: this is what a restarted Jean sees.
        let indexed = new_app(index_dir.path());
        let on_disk = new_app(disk_dir.path());
        assert!(registry::register_process("managed".into(), u32::MAX));

        let (live, explicit) = block_on(async {
            (
                sorted(get_run_states(indexed.clone(), None).await.unwrap()),
                get_run_states(indexed.clone(), Some(ids.clone()))
                    .await
                    .unwrap(),
            )
        });
        let disk_live = sorted(disk_scan_run_states(&on_disk, None));
        let disk_explicit = disk_scan_run_states(&on_disk, Some(ids));
        registry::cleanup_session_registrations("managed");

        // Run ids are random per fixture, so compare everything else.
        let comparable = |states: &[RunState]| -> Vec<RunState> {
            states
                .iter()
                .cloned()
                .map(|mut state| {
                    state.run_id = state.run_id.map(|_| "run".into());
                    state.started_at = state.started_at.map(|_| 1);
                    state
                })
                .collect()
        };
        assert_eq!(comparable(&live), comparable(&disk_live));
        assert_eq!(comparable(&explicit), comparable(&disk_explicit));
        assert_eq!(
            statuses(&live),
            vec![
                ("codex", RunStateStatus::Resumable),
                ("managed", RunStateStatus::Running)
            ]
        );
        assert_eq!(
            statuses(&explicit),
            vec![
                ("no-runs", RunStateStatus::Idle),
                ("completed", RunStateStatus::Idle),
                ("cancelled", RunStateStatus::Cancelled),
                ("crashed", RunStateStatus::Error),
                ("orphan", RunStateStatus::Error),
                ("codex", RunStateStatus::Resumable),
                ("managed", RunStateStatus::Running),
                ("old-orphan", RunStateStatus::Idle),
                ("waiting", RunStateStatus::Idle),
            ]
        );
    }

    #[test]
    fn one_startup_pass_feeds_wakeups_recovery_delegation_and_run_states() {
        let _registry = registry::TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let writer = new_app(temp.path());

        session(&writer, "sleeper");
        with_existing_metadata_mut(&writer, "sleeper", |metadata| {
            metadata.scheduled_wakeup = Some(ScheduledWakeup {
                fire_at_unix: u64::MAX,
                scheduled_at_unix: 1,
                delay_seconds: 60,
                prompt: "wake".into(),
                reason: "test".into(),
                tool_call_id: "tool-1".into(),
            });
        })
        .unwrap();
        drop(start(&writer, "orphan"));
        start(&writer, "codex")
            .set_codex_ids("thread-1", None)
            .unwrap();
        session(&writer, "lead");
        let lead = load_metadata(&writer, "lead").unwrap().unwrap();
        start(&writer, "child")
            .complete("asst-1", None, None)
            .unwrap();
        crate::chat::delegation::arm(&writer, &lead, "child").unwrap();

        // A restarted Jean: nothing in memory, one pass over the disk.
        let app = new_app(temp.path());
        let mut visits = std::collections::BTreeMap::new();
        crate::chat::storage::scan_all_metadata(&app, |metadata| {
            *visits.entry(metadata.id.clone()).or_insert(0) += 1;
        })
        .unwrap();
        assert_eq!(
            visits.into_iter().collect::<Vec<_>>(),
            ["child", "codex", "lead", "orphan", "sleeper"].map(|id| (id.to_string(), 1))
        );

        let app = new_app(temp.path());
        let index = RunStateIndex::for_app(&app);
        let claim = index.claim_load();
        assert!(claim.is_some());
        assert!(index.claim_load().is_none(), "one pass owns the load");
        assert!(!index.is_loaded(), "readers wait until the pass ends");
        // The pass spawns the codex resume on this runtime; it is dropped
        // with the runtime, unpolled.
        block_on(async { run(&app, claim) });
        assert!(index.is_loaded());

        let pending: Vec<String> = crate::chat::wakeup::list_pending()
            .into_iter()
            .filter(|entry| entry.session_id == "sleeper")
            .map(|entry| entry.wakeup.prompt)
            .collect();
        crate::chat::wakeup::cancel(&app, "sleeper").unwrap();
        assert_eq!(pending, vec!["wake".to_string()]);

        let status = |session_id: &str| {
            let metadata = load_metadata(&app, session_id).unwrap().unwrap();
            metadata.runs[0].status.clone()
        };
        assert_eq!(status("orphan"), RunStatus::Crashed);
        assert_eq!(status("codex"), RunStatus::Resumable);

        let link = load_metadata(&app, "child")
            .unwrap()
            .unwrap()
            .delegated_by
            .unwrap();
        assert!(!link.armed);
        assert!(link.outcome.is_some());

        let (live, resumable) = block_on(async {
            (
                get_run_states(app.clone(), None).await.unwrap(),
                check_resumable_sessions(app.clone()).await.unwrap(),
            )
        });
        assert_eq!(statuses(&live), vec![("codex", RunStateStatus::Resumable)]);
        assert_eq!(
            resumable
                .iter()
                .map(|run| (run.session_id.as_str(), run.resumable))
                .collect::<Vec<_>>(),
            vec![("codex", true)]
        );
    }

    #[test]
    fn a_reader_that_arrives_during_the_pass_waits_for_its_result() {
        let _registry = registry::TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        start(&new_app(temp.path()), "codex")
            .set_codex_ids("thread-1", None)
            .unwrap();

        let app = new_app(temp.path());
        let claim = RunStateIndex::for_app(&app).claim_load();
        let reader_app = app.clone();
        let reader = std::thread::spawn(move || {
            block_on(async { get_run_states(reader_app, None).await.unwrap() })
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!reader.is_finished(), "no answer before the pass ends");

        block_on(async { run(&app, claim) });
        let states = reader.join().unwrap();
        assert_eq!(
            statuses(&states),
            vec![("codex", RunStateStatus::Resumable)]
        );
    }

    /// Timing on a copy of a real data directory. Set `JEAN_PERF_DATA_DIR` to
    /// a directory that holds `sessions/data`; it is copied, never written.
    /// `cargo test --release --lib startup_scan::tests::timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_on_a_copy_of_a_real_data_dir() {
        let Some(source) = std::env::var_os("JEAN_PERF_DATA_DIR") else {
            return;
        };
        let _registry = registry::TEST_LOCK.lock().unwrap();
        let copy = || {
            let temp = tempfile::tempdir().unwrap();
            let status = std::process::Command::new("cp")
                .arg("-a")
                .arg(std::path::Path::new(&source).join("sessions"))
                .arg(temp.path())
                .status()
                .unwrap();
            assert!(status.success());
            temp
        };
        let timed = |label: &str, work: &mut dyn FnMut() -> usize| {
            let started = std::time::Instant::now();
            let count = work();
            eprintln!("TIMING {label}: {:?} ({count} items)", started.elapsed());
        };

        let old_dir = copy();
        let old = new_app(old_dir.path());
        let mut old_states = Vec::new();
        for round in 0..3 {
            timed(
                &format!("old get_run_states(None) disk scan #{round}"),
                &mut || {
                    old_states = sorted(disk_scan_run_states(&old, None));
                    old_states.len()
                },
            );
        }

        let new_dir = copy();
        let app = new_app(new_dir.path());
        let mut claim = RunStateIndex::for_app(&app).claim_load();
        let scan_dir = copy();
        let scan_app = new_app(scan_dir.path());
        timed("new startup: metadata scan only", &mut || {
            let scan = StartupScan::collect(&scan_app).unwrap();
            scan.delegations.len() + scan.wakeups.len()
        });
        timed(
            "new startup pass (scan, wakeups, recovery, delegation)",
            &mut || {
                block_on(async { run(&app, claim.take()) });
                RunStateIndex::for_app(&app).snapshot(None).len()
            },
        );
        timed("new check_resumable_sessions", &mut || {
            block_on(check_resumable_sessions(app.clone()))
                .unwrap()
                .len()
        });
        let mut new_states = Vec::new();
        for round in 0..3 {
            timed(&format!("new get_run_states(None) #{round}"), &mut || {
                new_states = sorted(block_on(get_run_states(app.clone(), None)).unwrap());
                new_states.len()
            });
        }
        assert_eq!(new_states, old_states);
    }
}

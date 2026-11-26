//! In-memory copy of every session's persisted run state.
//!
//! `storage` records each metadata write and delete here, under the session's
//! metadata lock, so an entry always matches the file. The one disk scan that
//! fills it is the startup pass (`startup_scan`), or the first reader when no
//! startup pass ran (tests, tools).

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use tauri::AppHandle;

use super::types::{PersistedRunState, SessionMetadata};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Load {
    NotStarted,
    Running,
    Done,
}

pub struct RunStateIndex {
    sessions: Mutex<HashMap<String, PersistedRunState>>,
    load: Mutex<Load>,
    load_changed: Condvar,
}

/// Exclusive right to fill the index. Readers wait until it is finished.
/// Dropped unfinished (a failed or panicked scan), the next reader scans.
pub struct LoadClaim {
    index: Arc<RunStateIndex>,
    finished: bool,
}

impl LoadClaim {
    pub fn finish(mut self) {
        self.finished = true;
    }
}

impl Drop for LoadClaim {
    fn drop(&mut self) {
        *self.index.load_state() = if self.finished {
            Load::Done
        } else {
            Load::NotStarted
        };
        self.index.load_changed.notify_all();
    }
}

impl RunStateIndex {
    pub fn for_app(app: &AppHandle) -> Arc<Self> {
        let index: &Arc<Self> = &app.state_or_insert_with(|| {
            Arc::new(Self {
                sessions: Mutex::new(HashMap::new()),
                load: Mutex::new(Load::NotStarted),
                load_changed: Condvar::new(),
            })
        });
        index.clone()
    }

    fn sessions(&self) -> MutexGuard<'_, HashMap<String, PersistedRunState>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn load_state(&self) -> MutexGuard<'_, Load> {
        self.load.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Call with the session's metadata lock held, with what is now on disk.
    pub(super) fn record(&self, metadata: &SessionMetadata) {
        self.sessions()
            .insert(metadata.id.clone(), metadata.persisted_run_state());
    }

    /// Call with the session's metadata lock held, after its file is gone.
    pub(super) fn forget(&self, session_id: &str) {
        self.sessions().remove(session_id);
    }

    pub fn is_loaded(&self) -> bool {
        *self.load_state() == Load::Done
    }

    /// Take the load for the startup pass. `None` when a scan already ran or
    /// is running.
    pub fn claim_load(self: &Arc<Self>) -> Option<LoadClaim> {
        let mut load = self.load_state();
        if *load != Load::NotStarted {
            return None;
        }
        *load = Load::Running;
        Some(LoadClaim {
            index: self.clone(),
            finished: false,
        })
    }

    /// Block until the index holds every session on disk. Scans here when no
    /// one else has. Blocking: call from a blocking thread.
    pub fn ensure_loaded(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let claim = {
            let mut load = self.load_state();
            loop {
                match *load {
                    Load::Done => return Ok(()),
                    Load::Running => {
                        load = self
                            .load_changed
                            .wait(load)
                            .unwrap_or_else(PoisonError::into_inner);
                    }
                    Load::NotStarted => {
                        *load = Load::Running;
                        break LoadClaim {
                            index: self.clone(),
                            finished: false,
                        };
                    }
                }
            }
        };
        super::storage::scan_all_metadata(app, |_| {})?;
        claim.finish();
        Ok(())
    }

    /// Entries for `session_ids` in that order, skipping unknown sessions.
    /// `None` returns every session.
    pub fn snapshot(&self, session_ids: Option<&[String]>) -> Vec<PersistedRunState> {
        let sessions = self.sessions();
        match session_ids {
            Some(ids) => ids
                .iter()
                .filter_map(|id| sessions.get(id).cloned())
                .collect(),
            None => sessions.values().cloned().collect(),
        }
    }

    /// Sessions with a Running or Resumable run on disk: the only ones run
    /// recovery can change.
    pub fn unfinished_session_ids(&self) -> Vec<String> {
        self.sessions()
            .values()
            .filter(|state| state.has_unfinished_run)
            .map(|state| state.session_id.clone())
            .collect()
    }
}

/// Sessions with a Running or Resumable run on disk. Waits for the index, so
/// it blocks: call from a blocking thread.
pub fn unfinished_session_ids(app: &AppHandle) -> Result<Vec<String>, String> {
    let index = RunStateIndex::for_app(app);
    index.ensure_loaded(app)?;
    Ok(index.unfinished_session_ids())
}

/// Wait for the index without blocking the async runtime.
pub async fn loaded_index(app: &AppHandle) -> Result<Arc<RunStateIndex>, String> {
    let index = RunStateIndex::for_app(app);
    if index.is_loaded() {
        return Ok(index);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        index.ensure_loaded(&app)?;
        Ok(index)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

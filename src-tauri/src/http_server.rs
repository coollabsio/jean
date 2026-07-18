use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub trait EmitExt {
    fn emit_all<S: Serialize + Clone>(&self, event: &str, payload: &S) -> Result<(), String>;
}

impl EmitExt for AppHandle {
    fn emit_all<S: Serialize + Clone>(&self, event: &str, payload: &S) -> Result<(), String> {
        self.emit(event, payload.clone())
            .map_err(|error| error.to_string())
    }
}

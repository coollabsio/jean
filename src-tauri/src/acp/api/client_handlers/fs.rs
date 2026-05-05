//! `fs/read_text_file` and `fs/write_text_file` client handlers.
//!
//! Agents call these to read/write files via us instead of doing their
//! own filesystem I/O — useful when we have unsaved editor state the
//! agent can't see, or when the agent runs in a sandbox with no FS
//! access of its own. We have neither problem (no editor buffers; full
//! local FS access via Tauri), but advertising the capability is still a
//! win because adapters like `claude-agent-acp` route through us when
//! offered, giving us a single place to log/audit FS traffic.
//!
//! Spec: <https://agentclientprotocol.com/protocol/file-system>
//!
//! Both handlers reject non-absolute paths up front (spec: "All file
//! paths in the protocol MUST be absolute"). Write creates parent
//! directories on demand — spec only requires creating the file itself,
//! but a missing parent dir is the most common failure case in
//! practice and surfacing it as an error would be unhelpful.

use agent_client_protocol::schema::{
    Error, ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use serde_json::Value;
use tauri::AppHandle;

use crate::acp::application::supervisor::log_to_session;
use crate::acp::infrastructure::session_log::Direction;
use crate::acp::provider::AcpProvider;

/// Handle `fs/read_text_file`. Optional `line` (1-based) and `limit`
/// constrain the slice returned; both omitted = whole file.
pub async fn handle_read(
    _app: &AppHandle,
    _provider: AcpProvider,
    request: ReadTextFileRequest,
) -> Result<ReadTextFileResponse, Error> {
    let acp_id = request.session_id.0.as_ref().to_string();
    log_inbound(&acp_id, "fs/read_text_file", &request).await;

    if !request.path.is_absolute() {
        let err = Error::invalid_params().data(Value::String(format!(
            "path must be absolute: {:?}",
            request.path
        )));
        log_response(&acp_id, "fs/read_text_file", Err(&err.message)).await;
        return Err(err);
    }

    let result = read_file(&request).await;
    match &result {
        Ok(resp) => {
            // Don't log the full file body — could be megabytes. Stamp size only.
            let summary = serde_json::json!({ "bytes": resp.content.len() });
            log_response(&acp_id, "fs/read_text_file", Ok(&summary)).await;
        }
        Err(e) => log_response(&acp_id, "fs/read_text_file", Err(&e.message)).await,
    }
    result
}

/// Handle `fs/write_text_file`. Creates parent directories if missing
/// (see module docs).
pub async fn handle_write(
    _app: &AppHandle,
    _provider: AcpProvider,
    request: WriteTextFileRequest,
) -> Result<WriteTextFileResponse, Error> {
    let acp_id = request.session_id.0.as_ref().to_string();
    log_inbound_write(&acp_id, &request).await;

    if !request.path.is_absolute() {
        let err = Error::invalid_params().data(Value::String(format!(
            "path must be absolute: {:?}",
            request.path
        )));
        log_response(&acp_id, "fs/write_text_file", Err(&err.message)).await;
        return Err(err);
    }

    let result = write_file(&request).await;
    match &result {
        Ok(_) => log_response(&acp_id, "fs/write_text_file", Ok(&Value::Null)).await,
        Err(e) => log_response(&acp_id, "fs/write_text_file", Err(&e.message)).await,
    }
    result
}

async fn read_file(request: &ReadTextFileRequest) -> Result<ReadTextFileResponse, Error> {
    let content = tokio::fs::read_to_string(&request.path)
        .await
        .map_err(|e| io_error("read", &request.path.display().to_string(), &e))?;

    // Apply line/limit if either is set. `line` is 1-based per spec; `0`
    // is meaningless and treated the same as `1`. We split on '\n' (not
    // CRLF-aware) since spec gives no normalization rules — preserving
    // the file's original newlines on output.
    let sliced = match (request.line, request.limit) {
        (None, None) => content,
        (line, limit) => {
            let start = line.unwrap_or(1).max(1).saturating_sub(1) as usize;
            let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
            content
                .split_inclusive('\n')
                .skip(start)
                .take(take)
                .collect::<String>()
        }
    };
    Ok(ReadTextFileResponse::new(sliced))
}

async fn write_file(request: &WriteTextFileRequest) -> Result<WriteTextFileResponse, Error> {
    if let Some(parent) = request.path.parent() {
        // Empty parent (root) is a no-op for create_dir_all; only call when
        // the path actually has a parent component to materialize.
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| io_error("create_dir_all", &parent.display().to_string(), &e))?;
        }
    }
    tokio::fs::write(&request.path, &request.content)
        .await
        .map_err(|e| io_error("write", &request.path.display().to_string(), &e))?;
    Ok(WriteTextFileResponse::new())
}

fn io_error(op: &str, path: &str, e: &std::io::Error) -> Error {
    Error::internal_error().data(Value::String(format!("{op} {path}: {e}")))
}

async fn log_inbound<T: serde::Serialize>(acp_id: &str, method: &str, request: &T) {
    if let Ok(v) = serde_json::to_value(request) {
        log_to_session(
            acp_id,
            Direction::AgentToClient,
            &serde_json::json!({ "method": method, "params": v }),
        )
        .await;
    }
}

/// Specialized inbound logger for write — strips the `content` field so
/// we don't bloat the JSONL with full file bodies (could be MB). Stamps
/// `bytes` instead.
async fn log_inbound_write(acp_id: &str, request: &WriteTextFileRequest) {
    let params = serde_json::json!({
        "sessionId": request.session_id.0.as_ref(),
        "path": request.path,
        "bytes": request.content.len(),
    });
    log_to_session(
        acp_id,
        Direction::AgentToClient,
        &serde_json::json!({ "method": "fs/write_text_file", "params": params }),
    )
    .await;
}

async fn log_response(acp_id: &str, method: &str, result: Result<&Value, &str>) {
    let frame = match result {
        Ok(v) => serde_json::json!({ "method": method, "result": v }),
        Err(e) => serde_json::json!({ "method": method, "error": e }),
    };
    log_to_session(acp_id, Direction::ClientToAgent, &frame).await;
}

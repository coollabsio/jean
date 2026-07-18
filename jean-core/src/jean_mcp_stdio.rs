//! Stdio MCP transport for Jean.
//!
//! This process is launched by a local CLI as an MCP server. It proxies
//! tools/call requests over Jean-owned local IPC to the already
//! running desktop app, avoiding HTTP ports while preserving in-process app
//! command dispatch in the parent.

#[cfg(unix)]
use std::io::BufReader;
use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::jean_mcp_core::{
    handle_protocol_message, jsonrpc_error, ToolCallRequest, JEAN_MCP_DEPTH_ENV,
    JEAN_MCP_SESSION_ENV, JEAN_MCP_SOCKET_ENV, JEAN_MCP_TOKEN_ENV,
};

pub fn run_stdio_server() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("Failed to read stdin: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_message(&line);
        if let Some(response) = response {
            let encoded = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to encode MCP response: {e}"))?;
            writeln!(stdout, "{encoded}").map_err(|e| format!("Failed to write stdout: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("Failed to flush stdout: {e}"))?;
        }
    }

    Ok(())
}

fn handle_message(line: &str) -> Option<Value> {
    let body: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(jsonrpc_error(None, -32700, &format!("Parse error: {e}"))),
    };

    handle_protocol_message(body, proxy_tool_call)
}

fn proxy_tool_call(tool_call: ToolCallRequest) -> Result<Value, String> {
    let socket =
        std::env::var(JEAN_MCP_SOCKET_ENV).map_err(|_| format!("Missing {JEAN_MCP_SOCKET_ENV}"))?;
    let token =
        std::env::var(JEAN_MCP_TOKEN_ENV).map_err(|_| format!("Missing {JEAN_MCP_TOKEN_ENV}"))?;
    let source = std::env::var(JEAN_MCP_SESSION_ENV).unwrap_or_else(|_| "anon".to_string());
    let depth = std::env::var(JEAN_MCP_DEPTH_ENV)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    proxy_to_parent(
        &socket,
        json!({
            "token": token,
            "source": source,
            "depth": depth,
            "name": tool_call.name,
            "arguments": tool_call.arguments,
        }),
    )
}
#[cfg(unix)]
fn proxy_to_parent(socket: &str, request: Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Failed to connect Jean MCP socket {socket}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|e| format!("Failed to set Jean MCP socket read timeout: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| format!("Failed to set Jean MCP socket write timeout: {e}"))?;
    let encoded = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to encode Jean MCP socket request: {e}"))?;
    writeln!(stream, "{encoded}").map_err(|e| format!("Failed to write Jean MCP socket: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush Jean MCP socket: {e}"))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read Jean MCP socket response: {e}"))?;
    let response: Value = serde_json::from_str(&line)
        .map_err(|e| format!("Failed to parse Jean MCP socket response: {e}"))?;
    if let Some(error) = parent_error_message(&response) {
        return Err(error);
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(windows)]
fn proxy_to_parent(socket: &str, request: Value) -> Result<Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::runtime::Builder;
    use tokio::time::{timeout, Duration};

    let encoded = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to encode Jean MCP pipe request: {e}"))?;
    let runtime = Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|e| format!("Failed to create Jean MCP pipe runtime: {e}"))?;

    let response = runtime.block_on(async {
        let mut pipe = ClientOptions::new()
            .open(socket)
            .map_err(|e| format!("Failed to connect Jean MCP named pipe {socket}: {e}"))?;
        timeout(Duration::from_secs(30), async {
            pipe.write_all(encoded.as_bytes()).await?;
            pipe.write_all(b"\n").await?;
            pipe.flush().await
        })
        .await
        .map_err(|_| "Timed out writing Jean MCP pipe request".to_string())?
        .map_err(|e| format!("Failed to write Jean MCP pipe request: {e}"))?;

        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        timeout(Duration::from_secs(120), reader.read_line(&mut line))
            .await
            .map_err(|_| "Timed out reading Jean MCP pipe response".to_string())?
            .map_err(|e| format!("Failed to read Jean MCP pipe response: {e}"))?;

        serde_json::from_str::<Value>(&line)
            .map_err(|e| format!("Failed to parse Jean MCP pipe response: {e}"))
    })?;

    if let Some(error) = parent_error_message(&response) {
        return Err(error);
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(not(any(unix, windows)))]
fn proxy_to_parent(_socket: &str, _request: Value) -> Result<Value, String> {
    Err("Jean MCP local IPC is not supported on this platform".to_string())
}

fn parent_error_message(response: &Value) -> Option<String> {
    match response.get("error") {
        Some(Value::String(message)) => Some(message.clone()),
        Some(Value::Object(error)) => error
            .get("message")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| Some(Value::Object(error.clone()).to_string())),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parent_error_message;

    #[test]
    fn parent_error_message_handles_plain_error_string() {
        assert_eq!(
            parent_error_message(&json!({"error": "unauthorized"})),
            Some("unauthorized".to_string())
        );
    }

    #[test]
    fn parent_error_message_handles_jsonrpc_error_object() {
        assert_eq!(
            parent_error_message(&json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32000, "message": "No Jean session context present" }
            })),
            Some("No Jean session context present".to_string())
        );
    }
}

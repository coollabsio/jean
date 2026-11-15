//! Stdio MCP transport for Jean.
//!
//! This process is launched by a local CLI as an MCP server. It proxies
//! tools/call requests over Jean-owned local IPC to the already
//! running desktop app, avoiding HTTP ports while preserving in-process app
//! command dispatch in the parent.

#[cfg(unix)]
use std::io::BufReader;
use std::io::{BufRead, Write};

use std::time::Duration;

use serde_json::{json, Value};

use crate::jean_mcp_core::{
    handle_protocol_message, jsonrpc_error, ToolCallRequest, CLAUDE_PERMISSION_PROMPT_TOOL,
    JEAN_MCP_DEPTH_ENV, JEAN_MCP_SESSION_ENV, JEAN_MCP_SOCKET_ENV, JEAN_MCP_TOKEN_ENV,
};

/// Default wait for a parent response.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
/// Live permission prompts wait for the user; the parent denies them when the
/// run stops, so this only guards against a lost parent.
const PERMISSION_PROMPT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

fn response_timeout(tool_name: &str) -> Duration {
    if tool_name == CLAUDE_PERMISSION_PROMPT_TOOL {
        PERMISSION_PROMPT_TIMEOUT
    } else {
        RESPONSE_TIMEOUT
    }
}

pub fn run_stdio_server() -> Result<(), String> {
    serve(std::io::stdin().lock(), std::io::stdout())
}

fn serve(input: impl BufRead, mut output: impl Write) -> Result<(), String> {
    for line in input.lines() {
        let line = line.map_err(|e| format!("Failed to read stdin: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let Some(response) = handle_message(&line) else {
            continue;
        };
        // A client that closes its end (timeout, abandoned request) ends the
        // session; that is not a failure (issue #894).
        match write_response(&mut output, &response) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(format!("Failed to write stdout: {e}")),
        }
    }

    Ok(())
}

fn write_response(output: &mut impl Write, response: &Value) -> std::io::Result<()> {
    writeln!(output, "{response}")?;
    output.flush()
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
        response_timeout(&tool_call.name),
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
fn proxy_to_parent(
    socket: &str,
    response_timeout: Duration,
    request: Value,
) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Failed to connect Jean MCP socket {socket}: {e}"))?;
    stream
        .set_read_timeout(Some(response_timeout))
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
fn proxy_to_parent(
    socket: &str,
    response_timeout: Duration,
    request: Value,
) -> Result<Value, String> {
    let encoded = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to encode Jean MCP pipe request: {e}"))?;

    // `run_server()` serves stdio inside a Tokio runtime. Starting or dropping
    // another runtime on that thread panics, so use a separate thread.
    let response = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_io()
                    .enable_time()
                    .build()
                    .map_err(|e| format!("Failed to create Jean MCP pipe runtime: {e}"))?
                    .block_on(pipe_round_trip(socket, &encoded, response_timeout))
            })
            .join()
            .map_err(|_| "Jean MCP pipe thread panicked".to_string())?
    })?;

    if let Some(error) = parent_error_message(&response) {
        return Err(error);
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(windows)]
async fn pipe_round_trip(
    socket: &str,
    encoded: &str,
    response_timeout: Duration,
) -> Result<Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::time::timeout;

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
    timeout(response_timeout, reader.read_line(&mut line))
        .await
        .map_err(|_| "Timed out reading Jean MCP pipe response".to_string())?
        .map_err(|e| format!("Failed to read Jean MCP pipe response: {e}"))?;

    serde_json::from_str::<Value>(&line)
        .map_err(|e| format!("Failed to parse Jean MCP pipe response: {e}"))
}

#[cfg(not(any(unix, windows)))]
fn proxy_to_parent(
    _socket: &str,
    _response_timeout: Duration,
    _request: Value,
) -> Result<Value, String> {
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
    use std::io::{self, Write};

    use super::{parent_error_message, serve};

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

    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    const PING: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n";

    #[test]
    fn closed_stdout_ends_session_cleanly() {
        assert_eq!(serve(PING, ClosedPipe), Ok(()));
    }

    #[test]
    fn writes_one_json_line_per_response() {
        let mut out = Vec::new();
        serve(PING, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1);
        let response: serde_json::Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(response["id"], 1);
    }

    /// Regression: the Windows pipe proxy must work inside a Tokio runtime.
    #[cfg(windows)]
    #[test]
    fn proxy_to_parent_works_inside_a_tokio_runtime() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::windows::named_pipe::ServerOptions;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let pipe_name = format!(r"\\.\pipe\jean-mcp-test-{}", std::process::id());
        let mut server = {
            let _guard = runtime.enter();
            ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)
                .unwrap()
        };
        runtime.spawn(async move {
            server.connect().await.unwrap();
            let mut line = String::new();
            BufReader::new(&mut server)
                .read_line(&mut line)
                .await
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let response = json!({ "result": { "echo": request["name"] } });
            server
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        });

        // Same shape as production: `run_server()` is driven by `block_on`.
        let result = runtime
            .block_on(async {
                super::proxy_to_parent(
                    &pipe_name,
                    std::time::Duration::from_secs(10),
                    json!({ "name": "list_projects" }),
                )
            })
            .unwrap();

        assert_eq!(result, json!({ "echo": "list_projects" }));
    }
}

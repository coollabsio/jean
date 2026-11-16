//! Reconnecting reader for the OpenCode 2.x event stream (`GET /api/event`).

use crate::opencode_server::{OpenCodeServer, SERVER_USERNAME};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

pub enum StreamMsg {
    Connected,
    Event(Value),
    Disconnected(String),
}

/// Stops its reader thread when dropped.
pub struct EventStream {
    stop: Arc<AtomicBool>,
    pub rx: Receiver<StreamMsg>,
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Splits an SSE byte stream into the `data:` payload of each event.
#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
    data: String,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(std::mem::take(&mut self.data));
                }
            } else if let Some(payload) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data
                    .push_str(payload.strip_prefix(' ').unwrap_or(payload));
            }
        }
        events
    }
}

pub fn open(server: &OpenCodeServer) -> EventStream {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = channel();
    let server = server.clone();
    let thread_stop = stop.clone();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                let _ = tx.send(StreamMsg::Disconnected(format!("runtime: {e}")));
                return;
            }
        };
        runtime.block_on(read_loop(server, tx, thread_stop));
    });
    EventStream { stop, rx }
}

async fn read_loop(server: OpenCodeServer, tx: Sender<StreamMsg>, stop: Arc<AtomicBool>) {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
    else {
        let _ = tx.send(StreamMsg::Disconnected("HTTP client".to_string()));
        return;
    };
    let url = format!("{}/api/event", server.url);
    while !stop.load(Ordering::SeqCst) {
        let reason = match client
            .get(&url)
            .basic_auth(SERVER_USERNAME, server.password.as_deref())
            .header("Accept", "text/event-stream")
            .send()
            .await
        {
            Ok(mut response) if response.status().is_success() => {
                if tx.send(StreamMsg::Connected).is_err() {
                    return;
                }
                let mut decoder = SseDecoder::default();
                loop {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    match tokio::time::timeout(Duration::from_millis(200), response.chunk()).await {
                        Err(_) => continue,
                        Ok(Ok(Some(bytes))) => {
                            for data in decoder.push(&bytes) {
                                let Ok(event) = serde_json::from_str::<Value>(&data) else {
                                    continue;
                                };
                                if tx.send(StreamMsg::Event(event)).is_err() {
                                    return;
                                }
                            }
                        }
                        Ok(Ok(None)) => break "stream closed".to_string(),
                        Ok(Err(e)) => break e.to_string(),
                    }
                }
            }
            Ok(response) => format!("status={}", response.status()),
            Err(e) => e.to_string(),
        };
        if tx.send(StreamMsg::Disconnected(reason)).is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::SseDecoder;

    #[test]
    fn decodes_events_split_across_chunks() {
        let mut decoder = SseDecoder::default();
        let event = "data: {\"type\":\"session.text.delta\",\"data\":{\"delta\":\"é\"}}\n\n";
        let bytes = event.as_bytes();
        // Split inside the two-byte "é".
        let split = event.find('é').unwrap() + 1;
        assert!(decoder.push(&bytes[..split]).is_empty());
        assert_eq!(
            decoder.push(&bytes[split..]),
            vec!["{\"type\":\"session.text.delta\",\"data\":{\"delta\":\"é\"}}".to_string()]
        );
    }

    #[test]
    fn joins_multi_line_data_and_ignores_other_fields() {
        let mut decoder = SseDecoder::default();
        assert_eq!(
            decoder.push(b"event: message\r\nid: 1\r\ndata: a\r\ndata: b\r\n\r\ndata: c\n\n"),
            vec!["a\nb".to_string(), "c".to_string()]
        );
    }
}

use super::*;
use serde_json::json;

fn notification(update: Value) -> Value {
    json!({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":"devin-test", "update":update}})
}

fn apply_update(response: &mut DevinResponse, update: Value) {
    if let Some(item) = parse_devin_stream_item(&notification(update)) {
        apply_stream_item(response, item);
    }
}

fn start_tool(response: &mut DevinResponse) {
    apply_update(
        response,
        json!({"sessionUpdate":"tool_call", "toolCallId":"tool-1", "title":"Read", "rawInput":{"path":"a.txt"}}),
    );
}

#[test]
fn output_survives_status_only_updates_and_partial_metadata() {
    let mut response = empty_response(Some("devin-test"));
    start_tool(&mut response);
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "rawOutput":"file contents"}),
    );
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "title":"Read file", "rawInput":{"path":"b.txt"}}),
    );
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "status":"in_progress"}),
    );
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "status":"completed"}),
    );
    let tool = &response.tool_calls[0];
    assert_eq!(tool.output.as_deref(), Some("file contents"));
    assert_eq!(tool.name, "Read file");
    assert_eq!(tool.input, json!({"path":"b.txt"}));
}

#[test]
fn failed_tools_keep_their_error_and_output() {
    let mut response = empty_response(None);
    start_tool(&mut response);
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "rawOutput":"Permission denied", "status":"failed"}),
    );
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call_update", "toolCallId":"tool-1", "title":"Read denied file"}),
    );
    assert_eq!(response.tool_calls[0].is_error, Some(true));
    assert_eq!(
        response.tool_calls[0].output.as_deref(),
        Some("Permission denied")
    );
}

#[test]
fn preserves_order_and_deduplicates_tool_blocks() {
    let mut response = empty_response(None);
    apply_stream_item(&mut response, DevinStreamItem::Text("Before ".into()));
    apply_stream_item(&mut response, DevinStreamItem::Text("tool".into()));
    start_tool(&mut response);
    start_tool(&mut response);
    apply_stream_item(
        &mut response,
        DevinStreamItem::Thinking("Check output".into()),
    );
    apply_stream_item(&mut response, DevinStreamItem::Text("After tool".into()));
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.content_blocks.len(), 4);
    assert!(
        matches!(&response.content_blocks[0], ContentBlock::Text {text} if text == "Before tool")
    );
    assert!(
        matches!(&response.content_blocks[1], ContentBlock::ToolUse {tool_call_id} if tool_call_id == "tool-1")
    );
    assert!(
        matches!(&response.content_blocks[2], ContentBlock::Thinking {thinking} if thinking == "Check output")
    );
    assert!(
        matches!(&response.content_blocks[3], ContentBlock::Text {text} if text == "After tool")
    );
}

#[test]
fn recovers_partial_cancelled_history_without_final_result() {
    let run: RunEntry = serde_json::from_value(json!({
        "run_id":"run-1", "user_message_id":"user-1", "user_message":"Read a file",
        "started_at":100, "status":"cancelled", "cancelled":true
    }))
    .unwrap();
    let lines = vec![
        notification(json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"Partial answer"}})).to_string(),
        notification(json!({"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read"})).to_string(),
        notification(json!({"sessionUpdate":"tool_call_update","toolCallId":"tool-1","rawOutput":"partial output"})).to_string(),
        "{incomplete".into(),
    ];
    let message = parse_devin_run_to_message(&lines, &run).unwrap();
    assert_eq!(message.content, "Partial answer");
    assert!(message.cancelled);
    assert_eq!(
        message.tool_calls[0].output.as_deref(),
        Some("partial output")
    );
    assert_eq!(message.content_blocks.len(), 2);
}

fn channel_reader() -> (mpsc::Sender<Result<String, String>>, AcpReader) {
    let (sender, lines) = mpsc::channel();
    (
        sender,
        AcpReader {
            lines,
            cancelled: Arc::new(AtomicBool::new(false)),
            auto_approve: AtomicBool::new(false),
            session_id: None,
        },
    )
}

#[test]
fn reader_checks_deadline_and_cancellation_before_waiting() {
    let (_sender, reader) = channel_reader();
    assert!(reader
        .next(Instant::now(), false)
        .unwrap_err()
        .contains("timed out"));
    reader.cancelled.store(true, Ordering::Release);
    assert!(reader
        .next(Instant::now() + Duration::from_secs(60), true)
        .unwrap_err()
        .contains("cancelled"));
}

#[test]
fn reader_drains_cancel_reply_and_reports_eof_and_read_errors() {
    let (sender, reader) = channel_reader();
    reader.cancelled.store(true, Ordering::Release);
    sender.send(Ok("not json".into())).unwrap();
    sender
        .send(Ok(
            json!({"id":1,"result":{"stopReason":"cancelled"}}).to_string()
        ))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert_eq!(reader.next(deadline, false).unwrap(), None);
    assert_eq!(
        reader.next(deadline, false).unwrap().unwrap()["result"]["stopReason"],
        "cancelled"
    );
    sender.send(Err("pipe read error".into())).unwrap();
    assert_eq!(reader.next(deadline, false).unwrap_err(), "pipe read error");
    drop(sender);
    assert!(reader.next(deadline, false).unwrap_err().contains("exited"));
}

#[test]
fn terminal_tool_start_keeps_output_and_failed_status() {
    let mut response = empty_response(None);
    apply_update(
        &mut response,
        json!({"sessionUpdate":"tool_call", "toolCallId":"tool-1", "title":"Read", "status":"failed", "rawOutput":"File not found"}),
    );
    assert_eq!(
        response.tool_calls[0].output.as_deref(),
        Some("File not found")
    );
    assert_eq!(response.tool_calls[0].is_error, Some(true));
}

#[test]
fn local_model_variant_uses_advertised_family_and_separate_thinking() {
    let config = json!([{"id":"model", "category":"model", "type":"select", "options":[
        {"value":"swe-2-high"}, {"value":"other-medium"}
    ]}]);
    assert_eq!(
        local_model_selections(&config, "swe-2-medium").unwrap(),
        vec![
            ("model".into(), "swe-2-high".into()),
            ("thought_level".into(), "medium".into()),
        ]
    );
    assert_eq!(
        local_model_selections(&config, "swe-2-high").unwrap(),
        vec![("model".into(), "swe-2-high".into()),]
    );
    assert!(local_model_selections(&config, "missing-medium").is_err());
    assert!(local_model_selections(&config, "swe-2-unknown").is_err());
}

#[test]
fn cloud_without_mode_controls_uses_remote_defaults() {
    for mode in ["plan", "build", "yolo"] {
        assert_eq!(
            mode_request(&json!({"result":{}}), DevinLocation::Cloud, Some(mode)).unwrap(),
            None
        );
    }
    assert!(mode_request(&json!({"result":{}}), DevinLocation::Local, Some("plan")).is_err());
}

#[test]
fn mode_negotiation_uses_advertised_config_or_legacy_modes() {
    let config = json!({"result":{"configOptions":[{"id":"permission", "category":"mode", "type":"select", "options":[{"value":"plan"}]}]}});
    assert_eq!(
        mode_request(&config, DevinLocation::Cloud, Some("plan")).unwrap(),
        Some((
            "session/set_config_option",
            json!({"configId":"permission","value":"plan"})
        ))
    );
    assert!(mode_request(&config, DevinLocation::Cloud, Some("yolo")).is_err());
    let legacy = json!({"result":{"modes":{"availableModes":[{"id":"plan"}]}}});
    assert_eq!(
        mode_request(&legacy, DevinLocation::Cloud, Some("plan")).unwrap(),
        Some(("session/set_mode", json!({"modeId":"plan"})))
    );
    assert!(mode_request(&legacy, DevinLocation::Cloud, Some("build")).is_err());
}

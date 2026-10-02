//! ACP v1 session and prompt helpers. See https://agentclientprotocol.com/protocol/v1/session-setup.
use serde_json::{json, Value};
use std::path::Path;

/// ACP v1 uses session/load, and requires the loadSession capability.
/// Do not silently start a new conversation when a saved session cannot load.
pub(crate) fn session_request(
    init: &Value,
    existing_id: Option<&str>,
    cwd: &Path,
) -> Result<(&'static str, Value), String> {
    let mut params = json!({"cwd": cwd.to_string_lossy(), "mcpServers": []});
    if let Some(id) = existing_id.filter(|id| !id.is_empty()) {
        if init
            .pointer("/result/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(
                "Devin ACP cannot load the saved session. Start a new chat session.".into(),
            );
        }
        params["sessionId"] = json!(id);
        Ok(("session/load", params))
    } else {
        Ok(("session/new", params))
    }
}

/// Resolve the advertised selector ID, including grouped select values.
/// See https://agentclientprotocol.com/protocol/v1/session-config-options.
/// Absence is distinct from an invalid requested value so callers can decide
/// whether an optional setting is required for this turn.
pub(crate) fn config_selection(
    config_options: &Value,
    category_or_id: &str,
    requested: &str,
) -> Result<Option<(String, String)>, String> {
    let Some(options) = config_options.as_array() else {
        return Ok(None);
    };
    let option = options
        .iter()
        .find(|option| option["id"].as_str() == Some(category_or_id))
        .or_else(|| {
            options
                .iter()
                .find(|option| option["category"].as_str() == Some(category_or_id))
        });
    let Some(option) = option else {
        return Ok(None);
    };
    let id = option["id"]
        .as_str()
        .ok_or("Devin ACP returned a configuration option without an ID")?;
    let valid = option["type"].as_str() == Some("select")
        && option["options"].as_array().is_some_and(|values| {
            values.iter().any(|value| {
                value["value"].as_str() == Some(requested)
                    || value["options"].as_array().is_some_and(|group| {
                        group
                            .iter()
                            .any(|value| value["value"].as_str() == Some(requested))
                    })
            })
        });
    if !valid {
        return Err(format!(
            "Devin ACP does not offer '{requested}' for '{id}'."
        ));
    }
    Ok(Some((id.to_string(), requested.to_string())))
}

/// Encode supported images rather than pass local paths as text.
/// Limit total input bytes before base64 expansion, including changing files.
/// See https://agentclientprotocol.com/protocol/v1/content.
pub(crate) fn prompt_blocks(
    message: &str,
    image_paths: &[String],
    init: &Value,
) -> Result<Value, String> {
    use base64::Engine;
    use std::io::Read;
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    if !image_paths.is_empty()
        && init
            .pointer("/result/agentCapabilities/promptCapabilities/image")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("This Devin ACP server does not support images.".into());
    }
    let mut blocks = vec![json!({"type":"text", "text":message})];
    let mut remaining = MAX_IMAGE_BYTES;
    for path in image_paths {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("Cannot open image '{path}': {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Cannot inspect image '{path}': {error}"))?;
        if !metadata.is_file() {
            return Err(format!("Image '{path}' is not a regular file."));
        }
        if metadata.len() > remaining {
            return Err("Devin image attachments exceed the 20 MiB limit.".into());
        }
        let mut bytes = Vec::new();
        file.take(remaining + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Cannot read image '{path}': {error}"))?;
        if bytes.len() as u64 > remaining {
            return Err("Devin image attachments exceed the 20 MiB limit.".into());
        }
        remaining -= bytes.len() as u64;
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return Err(format!(
                "Unsupported image format for '{path}'. Use PNG, JPEG, GIF, or WebP."
            ));
        };
        blocks.push(json!({"type":"image", "mimeType":mime, "data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    Ok(Value::Array(blocks))
}

/// Translate Jean's MCP map to ACP v1 server entries.
pub(crate) fn acp_mcp_servers(config: Option<&str>, init: &Value) -> Result<Value, String> {
    let Some(config) = config else {
        return Ok(json!([]));
    };
    let config: Value = serde_json::from_str(config)
        .map_err(|error| format!("Invalid Devin MCP configuration: {error}"))?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or("Devin MCP configuration must contain an mcpServers object")?;
    let mut result = Vec::new();
    for (name, server) in servers {
        if server.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if !server.is_object() || name.trim().is_empty() {
            return Err(format!("Invalid MCP server '{name}'."));
        }
        let transport = match server.get("type").or_else(|| server.get("transport")) {
            Some(value) => value
                .as_str()
                .ok_or_else(|| format!("Invalid MCP transport for '{name}'."))?,
            None if server.get("url").is_some() => "http",
            None => "stdio",
        };
        let required_string = |key: &str| -> Result<&str, String> {
            server
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("MCP server '{name}' requires '{key}'."))
        };
        match transport {
            "stdio" => {
                let command = required_string("command")?;
                let args = match server.get("args") {
                    None => json!([]),
                    Some(Value::Array(args)) if args.iter().all(Value::is_string) => json!(args),
                    _ => return Err(format!("MCP server '{name}' args must be strings.")),
                };
                result.push(json!({"name":name,"command":command,"args":args,"env":mcp_key_values(server.get("env"), name, "env")?}));
            }
            "http" | "sse" => {
                if init
                    .pointer(&format!(
                        "/result/agentCapabilities/mcpCapabilities/{transport}"
                    ))
                    .and_then(Value::as_bool)
                    != Some(true)
                {
                    return Err(format!(
                        "Devin ACP does not support '{transport}' MCP server '{name}'."
                    ));
                }
                let url = required_string("url")?;
                if !url.starts_with("https://") && !url.starts_with("http://") {
                    return Err(format!(
                        "MCP server '{name}' requires an HTTP or HTTPS URL."
                    ));
                }
                result.push(json!({"name":name,"type":transport,"url":url,"headers":mcp_key_values(server.get("headers"), name, "headers")?}));
            }
            _ => {
                return Err(format!(
                    "Unsupported MCP transport '{transport}' for '{name}'."
                ))
            }
        }
    }
    Ok(Value::Array(result))
}

fn mcp_key_values(value: Option<&Value>, server: &str, field: &str) -> Result<Value, String> {
    let Some(value) = value else {
        return Ok(json!([]));
    };
    let entries = value
        .as_object()
        .ok_or_else(|| format!("MCP server '{server}' {field} must be an object."))?;
    entries
        .iter()
        .map(|(name, value)| {
            let value = value
                .as_str()
                .ok_or_else(|| format!("MCP server '{server}' {field} values must be strings."))?;
            Ok(json!({"name":name,"value":value}))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(Value::Array)
}

/// Include actual text contents even when the agent has no local file access.
/// URNs identify attachments without platform-dependent file URI conversion.
pub(crate) fn embed_text_files(
    blocks: &mut Value,
    paths: &[String],
    init: &Value,
) -> Result<(), String> {
    use base64::Engine;
    use std::io::Read;
    let blocks = blocks
        .as_array_mut()
        .ok_or("Devin prompt blocks must be an array")?;
    let embedded = init
        .pointer("/result/agentCapabilities/promptCapabilities/embeddedContext")
        .and_then(Value::as_bool)
        == Some(true);
    let mut remaining = 2 * 1024 * 1024u64;
    let mut attachments = Vec::new();
    for path in paths {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("Cannot open text attachment '{path}': {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Cannot inspect text attachment '{path}': {error}"))?;
        if !metadata.is_file() {
            return Err(format!("Text attachment '{path}' is not a regular file."));
        }
        if metadata.len() > remaining {
            return Err("Devin text attachments exceed the 2 MiB limit.".into());
        }
        let mut text = String::new();
        file.take(remaining + 1)
            .read_to_string(&mut text)
            .map_err(|error| format!("Cannot read text attachment '{path}': {error}"))?;
        if text.len() as u64 > remaining {
            return Err("Devin text attachments exceed the 2 MiB limit.".into());
        }
        remaining -= text.len() as u64;
        attachments.push(if embedded {
            let encoded_path = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes());
            json!({"type":"resource", "resource":{"uri":format!("urn:jean:attachment:{encoded_path}"),"mimeType":"text/plain","text":text}})
        } else {
            json!({"type":"text","text":format!("Text attachment: {path}\n\n{text}")})
        });
    }
    blocks.extend(attachments);
    Ok(())
}

/// Cloud sessions cannot read Jean's local file and skill references.
/// Resolve only the explicit attachment marker format, not arbitrary prose.
pub(crate) fn cloud_reference_paths(message: &str, cwd: &Path) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for marker in message.split('[').skip(1) {
        if marker.starts_with("Directory: ") && marker.contains(']') {
            return Err("Devin cloud sessions cannot read local directory attachments. Attach individual files instead.".into());
        }
        let (reference, suffix, skill) = if let Some(reference) = marker.strip_prefix("File: ") {
            (reference, " - Use the Read tool to view this file]", false)
        } else if let Some(reference) = marker.strip_prefix("Skill: ") {
            (
                reference,
                " - Read and use this skill to guide your response]",
                true,
            )
        } else {
            continue;
        };
        let Some((path, _)) = reference.split_once(suffix) else {
            continue;
        };
        if path.trim().is_empty() {
            return Err("Devin cloud attachment path is empty.".into());
        }
        let mut path = cwd.join(path);
        if !path.is_absolute() {
            return Err("Devin cloud attachments require an absolute working directory.".into());
        }
        if skill && path.is_dir() {
            path.push("SKILL.md");
        }
        let path = path
            .to_str()
            .ok_or("Devin cloud attachment path is not valid UTF-8")?
            .to_string();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loads_existing_sessions_only_when_supported() {
        let init = json!({"result":{"agentCapabilities":{"loadSession":true}}});
        let (method, params) =
            session_request(&init, Some("old-session"), Path::new("/project")).unwrap();
        assert_eq!(method, "session/load");
        assert_eq!(params["sessionId"], "old-session");
        assert_eq!(params["cwd"], "/project");
        assert!(session_request(&json!({}), Some("old-session"), Path::new("/project")).is_err());
        assert_eq!(
            session_request(&json!({}), None, Path::new("/project"))
                .unwrap()
                .0,
            "session/new"
        );
    }
    #[test]
    fn uses_advertised_ids_and_validates_flat_and_grouped_values() {
        let options = json!([
            {"id":"model-selector", "category":"model", "type":"select", "options":[{"group":"available", "options":[{"value":"model-a"}]}]},
            {"id":"permission-mode", "category":"mode", "type":"select", "options":[{"value":"normal"},{"value":"dangerous"}]},
            {"id":"thinking", "type":"select", "options":[{"value":"high"}]},
            {"id":"speed", "type":"select", "options":[{"value":"fast"}]}
        ]);
        assert_eq!(
            config_selection(&options, "model", "model-a").unwrap(),
            Some(("model-selector".into(), "model-a".into()))
        );
        assert_eq!(
            config_selection(&options, "mode", "normal").unwrap(),
            Some(("permission-mode".into(), "normal".into()))
        );
        assert!(config_selection(&options, "model", "missing").is_err());
        assert!(config_selection(&options, "thinking", "high")
            .unwrap()
            .is_some());
        assert!(config_selection(&options, "speed", "fast")
            .unwrap()
            .is_some());
        assert_eq!(
            config_selection(&options, "missing", "value").unwrap(),
            None
        );
    }
    #[test]
    fn sends_text_and_rejects_unsupported_images_before_file_access() {
        assert_eq!(
            prompt_blocks("hello", &[], &json!({})).unwrap(),
            json!([{"type":"text","text":"hello"}])
        );
        let error = prompt_blocks("hello", &["/missing.png".into()], &json!({})).unwrap_err();
        assert!(error.contains("does not support images"), "{error}");
    }
    #[test]
    fn embeds_image_bytes_with_detected_mime_type() {
        let path =
            std::env::temp_dir().join(format!("jean-devin-image-{}.bin", std::process::id()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nimage-data").unwrap();
        let result = prompt_blocks(
            "look",
            &[path.to_string_lossy().into_owned()],
            &json!({"result":{"agentCapabilities":{"promptCapabilities":{"image":true}}}}),
        );
        std::fs::remove_file(path).unwrap();
        let blocks = result.unwrap();
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[1]["data"], "iVBORw0KGgppbWFnZS1kYXRh");
    }
    #[test]
    fn bounds_image_reads_and_rejects_unknown_content() {
        let path =
            std::env::temp_dir().join(format!("jean-devin-image-limit-{}.bin", std::process::id()));
        let init = json!({"result":{"agentCapabilities":{"promptCapabilities":{"image":true}}}});
        let paths = [path.to_string_lossy().into_owned()];
        std::fs::write(&path, b"not an image").unwrap();
        assert!(prompt_blocks("look", &paths, &init)
            .unwrap_err()
            .contains("image format"));
        std::fs::File::create(&path)
            .unwrap()
            .set_len(20 * 1024 * 1024 + 1)
            .unwrap();
        let result = prompt_blocks("look", &paths, &init);
        std::fs::remove_file(path).unwrap();
        assert!(result.unwrap_err().contains("20 MiB"));
    }
    #[test]
    fn converts_mcp_servers_and_checks_transport_capabilities() {
        let config = r#"{"mcpServers":{"local":{"command":"/bin/tool","args":["--mcp"],"env":{"TOKEN":"secret"}},"remote":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer secret"}},"off":{"disabled":true}}}"#;
        assert!(acp_mcp_servers(Some(config), &json!({})).is_err());
        let init =
            json!({"result":{"agentCapabilities":{"mcpCapabilities":{"http":true,"sse":true}}}});
        let servers = acp_mcp_servers(Some(config), &init).unwrap();
        assert_eq!(servers.as_array().unwrap().len(), 2);
        assert_eq!(
            servers[0],
            json!({"name":"local","command":"/bin/tool","args":["--mcp"],"env":[{"name":"TOKEN","value":"secret"}]})
        );
        assert_eq!(
            servers[1]["headers"],
            json!([{"name":"Authorization","value":"Bearer secret"}])
        );
        let sse = acp_mcp_servers(
            Some(
                r#"{"mcpServers":{"remote":{"transport":"sse","url":"https://example.com/sse"}}}"#,
            ),
            &init,
        )
        .unwrap();
        assert_eq!(sse[0]["type"], "sse");
        assert_eq!(acp_mcp_servers(None, &init).unwrap(), json!([]));
    }
    #[test]
    fn rejects_malformed_enabled_mcp_servers() {
        for config in [
            r#"{}"#,
            r#"{"mcpServers":[]}"#,
            r#"{"mcpServers":{"bad":null}}"#,
            r#"{"mcpServers":{"bad":{"command":"tool","args":[1]}}}"#,
            r#"{"mcpServers":{"bad":{"command":"tool","env":{"KEY":5}}}}"#,
            r#"{"mcpServers":{"bad":{"type":"unsupported"}}}"#,
        ] {
            assert!(
                acp_mcp_servers(Some(config), &json!({})).is_err(),
                "{config}"
            );
        }
    }
    #[test]
    fn embeds_text_attachments_or_uses_inline_fallback() {
        let path = std::env::temp_dir().join(format!("jean-devin-text-{}.txt", std::process::id()));
        std::fs::write(&path, "attached context").unwrap();
        let paths = [path.to_string_lossy().into_owned()];
        let mut blocks = json!([]);
        embed_text_files(&mut blocks, &paths, &json!({"result":{"agentCapabilities":{"promptCapabilities":{"embeddedContext":true}}}})).unwrap();
        assert_eq!(blocks[0]["type"], "resource");
        assert_eq!(blocks[0]["resource"]["text"], "attached context");
        assert!(blocks[0]["resource"]["uri"]
            .as_str()
            .unwrap()
            .starts_with("urn:jean:attachment:"));
        let mut fallback = json!([]);
        embed_text_files(&mut fallback, &paths, &json!({})).unwrap();
        assert_eq!(fallback[0]["type"], "text");
        assert!(fallback[0]["text"]
            .as_str()
            .unwrap()
            .contains("attached context"));
        std::fs::File::create(&path)
            .unwrap()
            .set_len(2 * 1024 * 1024 + 1)
            .unwrap();
        let result = embed_text_files(&mut fallback, &paths, &json!({}));
        std::fs::remove_file(path).unwrap();
        assert!(result.unwrap_err().contains("2 MiB"));
    }
    #[test]
    fn resolves_cloud_file_and_skill_references_without_duplicates() {
        let cwd = std::env::temp_dir().join(format!("jean-devin-skill-{}", std::process::id()));
        std::fs::create_dir_all(cwd.join("skill")).unwrap();
        let absolute = cwd.join("absolute.txt");
        let message = format!("[File: relative.txt - Use the Read tool to view this file]\n[Skill: skill - Read and use this skill to guide your response]\n[File: {} - Use the Read tool to view this file]\n[File: relative.txt - Use the Read tool to view this file]", absolute.display());
        let paths = cloud_reference_paths(&message, &cwd).unwrap();
        std::fs::remove_dir(cwd.join("skill")).unwrap();
        std::fs::remove_dir(&cwd).unwrap();
        assert_eq!(
            paths,
            vec![
                cwd.join("relative.txt").to_string_lossy(),
                cwd.join("skill/SKILL.md").to_string_lossy(),
                absolute.to_string_lossy()
            ]
        );
    }
    #[test]
    fn rejects_cloud_directories_and_ignores_non_reference_text() {
        assert!(cloud_reference_paths(
            "[Directory: src - Read this directory]",
            Path::new("/project")
        )
        .unwrap_err()
        .contains("individual files"));
        assert_eq!(
            cloud_reference_paths(
                "[File: ordinary text] [Skill: not a reference]",
                Path::new("/project")
            )
            .unwrap(),
            Vec::<String>::new()
        );
        assert!(cloud_reference_paths(
            "[File:  - Use the Read tool to view this file]",
            Path::new("/project")
        )
        .is_err());
    }
}

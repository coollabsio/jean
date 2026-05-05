use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::Value;
use tauri::AppHandle;

use crate::acp::application::{prompt_mentions, session_service, supervisor};
use crate::acp::infrastructure::file_search;

const MAX_IMAGE_DIMENSION: u32 = 1568;
const JPEG_QUALITY: u8 = 85;
const MIN_PROCESS_SIZE: usize = 50 * 1024;

#[derive(Debug, Clone)]
pub struct ProcessedImage {
    pub data: String,
    pub mime_type: String,
}

pub async fn process_image(data: String, mime_type: String) -> Result<ProcessedImage, String> {
    let bytes = STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 decode: {e}"))?;
    let ext = mime_type_to_ext(&mime_type);
    let (processed, out_ext) =
        tokio::task::spawn_blocking(move || process_image_bytes(&bytes, &ext))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??;
    Ok(ProcessedImage {
        data: STANDARD.encode(&processed),
        mime_type: ext_to_mime_type(&out_ext),
    })
}

pub async fn send_message(
    app: AppHandle,
    jean_session_id: String,
    text: String,
    images: Vec<(String, String)>,
    mentions: Vec<String>,
    worktree_path: Option<String>,
) -> Result<Value, String> {
    let (provider, session_id) = session_service::resolve_bound_session(&app, &jean_session_id)?;
    let mention_blocks = if mentions.is_empty() {
        Vec::new()
    } else {
        let wt = worktree_path
            .as_deref()
            .ok_or("worktree_path is required when sending @file mentions")?;
        let embedded = supervisor::prompt_embedded_context_supported(&app, provider).await;
        prompt_mentions::expand_mentions(wt, &mentions, embedded)?
    };
    let response =
        supervisor::send_prompt(&app, provider, session_id, text, images, mention_blocks).await?;
    serde_json::to_value(response).map_err(|e| format!("encode prompt response: {e}"))
}

pub async fn search_files(
    worktree_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(20);
    tauri::async_runtime::spawn_blocking(move || file_search::search(&worktree_path, &query, limit))
        .await
        .map_err(|e| format!("file search join: {e}"))
}

pub async fn cancel(app: AppHandle, jean_session_id: String) -> Result<(), String> {
    let (provider, session_id) = session_service::resolve_bound_session(&app, &jean_session_id)?;
    supervisor::cancel(&app, provider, session_id).await
}

pub async fn set_model(
    app: AppHandle,
    jean_session_id: String,
    model_id: String,
) -> Result<Value, String> {
    let (provider, session_id) = session_service::resolve_bound_session(&app, &jean_session_id)?;
    supervisor::set_model(&app, provider, session_id, model_id).await
}

pub async fn set_mode(
    app: AppHandle,
    jean_session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    let (provider, session_id) = session_service::resolve_bound_session(&app, &jean_session_id)?;
    supervisor::set_mode(&app, provider, session_id, mode_id).await
}

pub async fn set_config_option(
    app: AppHandle,
    jean_session_id: String,
    config_id: String,
    value_id: String,
) -> Result<Value, String> {
    let (provider, session_id) = session_service::resolve_bound_session(&app, &jean_session_id)?;
    supervisor::set_config_option(&app, provider, session_id, config_id, value_id).await
}

fn mime_type_to_ext(mime: &str) -> String {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/gif" => "gif".to_string(),
        "image/webp" => "webp".to_string(),
        other => other.trim_start_matches("image/").to_string(),
    }
}

fn ext_to_mime_type(ext: &str) -> String {
    match ext {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "png" => "image/png".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        other => format!("image/{other}"),
    }
}

fn process_image_bytes(image_data: &[u8], extension: &str) -> Result<(Vec<u8>, String), String> {
    if extension == "gif" || image_data.len() < MIN_PROCESS_SIZE {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    let img =
        image::load_from_memory(image_data).map_err(|e| format!("Failed to decode image: {e}"))?;

    let max_dim = img.width().max(img.height());
    let needs_resize = max_dim > MAX_IMAGE_DIMENSION;
    let convert_to_jpeg = extension == "png" && !img.color().has_alpha();

    if !needs_resize && !convert_to_jpeg {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    process_dynamic_image(img, extension, needs_resize, convert_to_jpeg)
}

fn process_dynamic_image(
    img: image::DynamicImage,
    _extension: &str,
    needs_resize: bool,
    convert_to_jpeg: bool,
) -> Result<(Vec<u8>, String), String> {
    let (width, height) = (img.width(), img.height());
    let target_ext = if convert_to_jpeg { "jpg" } else { "png" };

    let processed = if needs_resize {
        let max_dim = width.max(height);
        let scale = MAX_IMAGE_DIMENSION as f32 / max_dim as f32;
        let new_w = ((width as f32 * scale) as u32).max(1);
        let new_h = ((height as f32 * scale) as u32).max(1);
        img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    if convert_to_jpeg || target_ext == "jpg" {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        processed
            .write_with_encoder(encoder)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    } else {
        processed
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }

    Ok((buf.into_inner(), target_ext.to_string()))
}

//! `@file` mention expansion.
//!
//! The frontend sends mentions as relative paths (relative to the session's
//! worktree root). This module joins each path against the worktree root,
//! validates it stays inside the tree (no `..` escape), reads metadata, and
//! produces a `ContentBlock` per the ACP spec:
//!
//! - **Embedded `resource`** — the spec-preferred shape for `@file` mentions
//!   when the agent advertises `prompt_capabilities.embedded_context` AND the
//!   file is text AND under [`MAX_EMBED_BYTES`]. Inlines the full text content.
//! - **`resource_link`** — universal fallback used when any of the above is
//!   not satisfied (capability missing, binary file, oversize, or directory).
//!   Just hands the agent a `file://` URI so it can fetch via `fs/read_*`.
//!
//! Failures (missing file, traversal, I/O) are surfaced as `Err` so the
//! frontend can show the user *which* mention failed instead of silently
//! dropping it from the prompt.

use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::{
    ContentBlock, EmbeddedResource, EmbeddedResourceResource, ResourceLink, TextResourceContents,
};

/// Embed cap for inline `resource` content blocks. Anything larger falls
/// back to a `resource_link` so the agent can choose to read (or skip)
/// rather than us blowing up the prompt window. 256 KB is large enough for
/// the vast majority of source files and small enough that a 5–10× MIME
/// expansion (e.g. base64 for blobs) still fits comfortably in any agent's
/// context budget.
const MAX_EMBED_BYTES: u64 = 256 * 1024;

/// Resolve a single mention against the worktree root. Returns the
/// canonical absolute path on success, or an error describing why the
/// mention can't be used (missing, escaped the tree, or unreadable).
fn resolve_in_worktree(worktree: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(format!("@mention must be relative: {rel}"));
    }
    // Reject any `..` component up-front. We can't rely on canonicalization
    // alone because the worktree root itself may contain symlinks that make
    // a "safe-looking" relative path resolve outside the tree.
    for comp in rel_path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(format!("@mention path traversal not allowed: {rel}"));
        }
    }
    let joined = worktree.join(rel_path);
    let canonical = joined.canonicalize().map_err(|e| format!("@{rel}: {e}"))?;
    let worktree_canonical = worktree
        .canonicalize()
        .map_err(|e| format!("worktree path: {e}"))?;
    if !canonical.starts_with(&worktree_canonical) {
        return Err(format!("@mention escapes worktree: {rel}"));
    }
    Ok(canonical)
}

/// Convert a filesystem path to a `file://` URI. We don't pull in the `url`
/// crate just for this — the spec just needs `file://<absolute path>`.
fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// Best-effort MIME type from the file extension via [`mime_guess`].
/// Unknown extensions get `text/plain` (assumed-text) so callers can still
/// try to embed them; the embed path then re-checks via `is_likely_text`
/// before committing. We override the crate's default of
/// `application/octet-stream` because that would otherwise force every
/// extensionless config/script (`Makefile`, `.envrc`) onto the link path.
fn mime_for(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("text/plain")
        .to_string()
}

/// Quick text/binary heuristic. Trusts MIME for known image/PDF/zip types;
/// for everything else, sniffs for a NUL byte in the first 8 KB which
/// catches binaries that slipped through the extension table (or have none).
fn is_likely_text(mime: &str, sample: &[u8]) -> bool {
    if mime.starts_with("image/") || mime == "application/pdf" || mime == "application/zip" {
        return false;
    }
    !sample.iter().take(8 * 1024).any(|&b| b == 0)
}

/// Expand a list of relative-path mentions into ACP content blocks. See the
/// module docs for the embed-vs-link decision tree.
///
/// `embedded_supported` MUST reflect the agent's
/// `prompt_capabilities.embedded_context` flag for the active session.
pub fn expand_mentions(
    worktree_path: &str,
    mentions: &[String],
    embedded_supported: bool,
) -> Result<Vec<ContentBlock>, String> {
    let worktree = Path::new(worktree_path);
    let mut blocks = Vec::with_capacity(mentions.len());

    for rel in mentions {
        let abs = resolve_in_worktree(worktree, rel)?;
        let metadata = abs.metadata().map_err(|e| format!("@{rel}: stat: {e}"))?;
        let uri = file_uri(&abs);
        let name = abs
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(rel)
            .to_string();
        let mime = mime_for(&abs);
        let size = metadata.len();

        // Directories can never be embedded inline (no text content). Always
        // a link — the agent may choose to list contents on its own.
        if metadata.is_dir() {
            blocks.push(ContentBlock::ResourceLink(
                ResourceLink::new(name, uri).mime_type(Some("inode/directory".to_string())),
            ));
            continue;
        }

        // Embed iff the agent allows it AND the file is small AND looks like
        // text. We read the head twice (first for the binary sniff, then the
        // full slurp) only when both prior gates pass — keeps the cost low
        // for the universal fallback path.
        let try_embed = embedded_supported && size <= MAX_EMBED_BYTES;
        if try_embed {
            let bytes = std::fs::read(&abs).map_err(|e| format!("@{rel}: read: {e}"))?;
            if is_likely_text(&mime, &bytes) {
                let text = String::from_utf8(bytes)
                    .map_err(|e| format!("@{rel}: not valid UTF-8: {e}"))?;
                blocks.push(ContentBlock::Resource(EmbeddedResource::new(
                    EmbeddedResourceResource::TextResourceContents(
                        TextResourceContents::new(text, uri).mime_type(Some(mime)),
                    ),
                )));
                continue;
            }
        }

        // Fallback path. `size` is `i64` in the schema; clamp to be safe.
        let mut link = ResourceLink::new(name, uri).mime_type(Some(mime));
        link.size = i64::try_from(size).ok();
        blocks.push(ContentBlock::ResourceLink(link));
    }

    Ok(blocks)
}

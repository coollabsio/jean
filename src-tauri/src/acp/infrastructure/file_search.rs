//! Fuzzy file search for the `@file` mention popover.
//!
//! Walks a worktree honoring `.gitignore` (via the `ignore` crate) to build
//! a flat list of repo-relative file paths, then ranks them against a query
//! using Nucleo's fuzzy matcher. The full walk is the expensive part — at
//! ~50k files it's tens of milliseconds — so we cache the path list per
//! worktree with a short TTL so subsequent keystrokes only pay the matcher
//! cost (microseconds).
//!
//! Cache strategy is TTL, not mtime: the user's search session is short
//! (seconds, not minutes), so a 30s window catches new files quickly enough
//! without us having to crawl the tree to detect changes. If the entry is
//! expired we rebuild on the spot.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher,
};

/// Window after which a cached path list is considered stale and rebuilt
/// on the next search. Picked to feel "live enough" during an interactive
/// `@` session without causing repeated full-tree walks.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Cap on the number of paths we ever load into the cache for a single
/// worktree. Way bigger than any real repo we care about; protects against
/// pathological cases (e.g. an `@`-mention inside `~`).
const MAX_PATHS_PER_WORKTREE: usize = 200_000;

struct CacheEntry {
    paths: Vec<String>,
    built_at: Instant,
}

fn cache() -> &'static Mutex<std::collections::HashMap<PathBuf, CacheEntry>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Build the flat repo-relative path list for `root`, honoring `.gitignore`,
/// `.git/info/exclude`, and global ignore files. Skips the `.git` directory
/// itself and anything not a file.
fn build_path_list(root: &PathBuf) -> Vec<String> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false) // include dotfiles like `.env.example`; `.gitignore` will hide what shouldn't be visible
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .build();
    for entry in walker.flatten() {
        if out.len() >= MAX_PATHS_PER_WORKTREE {
            break;
        }
        let Some(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        // Lossy is fine — we never round-trip these back to disk paths;
        // they're handed to the user, then to expand_mentions which does
        // its own canonicalization.
        out.push(rel.to_string_lossy().into_owned());
    }
    out
}

/// Get-or-rebuild the cached path list for `root`. Holds the cache mutex
/// only while inserting/reading the entry — the actual walk runs unlocked
/// to avoid serializing concurrent searches across different worktrees.
fn cached_paths(root: &PathBuf) -> Vec<String> {
    {
        let guard = cache().lock().expect("file-search cache poisoned");
        if let Some(entry) = guard.get(root) {
            if entry.built_at.elapsed() < CACHE_TTL {
                return entry.paths.clone();
            }
        }
    }
    let paths = build_path_list(root);
    let entry = CacheEntry {
        paths: paths.clone(),
        built_at: Instant::now(),
    };
    cache()
        .lock()
        .expect("file-search cache poisoned")
        .insert(root.clone(), entry);
    paths
}

/// Rank `paths` against `query` and return up to `limit` best matches.
/// Empty query returns the first `limit` paths (so the popover is useful
/// the moment the user types `@`, before they've narrowed at all).
fn rank(paths: &[String], query: &str, limit: usize) -> Vec<String> {
    if query.is_empty() {
        return paths.iter().take(limit).cloned().collect();
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut scored: Vec<(u32, &String)> = paths
        .iter()
        .filter_map(|p| {
            let mut buf = Vec::new();
            let utf32 = nucleo_matcher::Utf32Str::new(p, &mut buf);
            pattern.score(utf32, &mut matcher).map(|s| (s, p))
        })
        .collect();
    // Higher score = better match. Stable sort preserves filesystem order
    // among equal scores, which the user can predict.
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, p)| p.clone())
        .collect()
}

/// Public entry point. `worktree_path` is the absolute root of the search
/// scope; `query` is the partial token the user has typed after `@`;
/// `limit` caps the returned result count (popover height).
pub fn search(worktree_path: &str, query: &str, limit: usize) -> Vec<String> {
    let root = PathBuf::from(worktree_path);
    let paths = cached_paths(&root);
    rank(&paths, query, limit.max(1))
}

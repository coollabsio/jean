//! Streaming delta coalescing for chat events.
//!
//! Backends emit `chat:chunk` / `chat:thinking` deltas at token rate
//! (50-200/sec for Codex). Every `emit_all` pays Tauri serialization, a
//! payload clone, and — when web access is enabled — a WebSocket broadcast.
//! The frontend appends chunk payloads, so concatenating N consecutive
//! deltas into one event is wire-compatible.
//!
//! [`ChunkCoalescer`] buffers consecutive deltas and releases them as one
//! batch when the coalescing window (~30ms) has elapsed, or when the caller
//! flushes. Callers MUST flush before emitting any other event for the
//! session (tool_use/thinking/done/error/...) so event ordering is
//! preserved, and before terminal events on completion/cancel/error paths.

use std::io::{self, Read};
use std::time::{Duration, Instant};

/// How long consecutive deltas are buffered before being released as one
/// batch. Small enough to be imperceptible, large enough to merge several
/// token deltas per event.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(30);

/// Buffers consecutive streaming text deltas into fewer, larger batches.
///
/// Invariant: `started_at` is `Some` iff the buffer is non-empty.
#[derive(Debug)]
pub struct ChunkCoalescer {
    buf: String,
    started_at: Option<Instant>,
    window: Duration,
}

impl Default for ChunkCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl ChunkCoalescer {
    pub fn new() -> Self {
        Self::with_window(COALESCE_WINDOW)
    }

    pub fn with_window(window: Duration) -> Self {
        Self {
            buf: String::new(),
            started_at: None,
            window,
        }
    }

    /// Buffer `delta`. Returns the accumulated batch (including `delta`)
    /// when the coalescing window has elapsed since buffering started.
    pub fn push(&mut self, delta: &str) -> Option<String> {
        self.push_at(delta, Instant::now())
    }

    /// Deterministic variant of [`Self::push`] for tests.
    pub fn push_at(&mut self, delta: &str, now: Instant) -> Option<String> {
        if delta.is_empty() {
            return None;
        }
        let started = *self.started_at.get_or_insert(now);
        self.buf.push_str(delta);
        if now.saturating_duration_since(started) >= self.window {
            self.take()
        } else {
            None
        }
    }

    /// Take whatever is buffered, resetting the window.
    pub fn flush(&mut self) -> Option<String> {
        self.take()
    }

    /// Instant at which the buffered text should be flushed, or `None` when
    /// nothing is buffered. Callers waiting for more input can use this to
    /// bound their wait so text is not held while the stream idles.
    pub fn deadline(&self) -> Option<Instant> {
        self.started_at.map(|started| started + self.window)
    }

    fn take(&mut self) -> Option<String> {
        self.started_at = None;
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

/// `Read` adapter that runs `on_read` before every read of the inner reader.
///
/// Wrapped in a `BufReader`, the inner read only happens once the buffer is
/// drained — i.e. right before the caller may block waiting for more output.
/// Flushing a [`ChunkCoalescer`] there means buffered text is never held back
/// while a blocking `lines()` / `read_line()` stream idles mid-turn.
pub struct FlushBeforeRead<R, F> {
    inner: R,
    on_read: F,
}

impl<R, F> FlushBeforeRead<R, F> {
    pub fn new(inner: R, on_read: F) -> Self {
        Self { inner, on_read }
    }
}

impl<R: Read, F: FnMut()> Read for FlushBeforeRead<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (self.on_read)();
        self.inner.read(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    #[test]
    fn push_before_window_buffers_without_releasing() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));

        assert_eq!(coalescer.push_at("Hello", start), None);
        assert_eq!(
            coalescer.push_at(" world", start + Duration::from_millis(10)),
            None
        );
    }

    #[test]
    fn push_after_window_returns_full_batch_in_order() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));

        assert_eq!(coalescer.push_at("a", start), None);
        assert_eq!(
            coalescer.push_at("b", start + Duration::from_millis(10)),
            None
        );
        assert_eq!(
            coalescer.push_at("c", start + Duration::from_millis(30)),
            Some("abc".to_string())
        );
        // Window resets after release: nothing buffered anymore.
        assert_eq!(coalescer.flush(), None);
    }

    #[test]
    fn window_restarts_after_release() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));

        assert_eq!(coalescer.push_at("a", start), None);
        assert_eq!(
            coalescer.push_at("b", start + Duration::from_millis(31)),
            Some("ab".to_string())
        );
        // New window starts at the next push, not at the old start.
        assert_eq!(
            coalescer.push_at("c", start + Duration::from_millis(40)),
            None
        );
        assert_eq!(
            coalescer.push_at("d", start + Duration::from_millis(60)),
            None
        );
        assert_eq!(
            coalescer.push_at("e", start + Duration::from_millis(75)),
            Some("cde".to_string())
        );
    }

    #[test]
    fn flush_returns_buffered_text_and_resets() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));

        assert_eq!(coalescer.push_at("Hello", start), None);
        assert_eq!(coalescer.flush(), Some("Hello".to_string()));
        assert_eq!(coalescer.flush(), None);
        assert_eq!(coalescer.deadline(), None);
    }

    #[test]
    fn flush_on_empty_returns_none() {
        let mut coalescer = ChunkCoalescer::new();
        assert_eq!(coalescer.flush(), None);
    }

    #[test]
    fn empty_delta_is_ignored() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));

        assert_eq!(coalescer.push_at("", start), None);
        // Empty push must not start the window clock.
        assert_eq!(coalescer.deadline(), None);
        assert_eq!(coalescer.push_at("a", start + Duration::from_secs(1)), None);
        assert_eq!(coalescer.flush(), Some("a".to_string()));
    }

    #[test]
    fn zero_window_releases_every_push_immediately() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::ZERO);

        assert_eq!(coalescer.push_at("a", start), Some("a".to_string()));
        assert_eq!(coalescer.push_at("b", start), Some("b".to_string()));
    }

    #[test]
    fn deadline_tracks_first_buffered_delta() {
        let start = Instant::now();
        let window = Duration::from_millis(30);
        let mut coalescer = ChunkCoalescer::with_window(window);

        assert_eq!(coalescer.deadline(), None);
        coalescer.push_at("a", start);
        assert_eq!(coalescer.deadline(), Some(start + window));
        // Later pushes don't move the deadline.
        coalescer.push_at("b", start + Duration::from_millis(10));
        assert_eq!(coalescer.deadline(), Some(start + window));
    }

    #[test]
    fn concatenation_of_released_batches_equals_input_sequence() {
        let start = Instant::now();
        let mut coalescer = ChunkCoalescer::with_window(Duration::from_millis(30));
        let deltas = ["The ", "quick", " brown", " fox\n", "jumps", "", " over"];

        let mut released = String::new();
        for (i, delta) in deltas.iter().enumerate() {
            let now = start + Duration::from_millis(12 * i as u64);
            if let Some(batch) = coalescer.push_at(delta, now) {
                released.push_str(&batch);
            }
            // Simulate an interleaved boundary flush partway through.
            if i == 3 {
                if let Some(batch) = coalescer.flush() {
                    released.push_str(&batch);
                }
            }
        }
        if let Some(batch) = coalescer.flush() {
            released.push_str(&batch);
        }

        assert_eq!(released, deltas.concat());
    }

    #[test]
    fn flush_before_read_runs_only_when_buffer_is_drained() {
        let reads = std::cell::Cell::new(0);
        let reader = BufReader::new(FlushBeforeRead::new("a\nb\n".as_bytes(), || {
            reads.set(reads.get() + 1);
        }));

        let lines: Vec<String> = reader.lines().map(Result::unwrap).collect();

        assert_eq!(lines, ["a", "b"]);
        // One read fills the buffer with both lines, one more hits EOF.
        assert_eq!(reads.get(), 2);
    }
}

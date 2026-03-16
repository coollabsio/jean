//! NDJSON file tailing for real-time streaming
//!
//! This module provides functionality to tail an NDJSON file and read new lines
//! as they are written by a detached Claude CLI process.

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

/// Default (idle) polling interval for tailing NDJSON files.
/// Used when the last poll returned no new lines.
pub const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Fast polling interval used when the previous poll returned data.
/// During active streaming, the CLI writes chunks rapidly — polling at 5ms
/// instead of 50ms reduces per-event latency by up to 45ms.
pub const POLL_INTERVAL_FAST: Duration = Duration::from_millis(5);

/// Tailer for reading new lines from an NDJSON file.
///
/// Maintains position in the file and returns only new complete lines
/// since the last poll.
pub struct NdjsonTailer {
    reader: BufReader<File>,
    /// Buffer for incomplete lines (no trailing newline yet)
    buffer: String,
}

impl NdjsonTailer {
    /// Create a new tailer, starting from the current end of file.
    ///
    /// This is used when starting to tail a file that's being written to,
    /// where we only want new content.
    #[allow(dead_code)] // Used in tests
    pub fn new_at_end(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open file for tailing: {e}"))?;

        let mut reader = BufReader::new(file);

        // Seek to end of file
        reader
            .seek(SeekFrom::End(0))
            .map_err(|e| format!("Failed to seek to end of file: {e}"))?;

        Ok(Self {
            reader,
            buffer: String::new(),
        })
    }

    /// Create a new tailer, starting from the beginning of file.
    ///
    /// This is used when resuming a session where we need to read
    /// all existing content first.
    pub fn new_from_start(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open file for tailing: {e}"))?;

        let reader = BufReader::new(file);

        Ok(Self {
            reader,
            buffer: String::new(),
        })
    }

    /// Poll for new complete lines.
    ///
    /// Returns a vector of complete lines (without trailing newlines).
    /// Incomplete lines (no newline yet) are buffered until complete.
    pub fn poll(&mut self) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();

        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => {
                    // EOF reached, no more data available right now
                    break;
                }
                Ok(_) => {
                    // Add to buffer
                    self.buffer.push_str(&line);

                    // Check if we have a complete line (ends with newline)
                    if self.buffer.ends_with('\n') {
                        // Remove the trailing newline and add to results
                        let complete_line = self.buffer.trim_end_matches(['\n', '\r']).to_string();
                        lines.push(complete_line);
                        self.buffer.clear();
                    }
                    // If no newline, keep buffering (incomplete line)
                }
                Err(e) => {
                    return Err(format!("Error reading line: {e}"));
                }
            }
        }

        Ok(lines)
    }

    /// Check if there's any buffered incomplete data.
    #[allow(dead_code)] // Used in tests
    pub fn has_incomplete_data(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// Drain and return any buffered incomplete data.
    pub fn drain_buffer(&mut self) -> String {
        std::mem::take(&mut self.buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_tailer_new_lines() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        // Write initial content
        writeln!(file, r#"{{"type": "init"}}"#).unwrap();
        file.flush().unwrap();

        // Create tailer at end
        let mut tailer = NdjsonTailer::new_at_end(&path).unwrap();

        // Poll should return nothing (we're at end)
        let lines = tailer.poll().unwrap();
        assert!(lines.is_empty());

        // Write new content
        writeln!(file, r#"{{"type": "message", "content": "hello"}}"#).unwrap();
        file.flush().unwrap();

        // Poll should return the new line
        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("hello"));
    }

    #[test]
    fn test_tailer_incomplete_line() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Write partial line (no newline)
        // Note: write! interprets {{ as escaped {, so we get {"type": "partial
        write!(file, r#"{{"type": "partial"#).unwrap();
        file.flush().unwrap();

        // Poll should return nothing (incomplete)
        let lines = tailer.poll().unwrap();
        assert!(lines.is_empty());
        assert!(tailer.has_incomplete_data());

        // Complete the line
        // Note: writeln! interprets }} as escaped }
        writeln!(file, r#"}}"#).unwrap();
        file.flush().unwrap();

        // Now poll should return the complete line
        // Combined: {"type": "partial} (single braces due to format string escaping)
        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], r#"{"type": "partial}"#);
        assert!(!tailer.has_incomplete_data());
    }

    #[test]
    fn test_tailer_multiple_lines() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Write multiple lines at once
        writeln!(file, r#"{{"type": "line1"}}"#).unwrap();
        writeln!(file, r#"{{"type": "line2"}}"#).unwrap();
        writeln!(file, r#"{{"type": "line3"}}"#).unwrap();
        file.flush().unwrap();

        // Poll should return all three lines
        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("line1"));
        assert!(lines[1].contains("line2"));
        assert!(lines[2].contains("line3"));
    }

    #[test]
    fn test_tailer_empty_file() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Poll should return nothing for empty file
        let lines = tailer.poll().unwrap();
        assert!(lines.is_empty());
        assert!(!tailer.has_incomplete_data());
    }

    #[test]
    fn test_tailer_very_long_line() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Write a very long line (simulating large JSON output)
        let long_content: String = "x".repeat(100_000);
        writeln!(file, r#"{{"content": "{}"}}"#, long_content).unwrap();
        file.flush().unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains(&long_content));
    }

    #[test]
    fn test_tailer_interleaved_writes() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Write first line
        writeln!(file, r#"{{"type": "first"}}"#).unwrap();
        file.flush().unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("first"));

        // Poll again - should be empty
        let lines = tailer.poll().unwrap();
        assert!(lines.is_empty());

        // Write second line
        writeln!(file, r#"{{"type": "second"}}"#).unwrap();
        file.flush().unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("second"));
    }

    #[test]
    fn test_tailer_new_at_end_ignores_existing() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        // Write content before creating tailer
        writeln!(file, r#"{{"type": "existing1"}}"#).unwrap();
        writeln!(file, r#"{{"type": "existing2"}}"#).unwrap();
        file.flush().unwrap();

        // Create tailer at end - should ignore existing content
        let mut tailer = NdjsonTailer::new_at_end(&path).unwrap();

        let lines = tailer.poll().unwrap();
        assert!(lines.is_empty());

        // New content should be captured
        writeln!(file, r#"{{"type": "new"}}"#).unwrap();
        file.flush().unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("new"));
    }

    #[test]
    fn test_tailer_new_from_start_reads_all() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        // Write content before creating tailer
        writeln!(file, r#"{{"type": "line1"}}"#).unwrap();
        writeln!(file, r#"{{"type": "line2"}}"#).unwrap();
        file.flush().unwrap();

        // Create tailer from start - should read all existing content
        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("line1"));
        assert!(lines[1].contains("line2"));
    }

    #[test]
    fn test_tailer_handles_crlf_line_endings() {
        let mut file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        let mut tailer = NdjsonTailer::new_from_start(&path).unwrap();

        // Write with CRLF line endings (Windows-style)
        write!(file, "{{\"type\": \"crlf\"}}\r\n").unwrap();
        file.flush().unwrap();

        let lines = tailer.poll().unwrap();
        assert_eq!(lines.len(), 1);
        // trim_end_matches('\n') leaves \r, but that's OK for JSON parsing
        assert!(lines[0].contains(r#""type": "crlf""#));
    }

    #[test]
    fn test_poll_interval_constants() {
        // Verify the idle poll interval is a reasonable value
        assert_eq!(POLL_INTERVAL, Duration::from_millis(50));
        assert!(POLL_INTERVAL >= Duration::from_millis(10));
        assert!(POLL_INTERVAL <= Duration::from_millis(200));

        // Verify the fast (active) poll interval
        assert_eq!(POLL_INTERVAL_FAST, Duration::from_millis(5));
        assert!(POLL_INTERVAL_FAST < POLL_INTERVAL);
    }
}

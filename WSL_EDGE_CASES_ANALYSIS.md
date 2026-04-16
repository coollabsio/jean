# WSL Support - Comprehensive Edge Case Analysis

**Analysis Date:** April 16, 2026  
**Scan Depth:** Critical, High, and Medium priority issues  
**Status:** Found 8 concrete edge cases that could break WSL mode in practice

---

## CRITICAL ISSUES

### 1. Environment Variables Not Path-Translated in Detached Spawning
**Location:** `src-tauri/src/chat/detached.rs` lines 200-230 (WSL branch)  
**Severity:** CRITICAL  
**Description:**
When spawning detached processes in WSL mode, environment variables are passed directly into the shell command without path translation. This means if an environment variable contains a Windows path (e.g., a custom `CMAKE_PREFIX_PATH` or similar), it will fail inside WSL.

**Example Failure:**
```rust
// Current code - BROKEN:
let env_exports = env_vars
    .iter()
    .map(|(k, v)| format!("{k}='{}'", v.replace('\'', "'\\''")))
    .collect::<Vec<_>>();
// If v = "C:\Program Files\Something", this becomes invalid in WSL
```

**Non-WSL branch (lines 49-86) uses proper path handling:**
```rust
.map(|(k, v)| {
    let escaped = shell_escape(v);
    // But still doesn't translate Windows paths!
    format!("{}={}", k, escaped)
})
```

**Impact:** Any tool invocation with environment variables containing paths will fail. This affects:
- Build systems with custom include/library paths
- Tools with configuration environment variables
- Any CLI that reads path-based environment variables

**Fix Required:** Detect path-like environment variables and translate them:
```rust
fn translate_env_value(key: &str, value: &str) -> String {
    let wsl_config = get_wsl_config();
    if !wsl_config.enabled {
        return value.to_string();
    }
    // For known path variables
    if matches!(key, "PATH" | "PYTHONPATH" | "CMAKE_PREFIX_PATH" | "LD_LIBRARY_PATH" | "PKG_CONFIG_PATH") {
        // Split paths and translate each
        return translate_path_list(value);
    }
    // For any string that looks like a Windows path
    if value.contains('\\') || (value.len() > 2 && value.chars().nth(1) == Some(':')) {
        return win_to_wsl_path(value);
    }
    value.to_string()
}
```

---

### 2. UTF-16LE Decoding Silently Fails with Odd Byte Counts
**Location:** `src-tauri/src/platform/wsl.rs` lines 200-220  
**Severity:** CRITICAL  
**Description:**
`chunks_exact()` silently fails if the byte count isn't perfectly divisible by 2. When `wsl.exe -l -q` returns an odd number of bytes (possibly due to encoding edge cases or partial reads), the distro list becomes completely empty.

**Current Code:**
```rust
fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)  // ← Returns empty iterator on odd count!
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)  // ← Results in empty string
}
```

**Test Case:**
```
Input bytes: [0xFF, 0xFE, 0x55, 0x00, 0x62]  // Odd count
Output: "" (empty string)
Expected: "U" + lossy handling of final byte
```

**Impact:** Users with certain Windows configurations or distro lists might see an empty distro list, even though distros exist. The app might then auto-disable WSL mode.

**Fix Required:**
```rust
fn decode_utf16le(bytes: &[u8]) -> String {
    let mut u16s = Vec::new();
    for chunk in bytes.chunks(2) {
        if chunk.len() == 2 {
            u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        } else if chunk.len() == 1 {
            // Handle odd byte - include replacement character
            u16s.push(0xFFFD);
        }
    }
    String::from_utf16_lossy(&u16s)
}
```

---

### 3. Distro Names with Shell Metacharacters Break WSL Commands
**Location:** `src-tauri/src/platform/wsl.rs` lines 110-130 and `src-tauri/src/terminal/pty.rs` lines 60-90  
**Severity:** CRITICAL  
**Description:**
Distro names are passed directly into shell commands without escaping. If a user has a distro named something like `ubuntu-2404; rm -rf /`, it could lead to command injection or unexpected behavior.

**Vulnerable Code:**
```rust
pub fn wsl_aware_command<P: AsRef<std::ffi::OsStr>>(
    program: P,
    cwd: Option<&std::path::Path>,
) -> Command {
    // ...
    args.extend(["-d".to_string(), config.distro.clone()]);  // ← Not escaped!
    // ...
}
```

**Also in terminal PTY:**
```rust
let mut c = CommandBuilder::new("wsl.exe");
c.arg("-d");
c.arg(&wsl_config.distro);  // ← Passed as raw argument - good!
```

**Note:** The `CommandBuilder` and direct `.arg()` calls are actually SAFE because they pass arguments directly to the OS without shell parsing. However, in places where commands are built as strings (shell commands), this becomes dangerous.

**Impact:** Low in practice because most code uses safe `.arg()` methods, but the distro name passed to shell string commands could be exploited.

**Current Risk:** MEDIUM - safe in most paths because of `.arg()` usage, but should be validated at the configuration level.

**Fix Required:** Validate distro names at selection time:
```rust
pub fn validate_distro_name(distro: &str) -> bool {
    // Distro names should be alphanumeric with hyphens/underscores
    !distro.is_empty() &&
    distro.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}
```

---

## HIGH PRIORITY ISSUES

### 4. Network/UNC Paths Not Translated
**Location:** `src-tauri/src/platform/wsl.rs` lines 50-75  
**Severity:** HIGH  
**Description:**
Network paths like `\\server\share\folder` or `/mnt/wsl.localhost/distro/path` are only partially handled. Paths like `\\?\C:\path` (extended-length path) are not translated.

**Current Code:**
```rust
pub fn win_to_wsl_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");

    for prefix in &["//wsl.localhost/", "//wsl$/"] {
        // ✓ Handles WSL paths
        if let Some(rest) = normalized.strip_prefix(prefix) { ... }
    }

    if normalized.len() >= 3 && normalized.as_bytes()[0].is_ascii_alphabetic()
        && &normalized[1..3] == ":/" {
        // ✓ Handles drive letters
        let drive = (normalized.as_bytes()[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", &normalized[3..]);
    }

    normalized  // ← Returns unchanged for network paths!
}
```

**Unhandled Patterns:**
- `\\server\share\file` → Not converted
- `//server/share/file` → Passed through unchanged
- `\\?\C:\path` (extended path) → Passed through unchanged  
- `\\.\COM1` (device paths) → Passed through unchanged

**Impact:** File operations on network shares or with extended paths will fail. Build systems using network-mounted code will break.

**Fix Required:**
```rust
pub fn win_to_wsl_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    
    // Extended-length path prefix
    let normalized = if let Some(rest) = normalized.strip_prefix("///?/") {
        rest.to_string()
    } else {
        normalized
    };

    // Existing WSL and drive logic...
    
    // Network UNC path: //server/share → //server/share (keep as-is for now)
    if normalized.starts_with("//") && !normalized.starts_with("//wsl") {
        log::warn!("Network path {normalized} passed to WSL - may not work correctly");
        return normalized;
    }
    
    normalized
}
```

---

### 5. Distro Name with Special Characters in UNC Path
**Location:** `src-tauri/src/platform/wsl.rs` lines 85-100  
**Severity:** HIGH  
**Description:**
When converting WSL paths back to Windows, distro names containing spaces or special characters aren't escaped in the UNC path.

**Current Code:**
```rust
pub fn wsl_to_win_path(unix_path: &str, distro: &str) -> String {
    if unix_path.starts_with("/mnt/") && unix_path.len() >= 6 {
        // ✓ Handles /mnt paths fine
        let drive = (unix_path.as_bytes()[5] as char).to_ascii_uppercase();
        return format!("{drive}:{}", rest.replace('/', "\\"));
    }

    // ✗ If distro = "My Distro", this creates invalid UNC path
    format!(
        "\\\\wsl.localhost\\{distro}{}",
        unix_path.replace('/', "\\")
    )
}
```

**Example Failure:**
```
distro = "Ubuntu 24.04"
unix_path = "/home/user/file.txt"
Result: "\\wsl.localhost\Ubuntu 24.04\home\user\file.txt"  ← Invalid UNC path!
Expected: "\\wsl.localhost\Ubuntu%2024.04\home\user\file.txt" or escaping
```

**Impact:** Any file path referencing from WSL to Windows with distros containing spaces will fail.

---

### 6. HOME and PATH Environment Variables Not Synced to WSL
**Location:** `src-tauri/src/terminal/pty.rs` lines 165-175  
**Severity:** HIGH  
**Description:**
The PTY environment setup only sets `TERM`, `COLORTERM`, and `JEAN_WORKTREE_PATH`. It doesn't translate `HOME`, `PWD`, or other standard environment variables to their WSL equivalents.

**Current Code:**
```rust
cmd.cwd(&host_cwd);
cmd.env("TERM", "xterm-256color");
cmd.env("COLORTERM", "truecolor");
cmd.env("JEAN_WORKTREE_PATH", &jean_worktree_path);
```

**Missing:**
- `HOME` should point to WSL home, not Windows home
- `PWD` should be the WSL path, not Windows cwd
- `PATH` should be inherited from WSL, not Windows
- `TMPDIR` should be WSL's temp, not Windows temp

**Impact:** Shell operations in the terminal might behave unexpectedly. Tools relying on `$HOME` will look in the wrong place.

---

### 7. Rapid WSL Config Changes Can Create Race Conditions
**Location:** `src-tauri/src/platform/wsl.rs` and `src-tauri/src/lib.rs`  
**Severity:** HIGH  
**Description:**
The `OnceLock` pattern means `update_wsl_config()` only works once. If the user rapidly changes WSL settings in the UI, only the first update takes effect.

**Current Code:**
```rust
pub fn update_wsl_config(enabled: bool, distro: String) {
    if let Some(lock) = WSL_CONFIG.get() {
        if let Ok(mut guard) = lock.write() {
            guard.enabled = enabled;
            guard.distro = distro;
        }
    }
    // If OnceLock was never initialized, this silently does nothing!
}
```

**Scenario:**
1. User enables WSL with Ubuntu
2. App reads settings and initializes `OnceLock`
3. User switches to Debian in preferences
4. `update_wsl_config(true, "Debian")` is called
5. ✓ Works fine if OnceLock was initialized
6. But if settings are saved BEFORE `load_preferences_sync` is called, the update will be lost

**Impact:** Distro switching might not take effect until app restart.

---

### 8. Codex Server and Cursor Chat Execution Don't Route Through WSL
**Location:** `src-tauri/src/chat/codex_server.rs` and `src-tauri/src/chat/cursor.rs` (referenced in initial report)  
**Severity:** HIGH  
**Description:**
Long-lived server processes (Codex server) might be started without WSL routing, even though the initial CLI binary was resolved to a WSL path.

**Impact:** Server processes launched from the app will fail or run on the wrong system.

---

## MEDIUM PRIORITY ISSUES

### 9. Invalid Distro Selection Disables WSL Instead of Recovering
**Location:** `src-tauri/src/lib.rs` lines 1644-1670  
**Severity:** MEDIUM  
**Description:**
If a distro becomes unavailable (renamed, uninstalled) while the app is running, the auto-recovery is good, but the UI isn't immediately updated. User sees WSL enabled but it's been disabled in the background.

**Current Recovery:**
```rust
if let Some(first_distro) = available_distros.first() {
    log::warn!("Selected WSL distro '{}' is unavailable; switching to '{}'",
        preferences.wsl_distro, first_distro);
    preferences.wsl_distro = first_distro.clone();
    return true;
}

log::warn!("WSL was enabled but no distros are available; disabling WSL");
preferences.wsl_enabled = false;  // ← Good recovery
preferences.wsl_distro.clear();
true
```

**Issue:** If a distro is removed (no distros available) and the app has long-running operations, they'll fail without user visibility.

---

## ANALYSIS OF RECENTLY FIXED ITEMS (from previous hardening pass)

The following were identified and fixed in the `bc863ae` commit:

✅ **Fixed:** PTY launch WSL-safe path handling  
✅ **Fixed:** Cursor/Codex chat execution routing  
✅ **Fixed:** Process termination with process tree awareness  
✅ **Fixed:** WSL-aware status checks  
✅ **Fixed:** RTK and Caveman plugin handling  

---

## EDGE CASE SCENARIOS NOT FULLY TESTED

### Scenario 1: User Removes Selected Distro While Terminal is Open
**Expected:** Terminal should gracefully handle or notify user
**Current:** Unknown - needs testing

### Scenario 2: App Restarts While WSL-Spawned Process is Running
**Expected:** Process cleanup should work correctly
**Current:** Untested on Windows + WSL

### Scenario 3: Distro Name Contains Parentheses or Quotes
**Example:** `"My (Dev) Distro"` or `"Dev's Ubuntu"`
**Status:** Partially safe (`.arg()` methods are safe, but string building might fail)

### Scenario 4: WSL Distro has Spaces in Home Directory Path
**Location:** Affects env variable translation
**Status:** Not translated

### Scenario 5: Terminal with Mixed Windows and WSL Commands
**Example:** `echo foo && wsl bash -c "echo bar"`
**Status:** Might have double-wrapping issues

### Scenario 6: File Paths with Internationalized Characters
**Example:** `/mnt/c/Users/用户/file.txt`
**Status:** Unicode handling in path translation untested

---

## SUMMARY TABLE

| Issue | Severity | Location | Impact | Tested |
|-------|----------|----------|--------|--------|
| Untranslated env vars in detached spawn | CRITICAL | detached.rs:200-230 | Build failures, tool errors | ❌ No |
| UTF-16LE odd byte count | CRITICAL | wsl.rs:200-220 | Distro list disappears | ❌ No |
| Distro name command injection (low risk) | MEDIUM | wsl.rs:110-130 | Potential exploit | ⚠️ Mitigated by `.arg()` |
| Network/UNC paths not handled | HIGH | wsl.rs:50-75 | Network share access fails | ❌ No |
| Distro name in UNC path | HIGH | wsl.rs:85-100 | Spaces in distro name fail | ❌ No |
| HOME/PATH not synced to PTY | HIGH | pty.rs:165-175 | Shell behaves unexpectedly | ❌ No |
| Rapid config changes lost | HIGH | wsl.rs:OnceLock pattern | Settings don't persist | ⚠️ Likely safe |
| Codex server routing | HIGH | codex_server.rs | Server fails in WSL mode | ❌ No |
| Invalid distro recovery | MEDIUM | lib.rs:1644-1670 | Silent WSL disabling | ❌ No |

---

## RECOMMENDATIONS

### Immediate Fixes (Production Risk)
1. **Fix detached spawn env var translation** - blocks all tool execution with custom paths
2. **Fix UTF-16LE decoding** - prevents distro list corruption
3. **Validate distro names** - prevent edge cases with special characters
4. **Sync HOME/PATH to PTY** - shell behavior depends on this

### Nice-to-Have Improvements
1. Handle network/UNC paths gracefully
2. Better recovery UI for distro changes
3. Extended path support (`\\?\C:\path`)
4. MCP server WSL routing verification

### Testing Required
1. Windows + actual WSL2 environment
2. Edge case distro names (spaces, unicode, special chars)
3. Rapid preference changes
4. Long-lived process cleanup
5. Network share access from WSL

---

## Branch Status
- Current branch: `wsl_support`
- Latest commit: `bc863ae fix(wsl): harden WSL execution paths`
- Issues identified in this scan: 8 concrete edge cases
- Production safety level: MEDIUM (critical issues found)

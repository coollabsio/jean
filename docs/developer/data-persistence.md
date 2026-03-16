# Data Persistence

Patterns for saving and loading data to disk, including preferences, emergency data recovery, and cleanup strategies.

## Quick Start

### Preferences Pattern

```typescript
// Loading preferences
const { data: preferences, isLoading } = useQuery({
  queryKey: ['preferences'],
  queryFn: () => invoke<AppPreferences>('load_preferences'),
})

// Saving preferences
const updatePreferences = useMutation({
  mutationFn: (prefs: AppPreferences) =>
    invoke('save_preferences', { preferences: prefs }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['preferences'] })
  },
})
```

### Emergency Data Pattern

```typescript
// Save emergency data
await invoke('save_emergency_data', {
  filename: 'unsaved-work',
  data: { content: 'user data', timestamp: Date.now() },
})

// Load emergency data
const recoveryData = await invoke('load_emergency_data', {
  filename: 'unsaved-work',
})
```

## Architecture

### File System Organization

Data is stored in the app's data directory:

```
~/Library/Application Support/com.myapp.app/  (macOS)
├── preferences.json                          # App preferences
└── recovery/                                 # Emergency data
    ├── unsaved-work.json
    ├── crash-report-2024-01-15.json
    └── ...
```

### Rust Backend Implementation

All file operations are handled by Rust for security and reliability:

```rust
// src-tauri/src/lib.rs
fn get_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("preferences.json"))
}
```

## Preferences System

### Data Structure

Define preferences as a Rust struct:

```rust
// src-tauri/src/lib.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPreferences {
    pub theme: String,
    // Add new persistent preferences here:
    // pub auto_save: bool,
    // pub language: String,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            // Add defaults for new preferences here
        }
    }
}
```

### Atomic Write Pattern

All file writes use atomic operations to prevent corruption:

```rust
#[tauri::command]
async fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    let prefs_path = get_preferences_path(&app)?;

    let json_content = serde_json::to_string_pretty(&preferences)
        .map_err(|e| format!("Failed to serialize preferences: {e}"))?;

    // Write to temporary file with UUID for safety, then rename (atomic operation)
    let temp_path = prefs_path.with_file_name(format!(
        "{}.{}.tmp",
        prefs_path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));

    std::fs::write(&temp_path, json_content)
        .map_err(|e| format!("Failed to write preferences file: {e}"))?;

    std::fs::rename(&temp_path, &prefs_path)
        .map_err(|e| format!("Failed to finalize preferences file: {e}"))?;

    Ok(())
}
```

**Note:** Using UUID in temp filenames (instead of just `.tmp`) prevents conflicts when multiple writes happen concurrently.

### Loading with Defaults

```rust
#[tauri::command]
async fn load_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    let prefs_path = get_preferences_path(&app)?;

    if !prefs_path.exists() {
        log::info!("Preferences file not found, using defaults");
        return Ok(AppPreferences::default());
    }

    let contents = std::fs::read_to_string(&prefs_path)
        .map_err(|e| format!("Failed to read preferences file: {e}"))?;

    let preferences: AppPreferences = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse preferences: {e}"))?;

    Ok(preferences)
}
```

### React Integration

Use TanStack Query for preferences management:

```typescript
// src/services/preferences.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

export interface AppPreferences {
  theme: string
}

export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: () => invoke<AppPreferences>('load_preferences'),
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (preferences: AppPreferences) =>
      invoke('save_preferences', { preferences }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
    },
  })
}
```

## Emergency Data Recovery

### Use Cases

- Save unsaved work before app crashes
- Store temporary data during long operations
- Backup user data before risky operations

### Implementation

```rust
// src-tauri/src/lib.rs
#[tauri::command]
async fn save_emergency_data(
    app: AppHandle,
    filename: String,
    data: Value
) -> Result<(), String> {
    // Validate filename (basic safety check)
    if filename.contains("..") || filename.contains("/") || filename.contains("\\") {
        return Err("Invalid filename".to_string());
    }

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize emergency data: {e}"))?;

    // Atomic write pattern
    let temp_path = file_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content)
        .map_err(|e| format!("Failed to write emergency data file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize emergency data file: {e}"))?;

    Ok(())
}
```

### React Usage

```typescript
// Save emergency data before risky operation
const saveEmergencyData = async (data: any) => {
  try {
    await invoke('save_emergency_data', {
      filename: `backup-${Date.now()}`,
      data,
    })
  } catch (error) {
    console.error('Failed to save emergency data:', error)
  }
}

// Recovery on app startup
const checkForRecoveryData = async () => {
  try {
    const recoveryData = await invoke('load_emergency_data', {
      filename: 'unsaved-work',
    })
    if (recoveryData) {
      // Show recovery dialog to user
      setRecoveryData(recoveryData)
      setShowRecoveryDialog(true)
    }
  } catch (error) {
    // No recovery data available - this is normal
  }
}
```

## Cleanup Strategies

### Automatic Cleanup

Clean up old recovery files to prevent disk bloat:

```rust
#[tauri::command]
async fn cleanup_old_recovery_files(app: AppHandle) -> Result<u32, String> {
    let recovery_dir = get_recovery_dir(&app)?;
    let mut removed_count = 0;

    // Calculate cutoff time (7 days ago)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get current time: {e}"))?
        .as_secs();
    let seven_days_ago = now - (7 * 24 * 60 * 60);

    let entries = std::fs::read_dir(&recovery_dir)
        .map_err(|e| format!("Failed to read recovery directory: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let path = entry.path();

        // Only process JSON files
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to get file metadata: {e}"))?;

        let modified = metadata.modified()
            .map_err(|e| format!("Failed to get file modification time: {e}"))?;

        let modified_secs = modified.duration_since(UNIX_EPOCH)
            .map_err(|e| format!("Failed to convert modification time: {e}"))?
            .as_secs();

        // Remove if older than 7 days
        if modified_secs < seven_days_ago {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove old recovery file: {e}"))?;
            removed_count += 1;
        }
    }

    Ok(removed_count)
}
```

### Scheduled Cleanup

```typescript
// Run cleanup on app startup
useEffect(() => {
  const runCleanup = async () => {
    try {
      const removedCount = await invoke<number>('cleanup_old_recovery_files')
      if (removedCount > 0) {
        logger.info(`Cleaned up ${removedCount} old recovery files`)
      }
    } catch (error) {
      logger.error('Failed to cleanup old recovery files:', error)
    }
  }

  // Run cleanup 5 seconds after app start
  const timer = setTimeout(runCleanup, 5000)
  return () => clearTimeout(timer)
}, [])
```

## Security Considerations

### Filename Validation

Always validate filenames to prevent path traversal attacks:

```rust
// Comprehensive filename validation using regex
fn validate_filename(filename: &str) -> Result<(), String> {
    // Regex pattern: only alphanumeric, dash, underscore, dot
    let filename_pattern = Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .map_err(|e| format!("Regex compilation error: {e}"))?;

    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.len() > 100 {
        return Err("Filename too long (max 100 characters)".to_string());
    }

    if !filename_pattern.is_match(filename) {
        return Err(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed"
                .to_string(),
        );
    }

    Ok(())
}

// Theme validation
fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err("Invalid theme: must be 'light', 'dark', or 'system'".to_string()),
    }
}

// Generic string input validation
fn validate_string_input(input: &str, max_len: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_len {
        return Err(format!("{field_name} too long (max {max_len} characters)"));
    }
    Ok(())
}
```

### Directory Permissions

Ensure proper directory creation and permissions:

```rust
fn get_recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let recovery_dir = app_data_dir.join("recovery");

    // Ensure the recovery directory exists
    std::fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("Failed to create recovery directory: {e}"))?;

    Ok(recovery_dir)
}
```

## Adding New Data Types

### Step 1: Define Rust Struct

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MyDataType {
    pub field1: String,
    pub field2: i32,
}

impl Default for MyDataType {
    fn default() -> Self {
        Self {
            field1: "default".to_string(),
            field2: 0,
        }
    }
}
```

### Step 2: Add Tauri Commands

```rust
#[tauri::command]
async fn load_my_data(app: AppHandle) -> Result<MyDataType, String> {
    // Implementation similar to load_preferences
}

#[tauri::command]
async fn save_my_data(app: AppHandle, data: MyDataType) -> Result<(), String> {
    // Implementation similar to save_preferences
}
```

### Step 3: Create React Hooks

```typescript
// src/services/my-data.ts
export function useMyData() {
  return useQuery({
    queryKey: ['my-data'],
    queryFn: () => invoke<MyDataType>('load_my_data'),
  })
}

export function useUpdateMyData() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: MyDataType) => invoke('save_my_data', { data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-data'] })
    },
  })
}
```

### Step 4: Register Commands

```rust
// src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    load_my_data,
    save_my_data,
])
```

## UI State Persistence

The app persists UI state (sidebar sizes, active worktree, expanded folders) across restarts using the `useUIStatePersistence` hook.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Zustand Stores                          │
│  useChatStore / useUIStore / useProjectsStore                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ subscribe + debounce (500ms)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                useUIStatePersistence hook                        │
│  - Tracks previous values to detect changes                     │
│  - Converts Sets to arrays for JSON serialization               │
│  - Debounces saves to avoid excessive writes                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ invoke('save_ui_state')
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Tauri Backend (Rust)                             │
│  ui-state.json in app data directory                            │
└─────────────────────────────────────────────────────────────────┘
```

### Key Implementation Details

```typescript
// src/hooks/useUIStatePersistence.ts

// Debounce saves to avoid excessive disk writes
const debouncedSave = debounce((state: UIState) => {
  saveUIState(state)
}, 500)

// Convert Sets to arrays for JSON serialization
const getCurrentUIState = (): UIState => {
  const { fixedReviewFindings } = useChatStore.getState()

  return {
    // ...other fields
    fixed_review_findings: Object.fromEntries(
      Object.entries(fixedReviewFindings).map(([k, v]) => [k, Array.from(v)])
    ),
  }
}

// Track previous values to detect actual changes
let prevExpandedProjectIds = useProjectsStore.getState().expandedProjectIds
const unsubProjects = useProjectsStore.subscribe(state => {
  if (state.expandedProjectIds !== prevExpandedProjectIds) {
    prevExpandedProjectIds = state.expandedProjectIds
    debouncedSave(getCurrentUIState())
  }
})
```

### Keybindings Persistence

Keybindings are stored in preferences.json with a migration pattern:

```typescript
// src/services/preferences.ts

// Old defaults that have changed - used for migration
const MIGRATED_KEYBINDINGS: Partial<Record<string, string>> = {
  toggle_left_sidebar: 'mod+1', // Changed to 'mod+b'
}

// Migrate: if stored value matches old default, use new default
function migrateKeybindings(
  stored: KeybindingsMap | undefined
): KeybindingsMap {
  if (!stored) return DEFAULT_KEYBINDINGS

  const migrated = { ...stored }
  for (const [action, oldDefault] of Object.entries(MIGRATED_KEYBINDINGS)) {
    if (stored[action] === oldDefault) {
      migrated[action] = DEFAULT_KEYBINDINGS[action]
    }
  }
  return migrated
}
```

## Best Practices

1. **Use atomic writes**: Always write to temp file then rename
2. **Validate inputs**: Check filenames and data before writing
3. **Handle defaults**: Provide sensible defaults when files don't exist
4. **Log operations**: Log all file operations for debugging
5. **Use TanStack Query**: Let TanStack Query handle caching and state management
6. **Regular cleanup**: Implement cleanup for temporary/recovery data
7. **Error handling**: Provide meaningful error messages
8. **Security first**: Validate all user inputs and file paths

The data persistence system provides a robust, secure foundation for saving application state and user data while maintaining performance and reliability.

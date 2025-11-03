package install

// BashZshWrapper is the wrapper function for bash and zsh shells
const BashZshWrapper = `# BEGIN GCOOL INTEGRATION
# gcool - Git Worktree TUI Manager shell wrapper
# Source this in your shell rc file to enable gcool with directory switching

gcool() {
    local debug_log="/tmp/gcool-wrapper-debug.log"
    local debug_enabled=false

    # Check if debug logging is enabled in config
    if [ -f "$HOME/.config/gcool/config.json" ]; then
        if grep -q '"debug_logging_enabled"\s*:\s*true' "$HOME/.config/gcool/config.json"; then
            debug_enabled=true
        fi
    fi

    if [ "$debug_enabled" = "true" ]; then
    echo "DEBUG wrapper: gcool function called with args: $@" >> "$debug_log"
    fi
    # Loop until user explicitly quits gcool (not just detaches from tmux)
    while true; do
        # Save current PATH to restore it later
        local saved_path="$PATH"

        # Create a temp file for communication
        local temp_file=$(mktemp)

        # Set environment variable so gcool knows to write to file
        GCOOL_SWITCH_FILE="$temp_file" command gcool "$@"
        local exit_code=$?

        # Restore PATH if it got corrupted
        if [ -z "$PATH" ] || [ "$PATH" != "$saved_path" ]; then
            export PATH="$saved_path"
        fi

        # Check if switch info was written
        if [ -f "$temp_file" ] && [ -s "$temp_file" ]; then
        if [ "$debug_enabled" = "true" ]; then
        echo "DEBUG wrapper: switch file exists and has content" >> "$debug_log"
        fi
        # Read the switch info: path|branch|auto-claude|target-window|script-command|claude-session-name|is-claude-initialized
        local switch_info=$(cat "$temp_file")
        if [ "$debug_enabled" = "true" ]; then
        echo "DEBUG wrapper: switch_info=$switch_info" >> "$debug_log"
        fi
        # Only remove if it's in /tmp (safety check)
        if [[ "$temp_file" == /tmp/* ]] || [[ "$temp_file" == /var/folders/* ]]; then
            rm "$temp_file"
        fi

        # Parse the info (using worktree_path instead of path to avoid PATH conflict)
        IFS='|' read -r worktree_path branch auto_claude target_window script_command claude_session_name is_claude_initialized <<< "$switch_info"

        # Check if we got valid data (has at least two pipes)
        if [[ "$switch_info" == *"|"*"|"* ]]; then
            # Check if tmux is available
            if ! command -v tmux >/dev/null 2>&1; then
                # No tmux, just cd
                cd "$worktree_path" || return
                echo "Switched to worktree: $branch (no tmux)"
                return
            fi

            # Sanitize branch name for tmux session
            local session_name="gcool-${branch//[^a-zA-Z0-9\-_]/-}"
            session_name="${session_name//--/-}"
            session_name="${session_name#-}"
            session_name="${session_name%-}"

            # Check if already in a tmux session and if it's the same session we want
            if [ -n "$TMUX" ]; then
                # Get current tmux session name
                local current_session=$(tmux display-message -p '#S')
                if [ "$current_session" = "$session_name" ]; then
                    # Already in the correct session, just cd
                    cd "$worktree_path" || return
                    echo "Switched to worktree: $branch"
                    return
                fi
                # Different session - fall through to switch to it
            fi

            # Set window index based on target window
            # Note: with base-index 1, windows are 1, 2, 3... instead of 0, 1, 2...
            local window_index="1"
            if [ "$target_window" = "claude" ]; then
                window_index="2"
            fi

            # Check if session exists
            if tmux has-session -t "=$session_name" 2>/dev/null; then
                # Session exists - check if target window exists
                if ! tmux list-windows -t "$session_name" -F "#{window_index}:#{window_name}" | grep -q "^${window_index}:"; then
                    # Target window doesn't exist, create it
                    if [ "$target_window" = "claude" ]; then
                        # Create claude window with claude command
                        if command -v claude >/dev/null 2>&1; then
                            if [ "$is_claude_initialized" = "true" ]; then
                                # Try with --continue first, fallback to fresh start if it fails
                                tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude --continue --permission-mode plan || claude --permission-mode plan"
                            else
                                tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude --permission-mode plan"
                            fi
                        else
                            # Fallback to shell if claude not available
                            tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude"
                        fi
                    else
                        # Create terminal window
                        tmux new-window -t "$session_name:1" -c "$worktree_path" -n "terminal"
                    fi
                fi
                # Attach to target window
                tmux attach-session -t "$session_name:${window_index}"
                continue
            else
                # Create new session with both windows
                if [ "$debug_enabled" = "true" ]; then
                    echo "DEBUG wrapper: Creating new session: $session_name" >> "$debug_log"
                fi
                # Window 1: terminal (always created) - base-index 1 makes first window = 1
                tmux new-session -d -s "$session_name" -c "$worktree_path" -n "terminal"

                # Window 2: claude (if auto-claude is true)
                if [ "$auto_claude" = "true" ]; then
                    if command -v claude >/dev/null 2>&1; then
                        if [ "$is_claude_initialized" = "true" ]; then
                            # Try with --continue first, fallback to fresh start if it fails
                            tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude --continue --permission-mode plan || claude --permission-mode plan"
                        else
                            tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude --permission-mode plan"
                        fi
                    else
                        # Fallback: create window with shell
                        tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude"
                    fi
                fi

                # Attach to target window
                tmux attach-session -t "$session_name:${window_index}"
                continue
            fi
        else
            return 1
        fi
        else
            # No switch file, user quit gcool without selecting a worktree
            # Only remove if it's in /tmp (safety check)
            if [[ "$temp_file" == /tmp/* ]] || [[ "$temp_file" == /var/folders/* ]]; then
                rm -f "$temp_file"
            fi
            # Exit the loop
            return $exit_code
        fi
    done
}
# END GCOOL INTEGRATION
`

// FishWrapper is the wrapper function for fish shell
const FishWrapper = `# BEGIN GCOOL INTEGRATION
# gcool - Git Worktree TUI Manager shell wrapper (Fish shell)
# Source this in your config.fish to enable gcool with directory switching

function gcool
    # Check if debug logging is enabled in config
    set debug_enabled false
    if test -f "$HOME/.config/gcool/config.json"
        if grep -q '"debug_logging_enabled"\s*:\s*true' "$HOME/.config/gcool/config.json"
            set debug_enabled true
        end
    end

    # Loop until user explicitly quits gcool (not just detaches from tmux)
    while true
        # Create a temp file for communication
        set temp_file (mktemp)

        # Set environment variable so gcool knows to write to file
        set -x GCOOL_SWITCH_FILE $temp_file
        command gcool $argv
        set exit_code $status

        # Check if switch info was written
        if test -f "$temp_file" -a -s "$temp_file"
            # Read the switch info: path|branch|auto-claude|target-window|script-command|claude-session-name|is-claude-initialized
            set switch_info (cat $temp_file)
            rm $temp_file

            # Parse the info (using worktree_path instead of path to avoid PATH conflict)
            set parts (string split '|' $switch_info)

            # Check if we got valid data (has at least 3 parts)
            if test (count $parts) -ge 3
                set worktree_path $parts[1]
                set branch $parts[2]
                set auto_claude $parts[3]
                set target_window "terminal"
                if test (count $parts) -ge 4
                    set target_window $parts[4]
                end
                set claude_session_name ""
                if test (count $parts) -ge 6
                    set claude_session_name $parts[6]
                end
                set is_claude_initialized "false"
                if test (count $parts) -ge 7
                    set is_claude_initialized $parts[7]
                end

                # Check if tmux is available
                if not command -v tmux &> /dev/null
                    # No tmux, just cd
                    cd $worktree_path
                    echo "Switched to worktree: $branch (no tmux)"
                    return
                end

                # Sanitize branch name for tmux session
                set session_name "gcool-"(string replace -ra '[^a-zA-Z0-9\-_]' '-' $branch)
                set session_name (string replace -ra '--+' '-' $session_name)
                set session_name (string trim -c '-' $session_name)

                # Check if already in a tmux session
                if test -n "$TMUX"
                    # Already in tmux, just cd
                    cd $worktree_path
                    echo "Switched to worktree: $branch"
                    echo "Note: Already in tmux. Session: $session_name would be available outside tmux."
                    return
                end

                # Set window index based on target window
                # Note: with base-index 1, windows are 1, 2, 3... instead of 0, 1, 2...
                set window_index "1"
                if test "$target_window" = "claude"
                    set window_index "2"
                end

                # Check if session exists
                if tmux has-session -t "=$session_name" 2>/dev/null
                    # Session exists - check if target window exists
                    set window_exists (tmux list-windows -t "$session_name" -F "#{window_index}:#{window_name}" | grep "^${window_index}:" | wc -l)
                    if test $window_exists -eq 0
                        # Target window doesn't exist, create it
                        if test "$target_window" = "claude"
                            # Create claude window
                            if command -v claude &> /dev/null
                                set claude_args "--permission-mode plan"
                                if test "$is_claude_initialized" = "true"
                                    # Try with --continue first, fallback to fresh start if it fails
                                    set claude_args "--continue --permission-mode plan; or claude --permission-mode plan"
                                end
                                tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude $claude_args"
                            else
                                # Fallback to shell
                                tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude"
                            end
                        else
                            # Create terminal window
                            tmux new-window -t "$session_name:1" -c "$worktree_path" -n "terminal"
                        end
                    end
                    # Attach to target window
                    tmux attach-session -t "$session_name:${window_index}"
                    continue
                else
                    # Create new session with both windows
                    # Window 1: terminal (always created) - base-index 1 makes first window = 1
                    tmux new-session -d -s "$session_name" -c "$worktree_path" -n "terminal"

                    # Window 2: claude (if auto-claude is true)
                    if test "$auto_claude" = "true"
                        if command -v claude &> /dev/null
                            set claude_args "--permission-mode plan"
                            if test "$is_claude_initialized" = "true"
                                # Try with --continue first, fallback to fresh start if it fails
                                set claude_args "--continue --permission-mode plan; or claude --permission-mode plan"
                            end
                            tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude" "claude $claude_args"
                        else
                            # Fallback: create window with shell
                            tmux new-window -t "$session_name:2" -c "$worktree_path" -n "claude"
                        end
                    end

                    # Attach to target window
                    tmux attach-session -t "$session_name:${window_index}"
                    continue
                end
            end
        else
            # No switch file, just clean up
            rm -f $temp_file
            # Exit the loop
            return $exit_code
        end
    end
end
# END GCOOL INTEGRATION
`

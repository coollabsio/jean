package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/coollabsio/jean/config"
	"github.com/coollabsio/jean/install"
	"github.com/coollabsio/jean/internal/update"
	versionpkg "github.com/coollabsio/jean/internal/version"
	"github.com/coollabsio/jean/tui"
)

const version = "0.1.0"

// Global flag for debug logging (set after config is loaded)
var debugLoggingEnabled bool = false

// debugLog writes a message to the debug log file if logging is enabled
func debugLog(msg string) {
	if !debugLoggingEnabled {
		return
	}
	if f, err := os.OpenFile("/tmp/jean-debug.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
		fmt.Fprintf(f, "%s\n", msg)
		f.Close()
	}
}

func main() {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "Fatal error: %v\n", r)
			os.Exit(1)
		}
	}()

	// Check for unsupported Windows (native, not WSL2)
	if runtime.GOOS == "windows" {
		if !isRunningInWSL() {
			fmt.Fprintf(os.Stderr, "Error: jean requires WSL2 on Windows\n\n")
			fmt.Fprintf(os.Stderr, "jean depends on tmux and bash/zsh/fish, which are not available on native Windows.\n")
			fmt.Fprintf(os.Stderr, "Please install and use WSL2 (Windows Subsystem for Linux 2) to run Jean.\n\n")
			fmt.Fprintf(os.Stderr, "For installation instructions, see:\n")
			fmt.Fprintf(os.Stderr, "  https://docs.microsoft.com/en-us/windows/wsl/install\n")
			os.Exit(1)
		}
	}

	// Auto-initialize shell integration if not already done
	// Skip this check for init, version, help, and if already attempted (prevent infinite loop)
	shouldCheckInit := true
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "init", "version", "help":
			shouldCheckInit = false
		}
	}

	if shouldCheckInit && os.Getenv("JEAN_INIT_ATTEMPTED") == "" {
		if err := ensureShellIntegration(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Could not auto-initialize shell integration: %v\n", err)
			fmt.Fprintf(os.Stderr, "You can run 'jean init' manually to set up shell integration.\n")
		}
	}

	// Check if the first argument is a subcommand
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "init":
			handleInit()
			return
		case "update":
			handleUpdate()
			return
		case "version":
			fmt.Printf("jean version %s\n", version)
			os.Exit(0)
		case "help":
			printHelp()
			os.Exit(0)
		}
	}

	// Parse flags
	pathFlag := flag.String("path", ".", "Path to git repository (default: current directory)")
	noClaudeFlag := flag.Bool("no-claude", false, "Don't auto-start Claude CLI in tmux session")
	versionFlag := flag.Bool("version", false, "Print version and exit")
	helpFlag := flag.Bool("help", false, "Show help")

	flag.Parse()

	// Handle flags
	if *versionFlag {
		fmt.Printf("jean version %s\n", version)
		os.Exit(0)
	}

	if *helpFlag {
		printHelp()
		os.Exit(0)
	}

	// Get repo path and auto-claude setting
	repoPath := *pathFlag
	autoClaude := !*noClaudeFlag

	// Check for updates (non-blocking, happens in background)
	// This check is rate-limited to once every 10 minutes
	go versionpkg.CheckLatestVersionOfCli(false)

	// Create and run TUI
	model := tui.NewModel(repoPath, autoClaude)

	// Enable debug logging if configured
	if model.GetConfigManager() != nil {
		debugLoggingEnabled = model.GetConfigManager().GetDebugLoggingEnabled()
	}

	p := tea.NewProgram(model, tea.WithAltScreen())

	finalModel, err := p.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error running TUI: %v\n", err)
		os.Exit(1)
	}

	// Check if we need to switch directories
	if m, ok := finalModel.(tui.Model); ok {
		switchInfo := m.GetSwitchInfo()
		if switchInfo.Path != "" {
			// Format: path|branch|auto-claude|target-window|script-command|session-name|is-claude-initialized
			autoCl := "false"
			if switchInfo.AutoClaude {
				autoCl = "true"
			}
			targetWindow := switchInfo.TargetWindow
			if targetWindow == "" {
				targetWindow = "terminal" // Default to terminal window if not set
			}
			isInitialized := "false"
			if switchInfo.IsClaudeInitialized {
				isInitialized = "true"
			}
			switchData := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s", switchInfo.Path, switchInfo.Branch, autoCl, targetWindow, switchInfo.ScriptCommand, switchInfo.SessionName, isInitialized)

			// Debug: log what we're writing
			debugLog(fmt.Sprintf("DEBUG main: switchInfo={Path:%q Branch:%q AutoClaude:%v TargetWindow:%q SessionName:%q}", switchInfo.Path, switchInfo.Branch, switchInfo.AutoClaude, switchInfo.TargetWindow, switchInfo.SessionName))
			debugLog(fmt.Sprintf("DEBUG main: switchData=%q (has %d fields)", switchData, strings.Count(switchData, "|")+1))
			fmt.Fprintf(os.Stderr, "DEBUG main: SessionName=%q\n", switchInfo.SessionName)

			// Check if we should write to a file (for shell wrapper integration)
			if switchFile := os.Getenv("JEAN_SWITCH_FILE"); switchFile != "" {
				// Write to file for shell wrapper
				if err := os.WriteFile(switchFile, []byte(switchData), 0600); err != nil {
					debugLog(fmt.Sprintf("Warning: could not write switch file: %v", err))
				}
				// Verify what was written
				contents, _ := os.ReadFile(switchFile)
				debugLog(fmt.Sprintf("DEBUG main: file contents=%q", string(contents)))
			} else {
				// Print to stdout (legacy behavior)
				fmt.Println(switchData)
			}
		}
	}
}

// ensureShellIntegration checks if shell integration is installed and active.
// Automatically installs or updates wrapper if needed using checksum comparison.
// Returns nil if wrapper is already active, otherwise performs init/update and re-exec.
func ensureShellIntegration() error {
	// Check if wrapper is already active
	if os.Getenv("JEAN_SWITCH_FILE") != "" {
		// Wrapper is active, but check if it needs update
		cfg, err := config.NewManager()
		if err != nil {
			// Config load failed, continue anyway (non-critical)
			return nil
		}

		detector, err := install.NewDetector()
		if err != nil {
			// Detector creation failed, continue anyway (non-critical)
			return nil
		}

		// Check if update is needed (compare checksums)
		if detector.NeedsUpdate(cfg) {
			// Silently update wrapper in background
			if err := detector.AutoUpdate(cfg); err != nil {
				// Update failed, but wrapper is still functional (non-critical)
				// Just log to debug if enabled
				debugLog(fmt.Sprintf("Wrapper auto-update failed: %v", err))
			} else {
				// Update succeeded
				debugLog("Wrapper auto-updated successfully")
			}
		}

		return nil // Wrapper is active, continue to TUI
	}

	// Set flag to prevent infinite loop
	os.Setenv("JEAN_INIT_ATTEMPTED", "1")

	// Load config for checksum tracking
	cfg, err := config.NewManager()
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	// Create detector
	detector, err := install.NewDetector()
	if err != nil {
		return fmt.Errorf("failed to create detector: %w", err)
	}

	// Check if wrapper needs installation or update
	if detector.NeedsUpdate(cfg) {
		wasInstalled := detector.IsInstalled()

		// Perform auto-update (handles both install and update)
		if err := detector.AutoUpdate(cfg); err != nil {
			return fmt.Errorf("failed to setup wrapper: %w", err)
		}

		// Show appropriate message
		if wasInstalled {
			fmt.Fprintf(os.Stderr, "✓ Shell wrapper updated\n")
		} else {
			fmt.Fprintf(os.Stderr, "✓ Shell integration installed\n")
		}
	}

	// Source the RC file and re-execute jean in the same shell session
	if err := sourceAndReexec(detector); err != nil {
		return fmt.Errorf("failed to source and re-execute: %w", err)
	}

	return nil
}

// sourceAndReexec sources the RC file and re-executes jean with the wrapper active.
// It uses shell tricks to source the RC file and then call jean again.
func sourceAndReexec(detector *install.Detector) error {
	// Get the shell command to use
	shellPath := os.Getenv("SHELL")
	if shellPath == "" {
		shellPath = "/bin/bash"
	}
	shellName := filepath.Base(shellPath)

	// Build the command that sources the RC file and re-executes jean
	// For both bash/zsh and fish, we source the RC file and then re-execute jean
	// This ensures JEAN_SWITCH_FILE will be set (by the wrapper function in RC file)
	var sourceCmd string
	if shellName == "fish" {
		// Fish uses different syntax
		sourceCmd = fmt.Sprintf("source %s; %s", detector.RCFile, strings.Join(os.Args, " "))
	} else {
		// For bash/zsh
		sourceCmd = fmt.Sprintf("source %s; %s", detector.RCFile, strings.Join(os.Args, " "))
	}

	// Create command to execute shell with source and jean re-exec
	cmd := exec.Command(shellPath, "-c", sourceCmd)

	// Copy environment variables but ensure JEAN_INIT_ATTEMPTED is still set
	cmd.Env = os.Environ()
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Use syscall.Exec to replace the current process
	// This way the new shell becomes the foreground process
	execErr := syscall.Exec(shellPath, []string{shellName, "-c", sourceCmd}, cmd.Env)
	if execErr != nil {
		return fmt.Errorf("failed to execute shell: %w", execErr)
	}

	return nil
}

func handleInit() {
	// Parse init subcommand flags
	initCmd := flag.NewFlagSet("init", flag.ExitOnError)
	updateFlag := initCmd.Bool("update", false, "Update existing jean integration")
	removeFlag := initCmd.Bool("remove", false, "Remove jean integration")
	dryRunFlag := initCmd.Bool("dry-run", false, "Show what would be done without making changes")
	shellFlag := initCmd.String("shell", "", "Specify shell (bash, zsh, fish). Auto-detected if not specified")

	initCmd.Parse(os.Args[2:])

	detector, err := install.NewDetector()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Override shell if specified
	if *shellFlag != "" {
		switch *shellFlag {
		case "bash":
			detector.Shell = install.Bash
			detector.RCFile = install.GetRCFileForShell(install.Bash, detector.HomeDir)
		case "zsh":
			detector.Shell = install.Zsh
			detector.RCFile = install.GetRCFileForShell(install.Zsh, detector.HomeDir)
		case "fish":
			detector.Shell = install.Fish
			detector.RCFile = install.GetRCFileForShell(install.Fish, detector.HomeDir)
		default:
			fmt.Fprintf(os.Stderr, "Error: unknown shell '%s'\n", *shellFlag)
			os.Exit(1)
		}
	}

	fmt.Printf("Detected shell: %s\n", detector.Shell)
	fmt.Printf("RC file: %s\n", detector.RCFile)

	var err2 error
	if *removeFlag {
		err2 = detector.Remove(*dryRunFlag)
	} else if *updateFlag {
		err2 = detector.Update(*dryRunFlag)
	} else {
		err2 = detector.Install(*dryRunFlag)
	}

	if err2 != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err2)
		os.Exit(1)
	}
}

// GetRCFileForShell is exported from install package wrapper
func getRCFileForShell(shell install.Shell, homeDir string) string {
	switch shell {
	case install.Zsh:
		return filepath.Join(homeDir, ".zshrc")
	case install.Fish:
		return filepath.Join(homeDir, ".config", "fish", "config.fish")
	case install.Bash:
		fallthrough
	default:
		return filepath.Join(homeDir, ".bashrc")
	}
}

func printHelp() {
	fmt.Printf(`jean - A Cool TUI for Git Worktrees & Running CLI-Based AI Assistants Simultaneously v%s

A beautiful terminal user interface for managing Git worktrees with integrated tmux
session management, letting you run multiple Claude CLI sessions across different
branches effortlessly.

USAGE:
    jean [OPTIONS]
    jean init [FLAGS]

COMMANDS:
    init            Install or manage jean shell integration
    update          Update jean to the latest version
    help            Show this help message
    version         Print version and exit

MAIN OPTIONS:
    -path <path>    Path to git repository (default: current directory)
    -no-claude      Don't auto-start Claude CLI in tmux session
    -help           Show this help message
    -version        Print version and exit

INIT COMMAND FLAGS:
    -update         Update existing jean integration
    -remove         Remove jean integration
    -dry-run        Show what would be done without making changes
    -shell <shell>  Specify shell (bash, zsh, fish). Auto-detected if not specified

KEYBINDINGS:
    Navigation:
        ↑/k         Move up
        ↓/j         Move down

    Actions:
        Enter       Switch to selected worktree
        n           Create new worktree with new branch
        a           Create worktree from existing branch
        d           Delete selected worktree
        r           Refresh worktree list
        R           Run 'run' script on selected worktree
        q/Ctrl+C    Quit

    Modal Navigation:
        Tab         Cycle through inputs/buttons
        Enter       Confirm action
        Esc         Cancel/close modal

SHELL INTEGRATION SETUP:
    One-time setup to enable directory switching:

        jean init

    This will auto-detect your shell and install the necessary wrapper.
    After installation, restart your terminal or run: source ~/.bashrc (or ~/.zshrc, etc.)

    To update an existing installation:
        jean init --update

    To remove the integration:
        jean init --remove

EXAMPLES:
    # Run in current directory
    jean

    # Run for a specific repository
    jean -path /path/to/repo

    # Set up shell integration (one-time)
    jean init

    # Update shell integration
    jean init --update

    # Remove shell integration
    jean init --remove

For more information, visit: https://github.com/coollabsio/jean
`, version)
}

// isRunningInWSL checks if the application is running inside WSL (Windows Subsystem for Linux)
// It checks for the presence of /proc/version which contains "microsoft" on WSL systems
func isRunningInWSL() bool {
	content, err := os.ReadFile("/proc/version")
	if err != nil {
		return false
	}
	// Check if the /proc/version contains "microsoft" or "wsl" (case-insensitive indicators of WSL)
	versionStr := string(content)
	return contains(versionStr, "microsoft") || contains(versionStr, "wsl")
}

// contains checks if a string contains a substring (case-insensitive)
func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			c1 := toUpper(s[i+j])
			c2 := toUpper(substr[j])
			if c1 != c2 {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// toUpper converts a byte to uppercase
func toUpper(c byte) byte {
	if c >= 'a' && c <= 'z' {
		return c - 32
	}
	return c
}

// handleUpdate handles the update subcommand
func handleUpdate() {
	if err := update.UpdateJean(version); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

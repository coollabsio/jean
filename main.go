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
	"github.com/coollabsio/gcool/install"
	"github.com/coollabsio/gcool/internal/update"
	versionpkg "github.com/coollabsio/gcool/internal/version"
	"github.com/coollabsio/gcool/tui"
)

const version = "0.1.0"

func main() {
	// Check for unsupported Windows (native, not WSL2)
	if runtime.GOOS == "windows" {
		if !isRunningInWSL() {
			fmt.Fprintf(os.Stderr, "Error: gcool requires WSL2 on Windows\n\n")
			fmt.Fprintf(os.Stderr, "gcool depends on tmux and bash/zsh/fish, which are not available on native Windows.\n")
			fmt.Fprintf(os.Stderr, "Please install and use WSL2 (Windows Subsystem for Linux 2) to run gcool.\n\n")
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

	if shouldCheckInit && os.Getenv("GCOOL_INIT_ATTEMPTED") == "" {
		if err := ensureShellIntegration(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Could not auto-initialize shell integration: %v\n", err)
			fmt.Fprintf(os.Stderr, "You can run 'gcool init' manually to set up shell integration.\n")
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
			fmt.Printf("gcool version %s\n", version)
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
		fmt.Printf("gcool version %s\n", version)
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
			// Format: path|branch|auto-claude|terminal-only
			autoCl := "false"
			if switchInfo.AutoClaude {
				autoCl = "true"
			}
			termOnly := "false"
			if switchInfo.TerminalOnly {
				termOnly = "true"
			}
			switchData := fmt.Sprintf("%s|%s|%s|%s", switchInfo.Path, switchInfo.Branch, autoCl, termOnly)

			// Check if we should write to a file (for shell wrapper integration)
			if switchFile := os.Getenv("GCOOL_SWITCH_FILE"); switchFile != "" {
				// Write to file for shell wrapper
				if err := os.WriteFile(switchFile, []byte(switchData), 0600); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: could not write switch file: %v\n", err)
				}
			} else {
				// Print to stdout (legacy behavior)
				fmt.Println(switchData)
			}
		}
	}
}

// ensureShellIntegration checks if shell integration is installed and active.
// If not installed, it installs it, sources the RC file, and re-executes gcool.
// Returns nil if wrapper is already active, otherwise performs init and re-exec.
func ensureShellIntegration() error {
	// Check if wrapper is already active
	if os.Getenv("GCOOL_SWITCH_FILE") != "" {
		return nil // Wrapper is active, no need to init
	}

	// Set flag to prevent infinite loop
	os.Setenv("GCOOL_INIT_ATTEMPTED", "1")

	// Create detector
	detector, err := install.NewDetector()
	if err != nil {
		return fmt.Errorf("failed to create detector: %w", err)
	}

	// Check if already installed
	if detector.IsInstalled() {
		// Already installed, just source it and re-exec
		fmt.Fprintf(os.Stderr, "✓ Activating shell integration...\n")
		if err := sourceAndReexec(detector); err != nil {
			return fmt.Errorf("failed to source and re-execute: %w", err)
		}
		return nil
	}

	// Not installed yet, install it
	fmt.Fprintf(os.Stderr, "Setting up shell integration...\n")
	if err := detector.Install(false); err != nil {
		return fmt.Errorf("failed to install: %w", err)
	}

	// Now source the RC file and re-execute gcool in the same shell session
	if err := sourceAndReexec(detector); err != nil {
		return fmt.Errorf("failed to source and re-execute: %w", err)
	}

	return nil
}

// sourceAndReexec sources the RC file and re-executes gcool with the wrapper active.
// It uses shell tricks to source the RC file and then call gcool again.
func sourceAndReexec(detector *install.Detector) error {
	// Get the shell command to use
	shellPath := os.Getenv("SHELL")
	if shellPath == "" {
		shellPath = "/bin/bash"
	}
	shellName := filepath.Base(shellPath)

	// Build the command that sources the RC file and re-executes gcool
	// For both bash/zsh and fish, we source the RC file and then re-execute gcool
	// This ensures GCOOL_SWITCH_FILE will be set (by the wrapper function in RC file)
	var sourceCmd string
	if shellName == "fish" {
		// Fish uses different syntax
		sourceCmd = fmt.Sprintf("source %s; %s", detector.RCFile, strings.Join(os.Args, " "))
	} else {
		// For bash/zsh
		sourceCmd = fmt.Sprintf("source %s; %s", detector.RCFile, strings.Join(os.Args, " "))
	}

	// Create command to execute shell with source and gcool re-exec
	cmd := exec.Command(shellPath, "-c", sourceCmd)

	// Copy environment variables but ensure GCOOL_INIT_ATTEMPTED is still set
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
	updateFlag := initCmd.Bool("update", false, "Update existing gcool integration")
	removeFlag := initCmd.Bool("remove", false, "Remove gcool integration")
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
	fmt.Printf(`gcool - A Cool TUI for Git Worktrees & Running CLI-Based AI Assistants Simultaneously v%s

A beautiful terminal user interface for managing Git worktrees with integrated tmux
session management, letting you run multiple Claude CLI sessions across different
branches effortlessly.

USAGE:
    gcool [OPTIONS]
    gcool init [FLAGS]

COMMANDS:
    init            Install or manage gcool shell integration
    update          Update gcool to the latest version
    help            Show this help message
    version         Print version and exit

MAIN OPTIONS:
    -path <path>    Path to git repository (default: current directory)
    -no-claude      Don't auto-start Claude CLI in tmux session
    -help           Show this help message
    -version        Print version and exit

INIT COMMAND FLAGS:
    -update         Update existing gcool integration
    -remove         Remove gcool integration
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
        q/Ctrl+C    Quit

    Modal Navigation:
        Tab         Cycle through inputs/buttons
        Enter       Confirm action
        Esc         Cancel/close modal

SHELL INTEGRATION SETUP:
    One-time setup to enable directory switching:

        gcool init

    This will auto-detect your shell and install the necessary wrapper.
    After installation, restart your terminal or run: source ~/.bashrc (or ~/.zshrc, etc.)

    To update an existing installation:
        gcool init --update

    To remove the integration:
        gcool init --remove

EXAMPLES:
    # Run in current directory
    gcool

    # Run for a specific repository
    gcool -path /path/to/repo

    # Set up shell integration (one-time)
    gcool init

    # Update shell integration
    gcool init --update

    # Remove shell integration
    gcool init --remove

For more information, visit: https://github.com/coollabsio/gcool
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
	if err := update.UpdateGcool(version); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

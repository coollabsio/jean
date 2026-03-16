#!/bin/bash
# tauri-dev-rdp.sh - Development script for Linux remote desktop (RDP/xrdp) environments
#
# This script automatically detects RDP sessions and sets appropriate environment
# variables for software rendering to avoid noisy EGL/Mesa/ZINK warnings.
#
# Usage:
#   ./scripts/tauri-dev-rdp.sh        # Auto-detect RDP and set env vars
#   ./scripts/tauri-dev-rdp.sh --force # Force software rendering mode
#
# Or via bun:
#   bun run tauri:dev:rdp             # Auto-detect
#   bun run tauri:dev:rdp -- --force  # Force software rendering

set -e

FORCE_SOFTWARE_RENDERING=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --force)
      FORCE_SOFTWARE_RENDERING=true
      shift
      ;;
  esac
done

# Detect if running in RDP/remote session
detect_remote_session() {
  # Check for xrdp session
  if [ -n "$DISPLAY" ] && pgrep -x xrdp-sesman > /dev/null 2>&1; then
    return 0
  fi

  # Check if DISPLAY points to a remote X session
  if [ -n "$DISPLAY" ] && [[ "$DISPLAY" == *:1* ]] && [ -n "$XRDP_SESSION" ]; then
    return 0
  fi

  # Check for common remote session indicators
  if [ -n "$SSH_CLIENT" ] || [ -n "$SSH_TTY" ]; then
    # SSH session with X forwarding
    if [ -n "$DISPLAY" ]; then
      return 0
    fi
  fi

  # Check loginctl for remote session type
  if command -v loginctl &> /dev/null; then
    local session_type
    session_type=$(loginctl show-session "$(loginctl | grep "$(whoami)" | awk '{print $1}' | head -1)" -p Type --value 2>/dev/null || echo "")
    if [ "$session_type" = "x11" ]; then
      # Additional check: no DRI device accessible usually means remote
      if [ ! -e /dev/dri/card0 ] || [ ! -r /dev/dri/card0 ]; then
        return 0
      fi
    fi
  fi

  return 1
}

# Set software rendering environment
setup_software_rendering() {
  echo "🖥️  Enabling software rendering for remote desktop environment..."
  export LIBGL_ALWAYS_SOFTWARE=1
  export GDK_BACKEND=x11
  export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
  # Reduce Mesa/EGL debug noise
  export MESA_DEBUG=silent
  export EGL_LOG_LEVEL=fatal
}

# Main
if [ "$FORCE_SOFTWARE_RENDERING" = true ]; then
  echo "🔧 Force mode: enabling software rendering"
  setup_software_rendering
elif detect_remote_session; then
  echo "📡 Remote desktop session detected"
  setup_software_rendering
else
  echo "🖥️  Local session detected, using default rendering"
fi

echo "🚀 Starting Tauri development server..."
exec bun run tauri:dev

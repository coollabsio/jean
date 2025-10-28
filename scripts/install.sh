#!/bin/bash

# gcool installer script
# Downloads and installs gcool from GitHub releases
# Usage: curl -fsSL https://gcool.sh/install.sh | bash

set -e

# Configuration
REPO="coollabsio/gcool"
GITHUB_API="https://api.github.com/repos/$REPO"
INSTALL_DIR=""
VERSION=""
USE_USER_DIR=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --user)
            USE_USER_DIR=true
            shift
            ;;
        --system)
            USE_USER_DIR=false
            shift
            ;;
        --help)
            echo "Usage: $0 [OPTIONS] [VERSION]"
            echo ""
            echo "OPTIONS:"
            echo "  --user              Install to ~/.local/bin (default if no sudo)"
            echo "  --system            Install to /usr/local/bin (requires sudo)"
            echo "  --help              Show this help message"
            echo ""
            echo "VERSION:"
            echo "  If not specified, installs the latest version"
            echo "  Examples: v0.1.0, 0.1.0"
            exit 0
            ;;
        *)
            VERSION="$1"
            shift
            ;;
    esac
done

# Detect OS and Architecture
detect_platform() {
    local os=""
    local arch=""

    case "$(uname -s)" in
        Linux*)
            os="linux"
            ;;
        Darwin*)
            os="darwin"
            ;;
        MINGW* | MSYS* | CYGWIN*)
            echo -e "${RED}Error: Windows is not directly supported${NC}"
            echo "Please use WSL2 (Windows Subsystem for Linux 2)"
            exit 1
            ;;
        *)
            echo -e "${RED}Error: Unsupported OS: $(uname -s)${NC}"
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64 | amd64)
            arch="amd64"
            ;;
        arm64 | aarch64)
            arch="arm64"
            ;;
        armv7l)
            arch="arm"
            ;;
        *)
            echo -e "${RED}Error: Unsupported architecture: $(uname -m)${NC}"
            exit 1
            ;;
    esac

    echo "$os:$arch"
}

# Get the latest version from GitHub API
get_latest_version() {
    local response
    response=$(curl -s "${GITHUB_API}/releases/latest")

    if echo "$response" | grep -q "\"tag_name\""; then
        echo "$response" | grep '"tag_name"' | head -1 | cut -d'"' -f4
    else
        echo ""
    fi
}

# Download and extract gcool
download_and_extract() {
    local version="$1"
    local platform="$2"
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT

    # Clean version (remove 'v' prefix if present)
    local clean_version="${version#v}"

    # Construct download URL
    local filename="gcool_${clean_version}_${platform}.tar.gz"
    local download_url="${GITHUB_API}/releases/download/${version}/${filename}"

    echo "Downloading gcool ${clean_version} for ${platform}..."
    if ! curl -fsSL -o "$temp_dir/$filename" "$download_url"; then
        echo -e "${RED}Error: Failed to download gcool from ${download_url}${NC}"
        exit 1
    fi

    echo "Extracting gcool..."
    if ! tar -xzf "$temp_dir/$filename" -C "$temp_dir"; then
        echo -e "${RED}Error: Failed to extract gcool${NC}"
        exit 1
    fi

    # Find the gcool binary
    local binary_path
    binary_path=$(find "$temp_dir" -name "gcool" -type f | head -1)
    if [ -z "$binary_path" ]; then
        echo -e "${RED}Error: gcool binary not found in archive${NC}"
        exit 1
    fi

    chmod +x "$binary_path"
    echo "$binary_path"
}

# Install to the specified directory
install_binary() {
    local binary_path="$1"
    local install_dir="$2"

    # Create install directory if it doesn't exist
    if [ ! -d "$install_dir" ]; then
        mkdir -p "$install_dir"
    fi

    # Check if we have permission to write
    if [ ! -w "$install_dir" ]; then
        if [ "$install_dir" = "/usr/local/bin" ]; then
            echo "Attempting to install to $install_dir (requires sudo)..."
            if ! sudo cp "$binary_path" "$install_dir/gcool"; then
                echo -e "${RED}Error: Failed to install gcool to $install_dir${NC}"
                echo "Please ensure you have sudo privileges or use --user flag"
                exit 1
            fi
            if ! sudo chmod +x "$install_dir/gcool"; then
                echo -e "${RED}Error: Failed to set execute permissions${NC}"
                exit 1
            fi
        else
            echo -e "${RED}Error: No write permission for $install_dir${NC}"
            exit 1
        fi
    else
        cp "$binary_path" "$install_dir/gcool"
        chmod +x "$install_dir/gcool"
    fi
}

# Main installation logic
main() {
    echo -e "${GREEN}gcool Installer${NC}"
    echo ""

    # Detect platform
    local platform
    platform=$(detect_platform)
    echo "Platform: $platform"

    # Determine version to install
    if [ -z "$VERSION" ]; then
        echo "Detecting latest version..."
        VERSION=$(get_latest_version)
        if [ -z "$VERSION" ]; then
            echo -e "${RED}Error: Could not detect latest version${NC}"
            exit 1
        fi
    fi

    echo "Version: $VERSION"

    # Determine installation directory
    if [ "$USE_USER_DIR" = true ]; then
        INSTALL_DIR="$HOME/.local/bin"
    else
        # Try to detect if we can use /usr/local/bin
        if [ -w "/usr/local/bin" ]; then
            INSTALL_DIR="/usr/local/bin"
        else
            echo "No write permission to /usr/local/bin, using ~/.local/bin"
            INSTALL_DIR="$HOME/.local/bin"
        fi
    fi

    echo "Install directory: $INSTALL_DIR"
    echo ""

    # Check if already installed
    if [ -f "$INSTALL_DIR/gcool" ]; then
        local installed_version
        installed_version=$("$INSTALL_DIR/gcool" version 2>/dev/null | grep -oP '(?<=version )[^ ]*' || echo "unknown")
        echo "gcool is already installed (version: $installed_version)"
        echo ""
        read -p "Do you want to update to $VERSION? (y/n) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Installation cancelled."
            exit 0
        fi
    fi

    # Download and extract
    echo "Downloading gcool..."
    local binary_path
    binary_path=$(download_and_extract "$VERSION" "${platform//:/_}")

    # Install
    echo "Installing gcool to $INSTALL_DIR..."
    install_binary "$binary_path" "$INSTALL_DIR"

    echo ""
    echo -e "${GREEN}✓ Successfully installed gcool $VERSION${NC}"
    echo ""
    echo "To get started, run: $INSTALL_DIR/gcool --help"

    # Check if install dir is in PATH
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo ""
        echo -e "${YELLOW}Warning: $INSTALL_DIR is not in your PATH${NC}"
        if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
            echo "Add it to your shell configuration file (~/.bashrc, ~/.zshrc, etc.):"
            echo "  export PATH=\"\$PATH:\$HOME/.local/bin\""
        fi
    fi
}

main "$@"

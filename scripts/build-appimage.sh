#!/usr/bin/env bash
# Build AppImage with WebKitGTK compatibility fix for rolling-release distros.
#
# The default AppImage bundles libraries from Ubuntu 22.04 which conflict
# with newer system libraries on Arch Linux, Fedora 40+, etc. This script:
# 1. Builds the AppImage normally via Tauri (bundleMediaFramework ships
#    GStreamer plugins WebKit needs — see issue #100)
# 2. Replaces AppRun with a custom script that prefers system WebKitGTK
#    and wires GST_PLUGIN_PATH to bundled/system plugins
# 3. Repackages the AppImage
#
# Usage: bash scripts/build-appimage.sh
#
# Related issues:
# - https://github.com/coollabsio/jean/issues/52
# - https://github.com/coollabsio/jean/issues/55
# - https://github.com/coollabsio/jean/issues/71
# - https://github.com/coollabsio/jean/issues/100

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MACHINE_ARCH="$(uname -m)"  # "x86_64" or "aarch64"
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/appimage"
APPDIR="$BUNDLE_DIR/Jean.AppDir"
CUSTOM_APPRUN="$SCRIPT_DIR/appimage-webkit-fix.sh"
LINUXDEPLOY_BIN="${HOME}/.cache/tauri/linuxdeploy-${MACHINE_ARCH}.AppImage"
LINUXDEPLOY_PLUGIN_BIN="${HOME}/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"

if [ "$(uname -s)" != "Linux" ]; then
    echo "ERROR: AppImage builds are supported only on Linux hosts."
    echo "Current host: $(uname -s)"
    echo "Run this command in Linux CI or a Linux environment."
    exit 1
fi

echo "==> Building AppImage via Tauri..."
cd "$PROJECT_DIR"
NO_STRIP=true bun run tauri build --bundles appimage 2>&1 || {
    echo "Tauri build failed, trying manual linuxdeploy fallback..."
    if [ ! -x "$LINUXDEPLOY_BIN" ]; then
        echo "ERROR: linuxdeploy not found/executable at $LINUXDEPLOY_BIN"
        exit 1
    fi
    cd "$BUNDLE_DIR"
    NO_STRIP=1 "$LINUXDEPLOY_BIN" --appdir Jean.AppDir --output appimage
}

if [ ! -d "$APPDIR" ]; then
    echo "ERROR: AppDir not found at $APPDIR"
    exit 1
fi

if [ ! -f "$CUSTOM_APPRUN" ]; then
    echo "ERROR: Custom AppRun script not found at $CUSTOM_APPRUN"
    exit 1
fi

echo "==> Replacing AppRun with WebKitGTK compatibility fix..."
cp "$APPDIR/AppRun" "$APPDIR/AppRun.original"
cp "$CUSTOM_APPRUN" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"

echo "==> Repackaging AppImage..."
cd "$BUNDLE_DIR"

# Remove old AppImage files
rm -f Jean*.AppImage

if [ ! -x "$LINUXDEPLOY_PLUGIN_BIN" ]; then
    echo "ERROR: linuxdeploy appimage plugin not found/executable at $LINUXDEPLOY_PLUGIN_BIN"
    exit 1
fi

# Keep NO_STRIP in the repack phase too (Arch/Fedora RELR compatibility).
NO_STRIP=1 ARCH="$MACHINE_ARCH" "$LINUXDEPLOY_PLUGIN_BIN" --appdir Jean.AppDir 2>&1

# Rename to standard naming convention
ARCH_LABEL="amd64"
if [ "$MACHINE_ARCH" = "aarch64" ]; then
    # Convention: "arm64" (not "aarch64") — must match jean.build download page
    ARCH_LABEL="arm64"
fi

OUTPUT_NAME="Jean-${MACHINE_ARCH}.AppImage"
if [ -f "$OUTPUT_NAME" ]; then
    VERSION=$(grep '"version"' "$PROJECT_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
    FINAL_NAME="Jean_${VERSION}_${ARCH_LABEL}.AppImage"
    mv "$OUTPUT_NAME" "$FINAL_NAME"
    echo "==> AppImage built successfully: $BUNDLE_DIR/$FINAL_NAME"

    echo "==> Creating updater artifact (.tar.gz)..."
    tar -czf "${FINAL_NAME}.tar.gz" "$FINAL_NAME"

    if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
        echo "==> Signing updater artifact..."
        cd "$PROJECT_DIR"
        bun run tauri signer sign \
            --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
            --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
            "$BUNDLE_DIR/${FINAL_NAME}.tar.gz"
        echo "==> Updater artifacts created: ${FINAL_NAME}.tar.gz + .sig"
    else
        echo "WARN: TAURI_SIGNING_PRIVATE_KEY not set, skipping signature"
    fi
else
    echo "ERROR: Repackaging failed"
    exit 1
fi

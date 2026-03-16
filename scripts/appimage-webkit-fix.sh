#!/usr/bin/env bash
# Custom AppRun: Fix WebKitGTK compatibility across Linux distros
#
# Problem: The default AppRun.wrapped binary hardcodes LD_LIBRARY_PATH to
# prioritize bundled Ubuntu 22.04 libraries. On newer distros, these bundled
# libraries conflict with system libraries, causing blank/white screens or crashes.
#
# There are two distinct failure modes:
#
# 1. Rolling-release distros (Arch, Fedora 40+): Bundled WebKitGTK conflicts
#    with system GPU drivers and Mesa, causing blank screens.
#
# 2. Ubuntu 24.04+: The AppImage bundles GLib 2.72, but system GIO modules
#    require GLib 2.76+ (g_task_set_static_name). When the bundled old GLib is
#    loaded, system GIO modules fail, and WebKitWebProcess crashes with:
#      GLib-GObject-WARNING: invalid (NULL) pointer instance
#      g_signal_connect_data: assertion 'G_TYPE_CHECK_INSTANCE (instance)' failed
#
# Additionally, the AppImage bundles libgstreamer but no GStreamer plugins,
# so the bundled GStreamer can never find audio elements like autoaudiosink.
#
# Solution: Prefer system libraries when system WebKitGTK is available (covers
# both GLib and GStreamer), and prevent loading incompatible GIO modules.
#
# Related issues:
# - https://github.com/coollabsio/jean/issues/52
# - https://github.com/coollabsio/jean/issues/54
# - https://github.com/coollabsio/jean/issues/55
# - https://github.com/coollabsio/jean/issues/71
# - https://github.com/coollabsio/jean/issues/100

set -eu

APPDIR="$(dirname "$(readlink -f "$0")")"
export APPDIR
ARCH_TRIPLET="$(uname -m)-linux-gnu"
BUNDLED_LIBS="$APPDIR/usr/lib:$APPDIR/usr/lib/$ARCH_TRIPLET:$APPDIR/usr/lib64:$APPDIR/lib:$APPDIR/lib/$ARCH_TRIPLET"
SYSTEM_LIBS="/usr/lib:/usr/lib64:/usr/lib/$ARCH_TRIPLET:/lib/$ARCH_TRIPLET"
EXISTING_LIBS="${LD_LIBRARY_PATH:-}"

# Source GTK plugin hooks (sets GDK_BACKEND, GTK_THEME, etc.)
for hook in "$APPDIR"/apprun-hooks/*.sh; do
    [ -f "$hook" ] && . "$hook"
done

# If system WebKitGTK 4.1 is available, prefer system libs first but keep bundled libs
# available as fallback so AppImage-provided libs still resolve when needed.
# This also ensures the system's GLib is used (avoiding the g_task_set_static_name
# symbol mismatch) and the system's GStreamer with its plugins is reachable.
if [ -f /usr/lib/libwebkit2gtk-4.1.so.0 ] \
    || [ -f /usr/lib64/libwebkit2gtk-4.1.so.0 ] \
    || [ -f "/usr/lib/$ARCH_TRIPLET/libwebkit2gtk-4.1.so.0" ]; then
    export LD_LIBRARY_PATH="$SYSTEM_LIBS:$BUNDLED_LIBS"

    # When using system libs, override GIO_EXTRA_MODULES set by the GTK hook.
    # The hook points GIO_EXTRA_MODULES to the AppImage's bundled GIO modules,
    # but these were built against the bundled old GLib. With system GLib loaded
    # first, we should use the system's GIO modules instead.
    unset GIO_EXTRA_MODULES
else
    # Fallback: use bundled libraries (standard AppImage behavior).
    # Prevent loading system GIO modules that may require a newer GLib than
    # what the AppImage bundles (e.g., system expects g_task_set_static_name
    # from GLib 2.76+ but AppImage ships GLib 2.72).
    export GIO_MODULE_DIR=/dev/null
    export LD_LIBRARY_PATH="$BUNDLED_LIBS"
fi

# Preserve any user-supplied LD_LIBRARY_PATH entries at the end.
if [ -n "$EXISTING_LIBS" ]; then
    export LD_LIBRARY_PATH="${LD_LIBRARY_PATH}:$EXISTING_LIBS"
fi

export PATH="$APPDIR/usr/bin:$PATH"
export XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

exec "$APPDIR/usr/bin/jean" "$@"

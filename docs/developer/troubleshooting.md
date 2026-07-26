# Troubleshooting Guide

## Linux Graphics Issues

### White Screen on Ubuntu 24.04+ (AppImage)

**Error Messages:**

```
/usr/lib/x86_64-linux-gnu/gvfs/libgvfscommon.so: undefined symbol: g_task_set_static_name
Failed to load module: /usr/lib/x86_64-linux-gnu/gio/modules/libgvfsdbus.so
GStreamer element autoaudiosink not found. Please install it
(WebKitWebProcess): GLib-GObject-WARNING: invalid (NULL) pointer instance
(WebKitWebProcess): GLib-GObject-CRITICAL: g_signal_connect_data: assertion 'G_TYPE_CHECK_INSTANCE (instance)' failed
```

**Root Cause:**
The AppImage bundles GLib 2.72 (from the Ubuntu 22.04 build host), but Ubuntu 24.04 has GLib 2.80. When the bundled old GLib is loaded, system GIO modules that require `g_task_set_static_name` (added in GLib 2.76) fail. This cascading failure crashes WebKitWebProcess, resulting in a white/blank screen.

Additionally, older AppImages bundled `libgstreamer` without GStreamer plugins, so WebKit could not create `appsrc` / `appsink` / `autoaudiosink` and the renderer process died.

**Fix (current releases):**
1. Custom AppRun (`scripts/appimage-webkit-fix.sh`) prefers system libraries when system WebKitGTK is available, and sets `GST_PLUGIN_PATH` to bundled/system plugin dirs.
2. AppImage packaging enables `bundleMediaFramework` so required GStreamer plugins ship inside the AppImage.
3. Jean sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` and `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux before creating the webview.

If you have an older AppImage without these fixes, work around by extracting and running with system libs:

```bash
# Extract
./Jean_VERSION_amd64.AppImage --appimage-extract

# Run with system GLib
GIO_MODULE_DIR=/dev/null LD_LIBRARY_PATH="/usr/lib/x86_64-linux-gnu:squashfs-root/usr/lib:squashfs-root/usr/lib/x86_64-linux-gnu" squashfs-root/usr/bin/jean
```

Alternatively, install the `.deb` package which uses system libraries directly.

**Related Issues:** [#54](https://github.com/coollabsio/jean/issues/54), [#100](https://github.com/coollabsio/jean/issues/100)

---

### Required Linux Dependencies (dev / .deb / system WebKit path)

WebKitGTK needs GStreamer plugins at runtime. Without them, the WebKit renderer can crash with a blank screen even outside AppImage.

**Debian/Ubuntu/Linux Mint:**

```bash
sudo apt install gstreamer1.0-plugins-good
```

**Arch/Manjaro:**

```bash
sudo pacman -S gst-plugins-good
```

**Fedora:**

```bash
sudo dnf install gstreamer1-plugins-good
```

**Symptoms of missing GStreamer plugins:**

- Blank/gray window with no content
- `GStreamer element autoaudiosink not found` in terminal
- `GLib-GObject-CRITICAL: invalid (NULL) pointer instance` errors

---

### GBM Buffer Errors

**Error Message:**

```
Failed to create GBM buffer of size NxN: Invalid argument
```

**Context:**
This error occurs when running Tauri applications on Linux with:

- Transparent window configuration (`"transparent": true`)
- NVIDIA GPU (especially with newer drivers)
- Wayland or X11 display servers
- WebKitGTK-based webview

**Root Cause:**
Incompatibility between WebKitGTK's hardware-accelerated compositing and certain GPU drivers/compositors, particularly:

1. GBM (Generic Buffer Manager) buffer allocation issues
2. DMABUF (Direct Memory Access Buffer) renderer problems
3. EGL context creation failures with transparent surfaces

---

## Automatic Fixes

Jean applies the following environment variables on Linux **before** the webview starts
(`src-tauri/src/platform/linux_webkit.rs`, called from `src-tauri/src/lib.rs`):

### Default (performance-oriented)

- `WEBKIT_DISABLE_DMABUF_RENDERER=1` — Disables the DMABUF renderer (common GBM error cause) without forcing full software compositing

User-set values are never overwritten.

### Opt-in safe graphics (stability over speed)

Software compositing avoids some driver bugs but is much slower on low-power CPUs
(for example Intel N-series). It is **not** enabled by default.

```bash
export JEAN_SAFE_GRAPHICS=1
# equivalent direct override:
export WEBKIT_DISABLE_COMPOSITING_MODE=1
```

### Optional X11 Backend Force

If Wayland causes issues, force X11 (non-AppImage only):

```bash
export JEAN_FORCE_X11=1
```

This sets `GDK_BACKEND=x11` when not already set. AppImage runs ignore `JEAN_FORCE_X11`
because AppRun/apprun-hooks own the backend choice.

---

## Manual Overrides

### Re-enable DMABUF / full GPU path (may cause GBM errors)

```bash
export WEBKIT_DISABLE_DMABUF_RENDERER=0
export WEBKIT_DISABLE_COMPOSITING_MODE=0
```

### Prefer maximum stability (software compositing)

```bash
export JEAN_SAFE_GRAPHICS=1
```

### Alternative: NVIDIA-specific Fixes

If issues persist on NVIDIA hardware:

```bash
export __NV_DISABLE_EXPLICIT_SYNC=1
# or full safe mode:
export JEAN_SAFE_GRAPHICS=1
```

### Software Rendering (last resort)

```bash
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=softpipe
```

---

## Related Issues

**Tauri Core Issues:**

- [tauri-apps/tauri#13493](https://github.com/tauri-apps/tauri/issues/13493) - Failed to create GBM buffer of size 2560x1440: Invalid argument
- [tauri-apps/tauri#8254](https://github.com/tauri-apps/tauri/issues/8254) - Empty window, Failed to create GBM device
- [tauri-apps/tauri#9394](https://github.com/tauri-apps/tauri/issues/9394) - Documenting Nvidia problems in Tauri
- [tauri-apps/tauri#10702](https://github.com/tauri-apps/tauri/issues/10702) - Error 71 (Protocol error) dispatching to Wayland display
- [tauri-apps/tauri#8308](https://github.com/tauri-apps/tauri/issues/8308) - V2 window.transparent not work
- [tauri-apps/tauri#12800](https://github.com/tauri-apps/tauri/issues/12800) - Webview doesn't update when window is transparent

**Wry Library Issues:**

- [tauri-apps/wry#1366](https://github.com/tauri-apps/wry/issues/1366) - Wry cannot create windows on Arch Linux with Nvidia
- [tauri-apps/wry#1319](https://github.com/tauri-apps/wry/issues/1319) - Linux X11 winit and transparency not working

**WebKitGTK Bugs:**

- [WebKitGTK #261874](https://bugs.webkit.org/show_bug.cgi?id=261874) - REGRESSION: GTK 3 rendering broken with 2.42 on NVIDIA graphics
- [WebKitGTK #165246](https://bugs.webkit.org/show_bug.cgi?id=165246) - Fails to draw in Wayland with enabled compositing mode (RESOLVED with `WEBKIT_DISABLE_COMPOSITING_MODE=1`)
- [WebKitGTK #281279](https://bugs.webkit.org/show_bug.cgi?id=281279) - GTK3: invisible HTML rendering, "AcceleratedSurfaceDMABuf was unable to construct a complete framebuffer"

**Community Reports:**

- [opcode#26](https://github.com/winfunc/opcode/issues/26) - Failed to create GBM buffer of size 800x600: Invalid argument
- [claudia#26](https://github.com/getAsterisk/claudia/issues/26) - Same error on Arch Linux

---

## Platform-Specific Notes

### NVIDIA GPUs

- **Most Affected:** Higher frequency of GBM buffer errors
- **Known Workarounds:** `JEAN_SAFE_GRAPHICS=1` (or `WEBKIT_DISABLE_COMPOSITING_MODE=1`) is most reliable
- **Performance Impact:** Software compositing is noticeably slower than GPU-accelerated — only enable when needed
- **Alternative:** Consider using older NVIDIA drivers or switching to X11

### AMD/Intel GPUs

- **Generally Less Affected:** Fewer reported GBM errors
- **Compositor Support:** Better Wayland compositor compatibility
- **Transparency:** Usually works without special configuration
- **Performance:** Keep GPU compositing enabled (default). Full software compositing can peg low-power Intel CPUs during chat streaming (see [#129](https://github.com/coollabsio/jean/issues/129))

### Desktop Environments

**GNOME (Wayland):**

- **Issue:** Wayland's lack of transparent window decorations
- **Solution:** Prefer Wayland by default; use `JEAN_FORCE_X11=1` only if transparency/compositing fails

**KDE Plasma (Wayland):**

- **Issue:** Similar to GNOME, but generally better compositing support
- **Solution:** May work with Wayland if compositor supports transparency

**X11 (GNOME/MATE/XFCE):**

- **Issue:** Requires compositing manager (Picom, Compton, etc.)
- **Solution:** Works well with compositing enabled
- **Requirement:** Install compositing manager if not provided by DE

---

## Testing Your Setup

After making changes, test with:

```bash
# Clear environment and restart Jean
unset WEBKIT_DISABLE_COMPOSITING_MODE
unset WEBKIT_DISABLE_DMABUF_RENDERER
unset JEAN_SAFE_GRAPHICS
unset JEAN_FORCE_X11
unset GDK_BACKEND
./jean
```

Check terminal output for GBM errors:

```bash
./jean 2>&1 | grep -i "gbm\|webview\|buffer"
```

If errors appear, automatic fixes should have worked. If not, try manual overrides.

---

## When to Report

If you encounter a graphics issue not documented here:

1. **Search existing issues:** Check [Tauri issues](https://github.com/tauri-apps/tauri/issues) for similar problems
2. **Include details:**
   - Operating system and version
   - Desktop environment (GNOME/KDE/X11/Wayland)
   - GPU make and model
   - Jean version
   - Exact error message
   - Whether any manual env var changes helped

3. **Check WebKitGTK version:**

   ```bash
   webkit2gtk --version
   ```

   Known problematic versions: 2.40.x - 2.42.x (see #261874)

4. **Enable verbose logging:**
   ```bash
   JEAN_LOG=debug ./jean
   ```

---

## Related Documentation

- [Window Customization](https://v2.tauri.app/learn/window-customization/) - Tauri's official window configuration guide
- [WebKit Environment Variables](https://webkitgtk.org/reference/webkitgtk/unstable/environment-variables.html) - Complete WebKitGTK env var reference
- [Wayland - ArchWiki](https://wiki.archlinux.org/title/Wayland) - Comprehensive Wayland documentation

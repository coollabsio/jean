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

Additionally, the AppImage bundles `libgstreamer` but no GStreamer plugins, so audio element initialization fails.

**Fix:**
This is handled by the custom AppRun script (`scripts/appimage-webkit-fix.sh`) which prefers system libraries when system WebKitGTK is available. If you have an AppImage that doesn't include this fix, you can work around it by extracting and running with system libs:

```bash
# Extract
./Jean_VERSION_amd64.AppImage --appimage-extract

# Run with system GLib
GIO_MODULE_DIR=/dev/null LD_LIBRARY_PATH="/usr/lib/x86_64-linux-gnu:squashfs-root/usr/lib:squashfs-root/usr/lib/x86_64-linux-gnu" squashfs-root/usr/bin/jean
```

Alternatively, install the `.deb` package which uses system libraries directly.

**Related Issues:** [#54](https://github.com/coollabsio/jean/issues/54), [#100](https://github.com/coollabsio/jean/issues/100)

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

Jean automatically applies the following environment variables on Linux to prevent these issues:

### Primary Fixes

- `WEBKIT_DISABLE_COMPOSITING_MODE=1` - Disables hardware-accelerated compositing
- `WEBKIT_DISABLE_DMABUF_RENDERER=1` - Disables DMABUF renderer (common GBM error cause)

### Optional X11 Backend Force

If Wayland causes issues, Jean can force X11 backend (requires manual override):

- `GDK_BACKEND=x11` - Forces GTK to use X11 instead of Wayland

These fixes are applied in `src-tauri/src/lib.rs` before Tauri initialization.

---

## Manual Overrides

If automatic fixes cause performance issues (slower rendering), you can override them:

### Force Wayland (if X11 fallback isn't needed)

```bash
export JEAN_FORCE_X11=0
```

### Re-enable GPU Compositing (risky - may cause GBM errors)

```bash
export WEBKIT_DISABLE_COMPOSITING_MODE=0
export WEBKIT_DISABLE_DMABUF_RENDERER=0
```

### Alternative: NVIDIA-specific Fixes

If issues persist on NVIDIA hardware:

```bash
export __NV_DISABLE_EXPLICIT_SYNC=1
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
- **Known Workarounds:** `WEBKIT_DISABLE_COMPOSITING_MODE=1` is most reliable
- **Performance Impact:** Software rendering is noticeably slower than GPU-accelerated
- **Alternative:** Consider using older NVIDIA drivers or switching to X11

### AMD/Intel GPUs

- **Generally Less Affected:** Fewer reported GBM errors
- **Compositor Support:** Better Wayland compositor compatibility
- **Transparency:** Usually works without special configuration

### Desktop Environments

**GNOME (Wayland):**

- **Issue:** Wayland's lack of transparent window decorations
- **Solution:** Automatic X11 backend fallback or `JEAN_FORCE_X11=0`

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

/** Read a browser File as a base64 string (no data: URL prefix). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Concatenate in chunks: `binary += fromCharCode(byte)` per byte is O(n²) and
  // janks on multi-MB images; apply() over ~32KB slices keeps it linear.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

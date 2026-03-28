export function DevModeBanner() {
  if (!import.meta.env.DEV) {
    return null
  }

  return (
    <div
      data-tauri-drag-region
      className="pointer-events-none absolute top-0 right-0 left-0 z-[70] h-[3px] bg-yellow-400"
    />
  )
}

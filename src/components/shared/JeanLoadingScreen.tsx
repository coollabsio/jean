export function JeanLoadingScreen({
  message = 'Loading Jean...',
  onTop = false,
}: {
  message?: string
  onTop?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background"
      style={onTop ? { zIndex: 120 } : undefined}
    >
      <p
        role="status"
        className="whitespace-nowrap text-[16px] leading-[26px] text-muted-foreground"
        style={{
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        {message}
      </p>
    </div>
  )
}

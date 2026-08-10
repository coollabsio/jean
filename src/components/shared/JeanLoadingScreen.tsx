export function JeanLoadingScreen() {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background">
      <p
        role="status"
        className="whitespace-nowrap text-[16px] leading-[26px] text-muted-foreground"
        style={{
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        Loading Jean...
      </p>
    </div>
  )
}

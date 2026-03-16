import { Component, type ErrorInfo, type ReactNode } from 'react'
import { saveCrashState } from '@/lib/recovery'
import { logger } from '@/lib/logger'
import { copyToClipboard } from '@/lib/clipboard'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
  errorInfo?: ErrorInfo
}

/**
 * Simple error boundary that saves app state before crashes
 *
 * Automatically saves crash data to recovery files for debugging
 * Shows a user-friendly error message instead of a blank screen
 */
export class ErrorBoundary extends Component<
  Props,
  State & { copied: boolean }
> {
  private copyTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, copied: false }
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Application crashed', {
      error: error.message,
      stack: error.stack,
    })

    this.setState({ errorInfo })

    // Save crash state asynchronously (don't block error UI)
    this.saveCrashData(error, errorInfo)
  }

  private async saveCrashData(error: Error, errorInfo: ErrorInfo) {
    try {
      // Get basic app state - extend this based on your app's needs
      const appState = {
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        // Add more app state here as needed:
        // currentUser: getCurrentUser(),
        // activeFeatures: getActiveFeatures(),
        // etc.
      }

      await saveCrashState(appState, {
        error: error.message,
        stack: error.stack || 'No stack trace available',
        componentStack: errorInfo.componentStack || undefined,
      })
    } catch (saveError) {
      // Don't throw from error boundary - just log
      logger.error('Failed to save crash data', { saveError })
    }
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined })
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-background p-8">
          <div className="w-full max-w-md text-center">
            <div className="mb-6">
              <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <svg
                  className="h-8 w-8 text-destructive"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-foreground mb-2">
                Something went wrong
              </h1>
              <p className="text-muted-foreground mb-6">
                The application encountered an unexpected error. Your data has
                been saved automatically.
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={this.handleReload}
                className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Reload Application
              </button>

              <button
                onClick={this.handleReset}
                className="w-full px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90 transition-colors"
              >
                Try Again
              </button>
            </div>

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="mt-6 text-left">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                  Error Details (Development Only)
                </summary>
                <div className="mt-2 p-3 bg-muted rounded-md text-xs font-mono">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-destructive font-semibold mb-1">
                      {this.state.error.name}: {this.state.error.message}
                    </div>
                    <button
                      onClick={() => {
                        const err = this.state.error
                        if (!err) return
                        const text = `${err.name}: ${err.message}\n${err.stack ?? ''}`
                        copyToClipboard(text)
                        this.setState({ copied: true })
                        if (this.copyTimeout) clearTimeout(this.copyTimeout)
                        this.copyTimeout = setTimeout(
                          () => this.setState({ copied: false }),
                          2000
                        )
                      }}
                      className="shrink-0 px-2 py-1 text-xs rounded bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                    >
                      {this.state.copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  {this.state.error.stack && (
                    <pre className="whitespace-pre-wrap text-muted-foreground overflow-auto">
                      {this.state.error.stack}
                    </pre>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary

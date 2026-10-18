import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import App from './App'
import { queryClient } from './lib/query-client'
import { selectLocalConnectionForNativeClient } from './lib/remote-connections'

selectLocalConnectionForNativeClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function'
)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
    {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
  </QueryClientProvider>
)

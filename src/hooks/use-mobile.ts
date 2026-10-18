import * as React from 'react'
import { MOBILE_BREAKPOINT, isMobileViewport } from '@/lib/viewport'

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(isMobileViewport)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(isMobileViewport())
    }
    mql.addEventListener('change', onChange)
    setIsMobile(isMobileViewport())
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}

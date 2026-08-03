import { useLayoutEffect, useRef, type MutableRefObject } from 'react'

/** Ref that always holds the latest value; write happens in layout effect (render stays pure). */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

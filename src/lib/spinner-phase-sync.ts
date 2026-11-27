/**
 * Keep every `spin` animation on one shared phase, based on the document
 * timeline. A spinner that React unmounts and mounts again (for example when
 * several commands toggle the same loading state one after another) then
 * continues at the same angle instead of starting again from 0deg.
 *
 * Only the effect delay changes, so CSS still controls the play state
 * (`.window-blurred` pause, reduced motion).
 */
export function installSpinnerPhaseSync(): void {
  if (typeof document === 'undefined') return

  document.addEventListener(
    'animationstart',
    event => {
      if (event.animationName !== 'spin') return
      const target = event.target
      if (!(target instanceof Element) || !target.getAnimations) return

      const docNow = document.timeline?.currentTime
      if (typeof docNow !== 'number') return

      for (const anim of target.getAnimations()) {
        if (!(anim instanceof CSSAnimation) || anim.animationName !== 'spin') {
          continue
        }
        const period = Number(anim.effect?.getTiming().duration)
        const current = anim.currentTime
        if (!(period > 0) || typeof current !== 'number') continue

        const offset = (((docNow - current) % period) + period) % period
        anim.effect?.updateTiming({ delay: -offset })
      }
    },
    true
  )
}

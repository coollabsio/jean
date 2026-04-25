import { formatLocalTime } from './time-utils'

/**
 * Local hour:minute for when an assistant reply was received.
 *
 * Fine pointers keep it hidden until the surrounding `group/message` is
 * hovered. The node stays in flow so revealing it does not shift layout.
 * Coarse pointers have no hover, so the time stays visible there, matching
 * other message actions.
 */
export function MessageReceiveTime({ timestamp }: { timestamp: number }) {
  if (!(timestamp > 0)) return null

  return (
    <span className="transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/message:opacity-100">
      {' · '}
      {formatLocalTime(timestamp)}
    </span>
  )
}

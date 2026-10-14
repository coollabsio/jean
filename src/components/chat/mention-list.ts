/**
 * Chat input pickers open above the input. Render their lists bottom-up so
 * the best match sits next to the input (and the mobile keyboard) instead of
 * at the far top of the popover. Data stays best-first: index 0 is the bottom
 * row, so ArrowUp moves to the next (worse) match and ArrowDown moves back.
 *
 * `flex-col-reverse` on the scroll container also makes it start scrolled to
 * the bottom.
 */
export const BOTTOM_UP_LIST_CLASS =
  'flex flex-col-reverse [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:shrink-0 [&_[cmdk-list-sizer]]:flex-col-reverse [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col-reverse'

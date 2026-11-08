/**
 * Where the movable compare popup may sit: always fully inside the editor area,
 * so it can never cover or go above the menu and ribbon, or leave the window.
 */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  left: number
  top: number
}

/**
 * `pos` moved the least that puts a popup of `size` inside `bounds`. A popup larger
 * than the bounds is pinned to the bounds' top-left corner (its title bar stays
 * reachable).
 */
export function clampToBounds(
  pos: Point,
  size: { width: number; height: number },
  bounds: Box,
): Point {
  const maxLeft = bounds.left + Math.max(0, bounds.width - size.width)
  const maxTop = bounds.top + Math.max(0, bounds.height - size.height)
  return {
    left: Math.min(Math.max(pos.left, bounds.left), maxLeft),
    top: Math.min(Math.max(pos.top, bounds.top), maxTop),
  }
}

/** the position a drag gives: where the popup was plus how far the pointer moved, clamped */
export function dragPosition(
  start: Point,
  pointerStart: Point,
  pointerNow: Point,
  size: { width: number; height: number },
  bounds: Box,
): Point {
  return clampToBounds(
    {
      left: start.left + (pointerNow.left - pointerStart.left),
      top: start.top + (pointerNow.top - pointerStart.top),
    },
    size,
    bounds,
  )
}

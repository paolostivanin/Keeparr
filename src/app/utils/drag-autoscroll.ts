/**
 * Vertical autoscroll speed (px per animation frame) for a drag whose pointer is at `pointerY`
 * in a viewport of `viewportHeight`. Negative scrolls up, positive scrolls down, 0 is outside the
 * edge zones. Speed ramps up quadratically with depth into the zone so a drag can park near an edge.
 */
export function dragAutoScrollDelta(pointerY: number, viewportHeight: number, maxSpeed = 18) {
  if (!Number.isFinite(pointerY) || viewportHeight <= 0) return 0;
  const zone = Math.min(96, viewportHeight * 0.18);
  const ramp = (depth: number) => Math.max(1, Math.round(maxSpeed * Math.pow(Math.min(1, depth / zone), 2)));
  if (pointerY < zone) return -ramp(zone - Math.max(0, pointerY));
  if (pointerY > viewportHeight - zone) return ramp(Math.min(viewportHeight, pointerY) - (viewportHeight - zone));
  return 0;
}

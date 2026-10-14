/**
 * True when the user asked the system for less motion. CSS animations follow the global reset in styles.scss; this is
 * for the animations started from script (Web Animations API, inline transitions), which that reset cannot reach.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

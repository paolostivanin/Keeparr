export interface LayoutClock {
  requestFrame(callback: () => void): number
  cancelFrame(handle: number): void
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimer(handle: ReturnType<typeof setTimeout>): void
}

export const browserLayoutClock: LayoutClock = {
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle)
}

/**
 * Sole owner of "when does the grid repack": at most one frame is pending, an
 * unchanged signature is ignored unless forced, viewport settling is a single
 * cancellable sequence, and `dispose()` cancels everything so nothing runs
 * against a destroyed view.
 */
export class LayoutScheduler {
  private lastSignature = ''
  private frame?: number
  private settleFrames: number[] = []
  private settleTimers: ReturnType<typeof setTimeout>[] = []
  private disposed = false

  constructor(
    private readonly build: () => void,
    private readonly clock: LayoutClock = browserLayoutClock,
    /** Runs frame scheduling outside Angular's zone so layout-only work never triggers a check. */
    private readonly runOutside: (fn: () => void) => void = fn => fn()
  ) {}

  get pending() { return this.frame != null }

  request(signature: string, force = false) {
    if (this.disposed) return
    if (!force && signature === this.lastSignature) return
    this.lastSignature = signature
    if (this.frame != null) return
    this.runOutside(() => {
      this.frame = this.clock.requestFrame(() => {
        this.frame = undefined
        if (!this.disposed) this.build()
      })
    })
  }

  /**
   * Repack now, after paint, and again after each delay. Replaces an
   * in-progress sequence, because WebViews report rotation before the final
   * layout viewport has settled.
   */
  settle(signature: () => string, delays: readonly number[]) {
    if (this.disposed) return
    this.cancelSettle()
    this.request(signature(), true)
    const outer = this.clock.requestFrame(() => {
      const inner = this.clock.requestFrame(() => this.request(signature(), true))
      this.settleFrames.push(inner)
    })
    this.settleFrames.push(outer)
    for (const delay of delays) {
      this.settleTimers.push(this.clock.setTimer(() => this.request(signature(), true), delay))
    }
  }

  private cancelSettle() {
    this.settleFrames.forEach(handle => this.clock.cancelFrame(handle))
    this.settleFrames = []
    this.settleTimers.forEach(handle => this.clock.clearTimer(handle))
    this.settleTimers = []
  }

  dispose() {
    this.disposed = true
    this.cancelSettle()
    if (this.frame != null) this.clock.cancelFrame(this.frame)
    this.frame = undefined
  }
}

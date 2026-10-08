import { LayoutClock, LayoutScheduler } from './layout-scheduler';

class FakeClock implements LayoutClock {
  frames = new Map<number, () => void>();
  timers = new Map<number, { cb: () => void; ms: number }>();
  private next = 1;
  requestFrame(cb: () => void) { const id = this.next++; this.frames.set(id, cb); return id; }
  cancelFrame(id: number) { this.frames.delete(id); }
  setTimer(cb: () => void, ms: number) { const id = this.next++; this.timers.set(id, { cb, ms }); return id as any; }
  clearTimer(id: any) { this.timers.delete(id); }
  flushFrames() { const pending = [...this.frames]; this.frames.clear(); pending.forEach(([, cb]) => cb()); }
  fireTimers() { const pending = [...this.timers]; this.timers.clear(); pending.forEach(([, t]) => t.cb()); }
}

describe('LayoutScheduler', () => {
  let clock: FakeClock;
  let builds: number;
  let scheduler: LayoutScheduler;
  beforeEach(() => {
    clock = new FakeClock();
    builds = 0;
    scheduler = new LayoutScheduler(() => builds++, clock);
  });

  it('coalesces requests into one frame and ignores an unchanged signature', () => {
    scheduler.request('a');
    scheduler.request('b');
    scheduler.request('c', true);
    expect(clock.frames.size).toBe(1);
    clock.flushFrames();
    expect(builds).toBe(1);
    scheduler.request('c');
    expect(clock.frames.size).toBe(0);
    scheduler.request('c', true);
    expect(clock.frames.size).toBe(1);
  });

  it('remembers the newest signature even while a frame is pending', () => {
    scheduler.request('a');
    scheduler.request('b');
    clock.flushFrames();
    scheduler.request('b');
    expect(clock.frames.size).toBe(0);
  });

  it('runs frame scheduling through the supplied outside-zone runner', () => {
    let outside = 0;
    const zoned = new LayoutScheduler(() => {}, clock, fn => { outside++; fn(); });
    zoned.request('x');
    expect(outside).toBe(1);
  });

  it('settles with an immediate, a post-paint and delayed repacks, and a new settle replaces the old one', () => {
    scheduler.settle(() => 's', [80, 220]);
    expect(clock.frames.size).toBe(2); // pending repack + first paint frame
    expect([...clock.timers.values()].map(t => t.ms)).toEqual([80, 220]);
    scheduler.settle(() => 's', [80, 220]);
    expect(clock.timers.size).toBe(2);
    clock.flushFrames();
    clock.flushFrames();
    clock.flushFrames();
    expect(builds).toBeGreaterThanOrEqual(1);
  });

  it('dispose cancels frames and timers and ignores later requests', () => {
    scheduler.settle(() => 's', [80]);
    scheduler.dispose();
    expect(clock.frames.size).toBe(0);
    expect(clock.timers.size).toBe(0);
    scheduler.request('z', true);
    expect(clock.frames.size).toBe(0);
    expect(builds).toBe(0);
  });

  it('does not build when disposed between request and frame', () => {
    scheduler.request('a');
    const callbacks = [...clock.frames.values()];
    scheduler.dispose();
    callbacks.forEach(cb => cb());
    expect(builds).toBe(0);
  });
});

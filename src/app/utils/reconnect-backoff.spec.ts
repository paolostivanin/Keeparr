import { reconnectDelay } from './reconnect-backoff';

describe('reconnectDelay', () => {
  it('doubles from the base delay and stops growing at the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map(attempt => reconnectDelay(attempt, () => 0));
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('subtracts at most the jitter fraction and tolerates odd input', () => {
    expect(reconnectDelay(0, () => 1)).toBe(1600);
    expect(reconnectDelay(0, () => 0.5)).toBe(1800);
    expect(reconnectDelay(-3, () => 0)).toBe(2000);
    expect(reconnectDelay(Number.NaN, () => 7)).toBe(1600);
  });
});

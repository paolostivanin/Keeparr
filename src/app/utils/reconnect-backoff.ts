/**
 * Delay before reconnect attempt `attempt` (0 for the first retry): doubles from `baseMs` up to `maxMs`, with up to
 * `jitter` (a fraction) subtracted so many clients do not reconnect to a restarted server in lockstep.
 */
export function reconnectDelay(attempt: number, random = Math.random, baseMs = 2000, maxMs = 30000, jitter = 0.2): number {
  const exponent = Number.isFinite(attempt) ? Math.min(Math.max(0, Math.floor(attempt)), 16) : 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(ceiling * (1 - jitter * Math.min(1, Math.max(0, random()))));
}

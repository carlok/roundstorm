/**
 * Delay before the next WebSocket reconnect attempt.
 *
 * A fixed 1.5 s retry hammered a daemon that was down for minutes; doubling up to
 * ten seconds still notices a restart quickly.
 */
export function reconnectDelay(failures: number): number {
  return Math.min(1_500 * 2 ** Math.max(0, failures), 10_000)
}

/** The only live-upstream condition a test may classify as a bot-gate skip.
 *
 * In particular ENOSPC, BUSY, timeouts and budget/server errors are not bot
 * gates. Do not widen this to status-only matching: production uses 503 for all
 * of those conditions and each one needs to remain a visible test failure.
 */
export function isUpstreamBotGate(status, body) {
  return status === 503 && body?.code === 'BOT_GATED';
}

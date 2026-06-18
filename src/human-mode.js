export function isHumanPauseExpiredState(conversationState, timeoutMinutes, now = Date.now()) {
  const timeout = Number(timeoutMinutes);
  if (!conversationState?.botPaused || !timeout || timeout <= 0) return false;
  if (!conversationState.botPausedAt) return false;

  const pausedAt = new Date(conversationState.botPausedAt).getTime();
  if (!Number.isFinite(pausedAt)) return false;

  return now - pausedAt > timeout * 60_000;
}

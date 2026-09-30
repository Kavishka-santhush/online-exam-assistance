import { createSlice } from '@reduxjs/toolkit';

/**
 * Timer slice — the candidate's exam countdown.
 *
 * This slice deliberately stores *snapshots*, not a ticking value. The reducer
 * never runs a `setInterval`; instead `hooks/useCountdown` advances a local
 * clock from `serverNow` and recomputes `remainingSec` each tick, re-syncing to
 * the server snapshot whenever an autosave/runtime response (or a socket
 * `exam:clock-*` event) arrives.
 *
 * Because `expiresAt` is absolute server time, a tampered or drifted local clock
 * is corrected on the next sync — the client can only ever *display* a slightly
 * stale countdown, never authorise one.
 */

const initialState = {
  attemptId: null,
  running: false,
  paused: false,
  expiresAt: null, // absolute ISO deadline (source of truth)
  remainingSec: null, // last synced remaining seconds
  serverNow: null, // server timestamp that `remainingSec`/`expiresAt` were taken at
  localNow: Date.now(), // local mirror of `serverNow` for skew calculation
  extraTimeSec: 0,
  warningsFired: [], // which thresholds have already alerted (600/300/60)
  status: 'idle',
};

const timerSlice = createSlice({
  name: 'timer',
  initialState,
  reducers: {
    startTimer(state, action) {
      const { attemptId, expiresAt, remainingSec, serverNow, extraTimeSec } = action.payload ?? {};
      state.attemptId = attemptId ?? state.attemptId;
      state.expiresAt = expiresAt ?? null;
      state.remainingSec = remainingSec ?? null;
      state.serverNow = serverNow ?? null;
      state.localNow = Date.now();
      state.extraTimeSec = extraTimeSec ?? state.extraTimeSec;
      state.running = true;
      state.paused = false;
      state.status = 'running';
      state.warningsFired = [];
    },
    syncTimer(state, action) {
      const { expiresAt, remainingSec, serverNow, extraTimeSec, paused } = action.payload ?? {};
      if (expiresAt !== undefined) state.expiresAt = expiresAt;
      if (remainingSec !== undefined) state.remainingSec = remainingSec;
      if (serverNow !== undefined) state.serverNow = serverNow;
      if (extraTimeSec !== undefined) state.extraTimeSec = extraTimeSec;
      if (paused !== undefined) state.paused = Boolean(paused);
      state.localNow = Date.now();
    },
    pauseTimer(state) {
      state.running = false;
      state.paused = true;
      state.status = 'paused';
    },
    resumeTimer(state, action) {
      state.running = true;
      state.paused = false;
      state.status = 'running';
      if (action.payload?.expiresAt) state.expiresAt = action.payload.expiresAt;
      state.localNow = Date.now();
    },
    expireTimer(state) {
      state.running = false;
      state.status = 'expired';
      state.remainingSec = 0;
    },
    warningFired(state, action) {
      if (!state.warningsFired.includes(action.payload)) state.warningsFired.push(action.payload);
    },
    resetTimer: () => ({ ...initialState }),
    advanceTick(state, action) {
      state.localNow = typeof action.payload === 'number' ? action.payload : Date.now();
    },
  },
});

export const { startTimer, syncTimer, pauseTimer, resumeTimer, expireTimer, warningFired, resetTimer, advanceTick } =
  timerSlice.actions;

/** Remaining seconds from the absolute deadline, corrected for server skew. */
export function selectRemainingSec(state) {
  const { expiresAt, remainingSec, serverNow, localNow } = state.timer;
  if (expiresAt) {
    const skew = serverNow ? Date.now() - localNow : 0;
    const remaining = Math.floor((new Date(expiresAt).getTime() - (Date.now() - skew)) / 1000);
    return Math.max(0, remaining);
  }
  return remainingSec ?? 0;
}

export const selectTimerRunning = (state) => state.timer.running;
export const selectTimerPaused = (state) => state.timer.paused;
export const selectWarningsFired = (state) => state.timer.warningsFired;

export default timerSlice.reducer;

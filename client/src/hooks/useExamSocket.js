import { useEffect } from 'react';
import { useAppDispatch } from './useRedux';
import { getSocket, joinExamRoom, leaveExamRoom, onSocket } from '@/lib/socket';
import { startTimer, syncTimer, warningFired } from '@/store/slices/timerSlice';
import { loadRuntime } from '@/store/slices/attemptSlice';
import { timerAdjusted as timerAdjustedProctor } from '@/store/slices/proctoringSlice';
import { toast } from '@/store/slices/uiSlice';

/**
 * Candidate exam-room realtime.
 *
 * Joins `exam:<examId>` for the active attempt and keeps the on-screen countdown
 * honest using only *server* pushes (the local clock is never authoritative):
 *
 *   - `exam:clock-started`   → arm the timer slice with the absolute deadline
 *   - `exam:time-warning`    → flag the threshold so `useCountdown` warns once
 *   - `exam:timer-adjusted`  → a proctor granted/removed time; re-sync + notify
 *   - `exam:submitted`       → server (or proctor) finalised the attempt
 *   - disconnect / reconnect → on the next `connect` we `exam:join` again and
 *     `loadRuntime` so a dropped connection restores the exact saved state.
 *
 * @param {object} opts
 * @param {string} opts.attemptId
 * @param {string} [opts.examId]
 * @param {boolean} [opts.enabled]
 * @param {(payload:any)=>void} [opts.onSubmitted]
 */
export function useExamSocket({ attemptId, examId, enabled = true, onSubmitted } = {}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!enabled || !attemptId) return undefined;

    let joined = false;
    const join = async () => {
      joinExamRoom({ attemptId });
      joined = true;
      // (Re)bootstrap authoritative state — questions, saved answers, timer.
      await dispatch(loadRuntime(attemptId));
    };

    join();

    const socket = getSocket();
    const onReconnect = () => {
      dispatch(loadRuntime(attemptId));
    };
    if (socket) socket.on('connect', onReconnect);

    const offs = [
      onSocket('exam:clock-started', (payload) => dispatch(startTimer({ attemptId, ...payload }))),
      onSocket('exam:time-warning', (payload) => {
        const threshold = payload?.remainingSec ?? payload?.threshold;
        if (threshold != null) dispatch(warningFired(threshold));
        dispatch(
          toast({
            title: 'Time check',
            description: `${Math.max(0, Math.round(threshold ?? 0))} seconds remaining.`,
            variant: threshold && threshold <= 60 ? 'error' : 'warning',
          }),
        );
      }),
      onSocket('exam:timer-adjusted', (payload) => {
        dispatch(syncTimer(payload ?? {}));
        dispatch(timerAdjustedProctor(payload ?? {}));
        const delta = payload?.deltaSec ?? payload?.extraTimeSec ?? 0;
        dispatch(
          toast({
            title: 'Proctor adjusted your time',
            description: delta >= 0 ? `${delta}s added to your remaining time.` : `${Math.abs(delta)}s removed.`,
            variant: delta >= 0 ? 'success' : 'warning',
          }),
        );
      }),
      onSocket('exam:submitted', (payload) => {
        if (payload?.attemptId && payload.attemptId !== attemptId) return;
        if (typeof onSubmitted === 'function') onSubmitted(payload);
        else dispatch(toast({ title: 'Your exam was submitted', description: 'You may now close this window.', variant: 'success' }));
      }),
    ];

    return () => {
      offs.forEach((off) => off());
      if (socket) socket.off('connect', onReconnect);
      if (joined && examId) leaveExamRoom({ examId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attemptId, examId]);
}

export default useExamSocket;

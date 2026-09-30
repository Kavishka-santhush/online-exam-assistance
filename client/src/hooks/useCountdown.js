import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from './useRedux';
import { advanceTick, expireTimer, selectRemainingSec, selectWarningsFired, selectTimerRunning, warningFired } from '@/store/slices/timerSlice';
import { toast } from '@/store/slices/uiSlice';

/**
 * Countdown driver.
 *
 * Mount once inside the exam interface. It re-renders the timer slice every
 * second (`advanceTick`), turns the absolute `expiresAt` into a live remaining
 * value (`selectRemainingSec`), fires the 10 / 5 / 1 minute warnings exactly
 * once each, and calls `onExpire` when the clock hits zero so the interface can
 * trigger the (server-authoritative) auto-submit.
 */

const WARNINGS = [
  { threshold: 600, label: '10 minutes remaining' },
  { threshold: 300, label: '5 minutes remaining' },
  { threshold: 60, label: '1 minute remaining' },
];

export function useCountdown({ onExpire } = {}) {
  const dispatch = useAppDispatch();
  const running = useAppSelector(selectTimerRunning);
  const remaining = useAppSelector(selectRemainingSec);
  const fired = useAppSelector(selectWarningsFired);
  const expireCalled = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => dispatch(advanceTick(Date.now())), 1000);
    return () => clearInterval(id);
  }, [running, dispatch]);

  useEffect(() => {
    if (!running) return;
    for (const warning of WARNINGS) {
      if (remaining > 0 && remaining <= warning.threshold && !fired.includes(warning.threshold)) {
        dispatch(warningFired(warning.threshold));
        dispatch(toast({ title: warning.label, description: 'Time is running low.', variant: warning.threshold <= 60 ? 'destructive' : 'warning' }));
      }
    }
    if (remaining <= 0 && !expireCalled.current) {
      expireCalled.current = true;
      dispatch(expireTimer());
      onExpireRef.current?.();
    }
  }, [remaining, fired, running, dispatch]);

  // Reset the guard when a new attempt starts running again.
  useEffect(() => {
    if (running && remaining > 0) expireCalled.current = false;
  }, [running, remaining]);

  return { remaining, running };
}

export default useCountdown;

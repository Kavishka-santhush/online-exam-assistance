import { useEffect } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { useAppSelector } from '@/hooks/useRedux';
import { selectRemainingSec, selectTimerPaused } from '@/store/slices/timerSlice';
import { cn } from '@/lib/utils';

/**
 * Candidate countdown badge.
 *
 * It is purely presentational: the *value* comes from `selectRemainingSec`,
 * which derives remaining time from the absolute server deadline (`expiresAt`)
 * corrected for clock skew, and `useCountdown` (mounted by `ExamInterface`)
 * drives the per-second re-render + the warning toasts. We only format and
 * colour it here — turning red under five minutes and pulsing under one — so
 * there is exactly one source of truth for the number.
 */
function formatHMS(totalSec) {
  const sec = Math.max(0, totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function Timer() {
  const remaining = useAppSelector(selectRemainingSec);
  const paused = useAppSelector(selectTimerPaused);

  // Re-render formatting even when the tick comes from the driver; a local
  // interval here is harmless (display only) and keeps the badge smooth if the
  // shared driver is momentarily throttled by the browser.
  useEffect(() => {
    if (paused || remaining <= 0) return undefined;
    const id = setInterval(() => {}, 1000);
    return () => clearInterval(id);
  }, [paused, remaining]);

  const critical = remaining <= 60;
  const warn = remaining <= 300;

  return (
    <div
      role="timer"
      aria-live={critical ? 'assertive' : 'off'}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-sm tabular-nums transition-colors',
        paused && 'border-muted-foreground/30 text-muted-foreground',
        !paused && critical && 'animate-pulse border-destructive bg-destructive/10 text-destructive',
        !paused && !critical && warn && 'border-amber-400 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        !paused && !warn && 'text-foreground',
      )}
      title={paused ? 'Timer paused by proctor' : 'Time remaining'}
    >
      {paused ? <AlertTriangle className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
      <span className="font-semibold">{paused ? 'PAUSED' : formatHMS(remaining)}</span>
    </div>
  );
}

export default Timer;

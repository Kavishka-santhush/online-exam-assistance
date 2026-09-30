import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './useRedux';
import { flushOfflineQueue, setOnline, selectActiveAttempt, loadRuntime } from '@/store/slices/attemptSlice';
import { toast } from '@/store/slices/uiSlice';

/**
 * Connectivity hook.
 *
 * Watches browser online/offline transitions and mirrors them into the attempt
 * slice (the exam UI shows a "reconnecting…" banner from this). On the way back
 * online it flushes the queued offline answer saves and re-syncs the runtime so
 * the server timer — which kept running while offline — is reflected accurately.
 */
export function useOnlineStatus() {
  const dispatch = useAppDispatch();
  const online = useAppSelector((state) => state.attempts.online);
  const attempt = useAppSelector(selectActiveAttempt);

  useEffect(() => {
    const handleOnline = async () => {
      dispatch(setOnline(true));
      await dispatch(flushOfflineQueue());
      if (attempt?.id) await dispatch(loadRuntime(attempt.id));
      dispatch(toast({ title: 'Back online', description: 'Your saved answers have synced.', variant: 'success' }));
    };
    const handleOffline = () => {
      dispatch(setOnline(false));
      dispatch(toast({ title: 'Connection lost', description: 'Your answers are being queued and will sync automatically.', variant: 'warning' }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    // Reconcile on mount (e.g. came from a background tab).
    if (navigator.onLine === false && online) dispatch(setOnline(false));
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [dispatch, attempt?.id, online]);

  return { online };
}

export default useOnlineStatus;

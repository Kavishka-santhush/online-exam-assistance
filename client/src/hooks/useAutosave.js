import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from './useRedux';
import { autosave, selectActiveAttempt, selectAnswers } from '@/store/slices/attemptSlice';

/**
 * Periodic autosave.
 *
 * Sends the current answer map to `POST /attempts/:id/autosave` on a fixed
 * interval (server default 30s) and also right before the tab is hidden or
 * unloaded, so a closed or crashed browser loses at most one interval of work.
 * Only fires when there are unsaved changes (`answers` mutated since the last
 * successful save), keeping idle requests off the wire. Offline failures are
 * already captured into the attempt slice's queue inside the thunk.
 */
export function useAutosave({ intervalMs = 30_000 } = {}) {
  const dispatch = useAppDispatch();
  const attempt = useAppSelector(selectActiveAttempt);
  const answers = useAppSelector(selectAnswers);
  const lastSavedAt = useAppSelector((state) => state.attempts.lastSavedAt);

  const dirty = useRef(true);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  useEffect(() => {
    dirty.current = true;
  }, [answers]);

  const attemptId = attempt?.id;

  useEffect(() => {
    if (!attemptId) return undefined;

    const save = async () => {
      if (!dirty.current) return;
      dirty.current = false;
      await dispatch(autosave({ attemptId, answers: answersRef.current }));
    };

    const id = setInterval(save, intervalMs);

    const flush = () => {
      if (dirty.current) {
        dirty.current = false;
        // `sendBeacon`-style best effort; the thunk queues on failure.
        dispatch(autosave({ attemptId, answers: answersRef.current }));
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', flush);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', flush);
    };
  }, [attemptId, intervalMs, dispatch, lastSavedAt]);

  return { lastSavedAt };
}

export default useAutosave;

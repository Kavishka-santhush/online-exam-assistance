import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './useRedux';
import { toast as pushToast, toastRemoved, selectToasts } from '@/store/slices/uiSlice';

/**
 * Toast helper for components.
 *
 * The toast queue itself lives in the `ui` slice (so the socket layer, thunks
 * and plain components can all raise one without a context provider). This hook
 * just gives call-sites a compact `toast.success/error/…` surface and, for each
 * visible toast, schedules its own auto-dismiss timer based on `duration`
 * (0 / `Infinity` keeps it until dismissed).
 */
export function useToast() {
  const dispatch = useAppDispatch();

  const dismiss = useCallback((id) => dispatch(toastRemoved(id)), [dispatch]);

  const show = useCallback(
    (options) => {
      const action = dispatch(pushToast(options));
      return action.payload.id;
    },
    [dispatch],
  );

  const success = useCallback((title, description, rest = {}) => show({ title, description, variant: 'success', ...rest }), [show]);
  const error = useCallback((title, description, rest = {}) => show({ title, description, variant: 'error', duration: 8000, ...rest }), [show]);
  const warning = useCallback((title, description, rest = {}) => show({ title, description, variant: 'warning', ...rest }), [show]);
  const info = useCallback((title, description, rest = {}) => show({ title, description, variant: 'info', ...rest }), [show]);

  return { show, dismiss, success, error, warning, info };
}

/**
 * Auto-dismiss driver — mount once in the `<Toaster />` viewport component.
 * Each toast gets its own timer; hovering is expected to be handled visually by
 * the toast card pausing via `data-paused` (kept simple here).
 */
export function useToastTimers() {
  const toasts = useAppSelector(selectToasts);
  const dispatch = useAppDispatch();
  useEffect(() => {
    const timers = toasts
      .filter((item) => Number.isFinite(item.duration) && item.duration > 0)
      .map((item) => setTimeout(() => dispatch(toastRemoved(item.id)), item.duration));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dispatch]);
}

export default useToast;

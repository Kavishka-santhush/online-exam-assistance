import * as ToastPrimitive from '@radix-ui/react-toast';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectToasts, toastRemoved } from '@/store/slices/uiSlice';
import { ToastCard } from '@/components/ui/toast';

/**
 * The toast viewport — the bridge between the Redux `ui.toasts` queue and the
 * screen. Mounted once inside `AppLayout`. It reads `selectToasts`, renders one
 * `ToastCard` each, and lets Radix's own auto-close timer dispatch
 * `toastRemoved` (via `onOpenChange(false)`), so there is exactly one mechanism
 * deciding when a toast disappears. New toasts arrive from `dispatch(toast(...))`
 * anywhere: thunks, socket handlers, error boundaries — no context needed.
 */
export function Toaster() {
  const dispatch = useAppDispatch();
  const toasts = useAppSelector(selectToasts);

  const close = (id) => dispatch(toastRemoved(id));

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => (
        <ToastCard key={t.id} title={t.title} description={t.description} variant={t.variant} duration={t.duration} onClose={() => close(t.id)} />
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[100] flex max-h-screen w-full max-w-sm flex-col-reverse gap-2 md:max-w-[380px]" />
    </ToastPrimitive.Provider>
  );
}

export default Toaster;

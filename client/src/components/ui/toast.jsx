import { forwardRef } from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Presentational toast built on Radix's Toast primitives (animation + focus/a11y
 * handled for us). NOTE: the *source of truth* for which toasts exist is the
 * Redux `ui` slice, not Radix's internal provider — this component just renders
 * a single already-decided toast and calls `onClose`. See `common/Toaster.jsx`
 * which maps `selectToasts` → a list of these.
 */
const toastVariants = cva(
  'group pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-lg border p-4 pr-8 shadow-lg transition-all',
  {
    variants: {
      variant: {
        default: 'border-border bg-background text-foreground',
        success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100',
        warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
        error: 'border-destructive/40 bg-destructive/10 text-destructive',
        info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const ToastCard = forwardRef(({ title, description, variant = 'default', duration = 6000, onClose, className, ...props }, ref) => (
  <ToastPrimitive.Root ref={ref} open onOpenChange={(next) => !next && onClose?.()} className={cn(toastVariants({ variant }), className)} duration={duration} {...props}>
    <div className="grid gap-0.5">
      {title ? <ToastPrimitive.Title className="text-sm font-semibold">{title}</ToastPrimitive.Title> : null}
      {description ? <ToastPrimitive.Description className="text-sm opacity-90">{description}</ToastPrimitive.Description> : null}
    </div>
    <ToastPrimitive.Close className="absolute right-2 top-2 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </ToastPrimitive.Close>
  </ToastPrimitive.Root>
));
ToastCard.displayName = 'ToastCard';

export { ToastCard, toastVariants };

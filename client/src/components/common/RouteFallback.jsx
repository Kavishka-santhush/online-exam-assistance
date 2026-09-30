import { cn } from '@/lib/utils';

/**
 * Full-area loading placeholder. Used as the `Suspense` fallback for lazy routes
 * and while Clerk bootstraps. `inline` renders a compact centered spinner (inside
 * a card/panel); the default renders a full-viewport one.
 */
export function RouteFallback({ inline = false, label = 'Loading…', className }) {
  const spinner = (
    <div className="flex items-center gap-3 text-muted-foreground">
      <span className="inline-block size-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );

  if (inline) return <div className={cn('flex items-center justify-center py-10', className)}>{spinner}</div>;

  return (
    <div className={cn('flex min-h-[60vh] w-full items-center justify-center', className)} role="status" aria-live="polite">
      {spinner}
    </div>
  );
}

export default RouteFallback;

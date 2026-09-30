import { cn } from '@/lib/utils';

/**
 * Consistent "nothing here yet" / "no results" view. Every list screen reuses
 * this so empty states never look bespoke. `icon` is a lucide component element,
 * `action` is a node (usually a `<Button asChild>` linking to the create route).
 */
export function EmptyState({ icon: Icon, title, description, action, className, compact = false }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed text-center', compact ? 'gap-2 p-6' : 'gap-4 p-12', className)}>
      {Icon ? <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">{Icon}</div> : null}
      <div className="space-y-1.5">
        {title ? <h3 className="text-base font-semibold">{title}</h3> : null}
        {description ? <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export default EmptyState;

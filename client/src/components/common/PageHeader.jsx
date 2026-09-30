import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Standard page masthead. `breadcrumb` accepts an array of `{ label, to? }` so
 * deep screens (exam → section → question) can show a nav trail. `actions` is the
 * right-aligned slot for page-level buttons; it wraps on small screens.
 */
export function PageHeader({ title, description, breadcrumb = [], actions, className }) {
  return (
    <div className={cn('flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="space-y-1.5">
        {breadcrumb.length > 0 ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
            {breadcrumb.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <ChevronRight className="h-3 w-3" /> : null}
                {crumb.to ? (
                  <Link to={crumb.to} className="hover:text-foreground hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-foreground">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export default PageHeader;

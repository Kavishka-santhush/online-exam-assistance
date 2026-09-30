import { useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { switchOrganization, selectOrganizations, selectActiveOrganization, selectIsStaff } from '@/store/slices/authSlice';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Tenant switcher in the top bar. Selecting an org dispatches `switchOrganization`
 * which (a) sets `activeOrganizationId` in the auth slice and (b) calls
 * `setActiveOrganization` in apiClient so the axios interceptor starts sending
 * the new `X-Organization-Id`. We reload nothing here — each page's selectors
 * react to the org id change and refetch as needed.
 */
export function OrgSwitcher() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const organizations = useAppSelector(selectOrganizations);
  const active = useAppSelector(selectActiveOrganization);
  const isStaff = useAppSelector(selectIsStaff);

  const choose = (id) => {
    dispatch(switchOrganization(id));
    navigate('/dashboard');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 max-w-[220px] justify-between gap-2">
          <Building2 className="h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate">{active?.name ?? 'Personal workspace'}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Workspaces</div>
        <button
          type="button"
          onClick={() => choose(null)}
          className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent', !active && 'bg-accent')}
        >
          <Check className={cn('h-4 w-4', active ? 'opacity-0' : 'opacity-100')} />
          <Building2 className="h-4 w-4" /> Personal workspace
        </button>
        {organizations.map((org) => (
          <button
            key={org.id}
            type="button"
            onClick={() => choose(org.id)}
            className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent', active?.id === org.id && 'bg-accent')}
          >
            <Check className={cn('h-4 w-4', active?.id === org.id ? 'opacity-100' : 'opacity-0')} />
            <span className="truncate">{org.name ?? org.slug ?? 'Organization'}</span>
            {org.role ? <span className="ml-auto text-xs text-muted-foreground">{org.role.replace('_', ' ')}</span> : null}
          </button>
        ))}
        {isStaff ? (
          <>
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => navigate('/organization?tab=create')} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
              <Plus className="h-4 w-4" /> Create organization
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export default OrgSwitcher;

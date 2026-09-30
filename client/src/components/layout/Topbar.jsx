import { Link } from 'react-router-dom';
import { Menu, Search, Bell, Sun, Moon, Monitor, LogOut, Settings, User as UserIcon, CreditCard } from 'lucide-react';
import { useClerk, useUser } from '@clerk/clerk-react';

import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectSidebarCollapsed, toggleSidebar, setCommandPalette, selectResolvedTheme, setTheme } from '@/store/slices/uiSlice';
import { selectUnreadCount } from '@/store/slices/notificationSlice';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { OrgSwitcher } from './OrgSwitcher';

/**
 * App top bar. The theme control cycles light → dark → system by dispatching the
 * same `setTheme` the `useTheme` effect reads (so it applies instantly). The bell
 * shows a live unread count maintained by the notification socket — no polling.
 * Sign-out is Clerk's; our `App` effect observes `isSignedIn → false` and tears
 * down the socket + local mirror, so we don't duplicate that logic here.
 */
export function Topbar({ onOpenMobileNav }) {
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector(selectSidebarCollapsed);
  const resolved = useAppSelector(selectResolvedTheme);
  const unread = useAppSelector(selectUnreadCount);
  const { user } = useUser();
  const { signOut } = useClerk();

  const cycleTheme = () => {
    const next = resolved === 'dark' ? 'light' : resolved === 'light' ? 'system' : 'dark';
    dispatch(setTheme(next));
  };
  const ThemeIcon = resolved === 'dark' ? Moon : resolved === 'light' ? Sun : Monitor;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu className="h-5 w-5" />
      </Button>
      <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={() => dispatch(toggleSidebar())} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <Menu className="h-5 w-5" />
      </Button>

      <OrgSwitcher />

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="hidden h-9 w-56 justify-start gap-2 text-muted-foreground sm:flex" onClick={() => dispatch(setCommandPalette(true))}>
          <Search className="h-4 w-4" />
          <span>Search…</span>
          <kbd className="ml-auto rounded border bg-muted px-1.5 text-[10px] font-medium">⌘K</kbd>
        </Button>

        <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => dispatch(setCommandPalette(true))} aria-label="Search">
          <Search className="h-5 w-5" />
        </Button>

        <Button variant="ghost" size="icon" onClick={cycleTheme} aria-label="Toggle theme">
          <ThemeIcon className="h-5 w-5" />
        </Button>

        <Button asChild variant="ghost" size="icon" aria-label="Notifications">
          <Link to="/notifications" className="relative">
            <Bell className="h-5 w-5" />
            {unread > 0 ? (
              <Badge className="absolute -right-0.5 -top-0.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none" variant="destructive">
                {unread > 9 ? '9+' : unread}
              </Badge>
            ) : null}
          </Link>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.imageUrl} />
                <AvatarFallback name={user?.fullName}>{user?.firstName?.[0] ?? 'U'}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="truncate">{user?.fullName ?? 'Signed in'}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">{user?.primaryEmailAddress?.emailAddress}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/profile">
                <UserIcon /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/billing">
                <CreditCard /> Billing
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <Settings /> Preferences
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut({ redirectUrl: '/' })}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export default Topbar;

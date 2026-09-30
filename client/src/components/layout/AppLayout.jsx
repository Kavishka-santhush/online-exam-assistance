import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import { usePersistUi } from '@/hooks/usePersistUi';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSocketConnection } from '@/hooks/useSocket';
import { useAppSelector } from '@/hooks/useRedux';
import { selectIsHydrated } from '@/store/slices/authSlice';

import { AppSidebar } from './AppSidebar';
import { Topbar } from './Topbar';
import { Toaster } from '@/components/common/Toaster';
import { CommandPalette } from '@/components/common/CommandPalette';
import { RouteFallback } from '@/components/common/RouteFallback';

/**
 * Authenticated application shell.
 *
 * Responsibilities that MUST live here (and only here, mounted once):
 *   - `useTheme` + `usePersistUi` → apply/persist look-and-feel.
 *   - `useSocketConnection` → open the realtime socket with a Clerk token getter
 *     and wire inbox/organization plumbing for the whole session.
 *   - `useOnlineStatus` → flip the offline banner / flush the exam answer queue
 *     whenever connectivity changes.
 *   - Render `Toaster` + `CommandPalette` as app-global overlays.
 *
 * On mobile the fixed sidebar becomes an off-canvas drawer; navigating auto-closes
 * it (via the `pathname` effect). Content area is an `Overflow` container so each
 * page scrolls independently of the sidebar.
 */
export default function AppLayout() {
  const { getToken, userId } = useAuth();
  const hydrated = useAppSelector(selectIsHydrated);
  const location = useLocation();
  const [mobileNav, setMobileNav] = useState(false);

  // Global shells / realtime wiring.
  useTheme();
  usePersistUi();
  useOnlineStatus();
  useSocketConnection({ getToken, userId, enabled: hydrated });

  // Close the mobile drawer on every route change.
  useEffect(() => {
    setMobileNav(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-muted/30">
      {/* desktop sidebar */}
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      {/* mobile drawer */}
      <div className={cn('fixed inset-0 z-40 lg:hidden', mobileNav ? 'pointer-events-auto' : 'pointer-events-none')}>
        <div className={cn('absolute inset-0 bg-black/50 transition-opacity', mobileNav ? 'opacity-100' : 'opacity-0')} onClick={() => setMobileNav(false)} aria-hidden />
        <div className={cn('absolute inset-y-0 left-0 w-64 transition-transform', mobileNav ? 'translate-x-0' : '-translate-x-full')}>
          <div className="flex h-full flex-col bg-card">
            <div className="flex justify-end p-2">
              <button className="rounded-md p-1.5 hover:bg-accent" onClick={() => setMobileNav(false)} aria-label="Close navigation">
                <X className="h-5 w-5" />
              </button>
            </div>
            <AppSidebar onNavigate={() => setMobileNav(false)} />
          </div>
        </div>
      </div>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMobileNav={() => setMobileNav(true)} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            {hydrated ? (
              <Outlet />
            ) : (
              <RouteFallback label="Loading your workspace…" />
            )}
          </div>
        </main>
      </div>

      <Toaster />
      <CommandPalette />
    </div>
  );
}

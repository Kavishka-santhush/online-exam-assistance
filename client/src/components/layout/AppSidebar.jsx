import { NavLink, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Library,
  GraduationCap,
  Users2,
  BarChart3,
  BadgeCheck,
  Bell,
  Building2,
  CreditCard,
  ShieldCheck,
  Plus,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useAppSelector } from '@/hooks/useRedux';
import { selectSidebarCollapsed } from '@/store/slices/uiSlice';
import { selectIsStaff, selectIsAuthor, selectIsProctor, selectIsSuperAdmin } from '@/store/slices/authSlice';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Left navigation rail. Entries are declared once as data (label + to + icon + a
 * `visible` predicate) and filtered by the app's role selectors — the identical
 * functions the router uses — so nav can never advertise a forbidden screen. The
 * active highlight comes free from `NavLink`'s `isActive`. Collapsed mode swaps
 * labels for icons + tooltips and shrinks the width.
 */
const NAV = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, visible: () => true },
  { label: 'My Exams', to: '/exams', icon: FileText, visible: ({ staff }) => staff },
  { label: 'Question Banks', to: '/question-banks', icon: Library, visible: ({ author }) => author },
  { label: 'Grading', to: '/grading', icon: GraduationCap, visible: ({ author }) => author },
  { label: 'Proctoring', to: '/exams', icon: Users2, visible: ({ proctor }) => proctor, end: false },
  { label: 'Analytics', to: '/analytics', icon: BarChart3, visible: ({ staff }) => staff },
  { label: 'Certificates', to: '/certificates', icon: BadgeCheck, visible: () => true },
  { label: 'Organization', to: '/organization', icon: Building2, visible: ({ staff }) => staff },
  { label: 'Billing', to: '/billing', icon: CreditCard, visible: () => true },
  { label: 'Admin', to: '/admin', icon: ShieldCheck, visible: ({ superAdmin }) => superAdmin },
];

export function AppSidebar({ onNavigate }) {
  const collapsed = useAppSelector(selectSidebarCollapsed);
  const staff = useAppSelector(selectIsStaff);
  const author = useAppSelector(selectIsAuthor);
  const proctor = useAppSelector(selectIsProctor);
  const superAdmin = useAppSelector(selectIsSuperAdmin);

  const ctx = { staff, author, proctor, superAdmin };
  const items = NAV.filter((item) => item.visible(ctx));

  return (
    <aside className={cn('flex h-full flex-col border-r bg-card transition-[width] duration-200', collapsed ? 'w-[68px]' : 'w-64')}>
      <div className={cn('flex items-center gap-2 px-4 py-4', collapsed && 'justify-center px-2')}>
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-bold">E</span>
          {!collapsed && <span className="whitespace-nowrap">ExamFlow</span>}
        </Link>
      </div>

      {author && !collapsed ? (
        <div className="px-3 pb-2">
          <Button asChild size="sm" className="w-full justify-start gap-2">
            <Link to="/exams/new">
              <Plus className="h-4 w-4" /> New exam
            </Link>
          </Button>
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.label}>
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    collapsed && 'justify-center px-2',
                    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )
                }
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t p-2">
        <Link
          to="/notifications"
          className={cn('flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground', collapsed && 'justify-center px-2')}
          title={collapsed ? 'Notifications' : undefined}
        >
          <Bell className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Notifications</span>}
        </Link>
      </div>
    </aside>
  );
}

/** Toggle control surfaced by the Topbar (keeps collapse state in the `ui` slice). */
export function SidebarToggle({ collapsed, onToggle }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
    </Button>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, FileText, Library, Users2, ShieldCheck, GraduationCap, BarChart3, BadgeCheck, Bell, Settings, Building2, CreditCard, Plus, LogOut } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { setCommandPalette } from '@/store/slices/uiSlice';
import { selectIsStaff, selectIsAuthor, selectIsProctor, selectIsSuperAdmin, selectFlags } from '@/store/slices/authSlice';
import { CommandDialog, CommandInput, CommandList, CommandGroup, CommandItem, CommandSeparator, CommandEmpty } from '@/components/ui/command';

/**
 * Global ⌘K / Ctrl+K palette. Navigation entries are filtered through the exact
 * role selectors the router uses, so an author-only screen never appears for a
 * candidate. "Create exam" fires the same way a sidebar button would (navigate to
 * the builder). Feature flags can hide not-yet-ready destinations.
 */
export function CommandPalette() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const open = useAppSelector((state) => state.ui.commandPaletteOpen);
  const isStaff = useAppSelector(selectIsStaff);
  const isAuthor = useAppSelector(selectIsAuthor);
  const isProctor = useAppSelector(selectIsProctor);
  const isSuperAdmin = useAppSelector(selectIsSuperAdmin);
  const flags = useAppSelector(selectFlags);

  const [search, setSearch] = useState('');

  const setOpen = (value) => dispatch(setCommandPalette(value));

  const run = (to) => {
    setOpen(false);
    navigate(to);
  };

  const nav = useMemo(() => {
    const items = [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, roles: true },
      { label: 'My Exams', to: '/exams', icon: FileText, roles: isStaff },
      { label: 'Question Banks', to: '/question-banks', icon: Library, roles: isAuthor },
      { label: 'Grading Queue', to: '/grading', icon: GraduationCap, roles: isAuthor },
      { label: 'Proctor Dashboard', to: isStaff ? '/exams' : '/dashboard', icon: Users2, roles: isProctor },
      { label: 'Analytics', to: '/analytics', icon: BarChart3, roles: isStaff, hidden: flags?.analytics === false },
      { label: 'Certificates', to: '/certificates', icon: BadgeCheck, roles: true },
      { label: 'Notifications', to: '/notifications', icon: Bell, roles: true },
      { label: 'Billing', to: '/billing', icon: CreditCard, roles: true },
      { label: 'Organization', to: '/organization', icon: Building2, roles: isStaff },
      { label: 'Admin Console', to: '/admin', icon: ShieldCheck, roles: isSuperAdmin },
    ];
    return items.filter((item) => item.roles && !item.hidden);
  }, [isStaff, isAuthor, isProctor, isSuperAdmin, flags]);

  // Palette visibility is Redux state so any component (e.g. a topbar button) can
  // open it; the global hotkey is registered here so it exists exactly once.
  useEffect(() => {
    const down = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages and actions…" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {isAuthor ? (
          <CommandGroup heading="Create">
            <CommandItem onSelect={() => run('/exams/new')}>
              <Plus /> New exam
            </CommandItem>
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Navigate">
          {nav.map((item) => (
            <CommandItem key={item.to + item.label} value={item.label} onSelect={() => run(item.to)}>
              <item.icon /> {item.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem onSelect={() => run('/profile')}>
            <Settings /> Profile & settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export default CommandPalette;

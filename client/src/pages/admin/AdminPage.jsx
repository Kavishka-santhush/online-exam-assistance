import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, PauseCircle, Search, ShieldAlert } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectIsSuperAdmin } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

const ROLES = ['CANDIDATE', 'INSTRUCTOR', 'PROCTOR', 'ORG_ADMIN', 'SUPER_ADMIN'];

/**
 * Platform admin console (`/admin/*`).
 *
 * The one surface guarded by `selectIsSuperAdmin` (a *platform* role, distinct
 * from any org role) — a non-super-admin gets a hard stop rather than a
 * partially-rendered console, because every action here (approve/suspend orgs,
 * change global user roles, delete accounts) is cross-tenant and irreversible.
 * Lists are paged straight from `/admin/*`; mutations call the matching POST/
 * PATCH/DELETE then reload, so the table always reflects server truth rather a
 * optimistic guess.
 */
export default function AdminPage() {
  const dispatch = useAppDispatch();
  const isSuperAdmin = useAppSelector(selectIsSuperAdmin);

  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (isSuperAdmin) request.get(endpoints.admin.overview).then(setOverview).catch(() => {});
  }, [isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Platform administration" />
        <EmptyState icon={<ShieldAlert className="h-6 w-6" />} title="Restricted area" description="This console is for platform super-admins only." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Platform administration" description="Tenants, users, and the audit trail." breadcrumb={[{ label: 'Admin' }]} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><Overview overview={overview} /></TabsContent>
        <TabsContent value="organizations"><OrganizationsTab onToast={(t) => dispatch(toast(t))} /></TabsContent>
        <TabsContent value="users"><UsersTab onToast={(t) => dispatch(toast(t))} /></TabsContent>
        <TabsContent value="audit"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({ overview }) {
  const tiles = [
    { label: 'Organizations', value: overview?.totalOrganizations ?? overview?.totalOrgs, hint: `${overview?.activeOrganizations ?? overview?.activeOrgs ?? 0} active` },
    { label: 'Users', value: overview?.totalUsers, hint: 'active accounts' },
    { label: 'Exams', value: overview?.totalExams, hint: `${overview?.activeExams ?? 0} live` },
    { label: 'Attempts', value: overview?.totalAttempts, hint: `${overview?.attemptsToday ?? 0} today` },
    { label: 'Revenue (30d)', value: overview?.revenueCents != null ? `$${(overview.revenueCents / 100).toFixed(2)}` : undefined, hint: 'collected' },
    { label: 'Certificates', value: overview?.certificatesIssued ?? overview?.certCount, hint: 'issued' },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            {overview == null ? <Skeleton className="mt-1 h-8 w-16" /> : <p className="text-2xl font-bold">{tile.value ?? '—'}</p>}
            {tile.hint ? <p className="text-xs text-muted-foreground">{tile.hint}</p> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function OrganizationsTab({ onToast }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    request.paged(endpoints.admin.organizations, { params: { limit: 50, search: debounced.trim() || undefined } })
      .then(({ data }) => setRows(data)).catch(() => setRows([]));
  }, [debounced]);
  useEffect(() => { load(); }, [load]);

  async function act(id, action) {
    setBusyId(id);
    try {
      await request.post(endpoints.admin[`${action}Organization`](id), {});
      load();
      onToast({ title: `Organization ${action === 'approve' ? 'approved' : action === 'suspend' ? 'suspended' : 'reactivated'}`, variant: 'success' });
    } catch (err) { onToast({ title: 'Action failed', description: err.message, variant: 'error' }); }
    finally { setBusyId(null); }
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search organizations…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Card><CardContent className="p-0">{listTable(rows, ['Name', 'Slug', 'Members', 'Status', ''], (org) => (
        <TableRow key={org.id}>
          <TableCell className="font-medium">{org.name}</TableCell>
          <TableCell className="text-muted-foreground">{org.slug}</TableCell>
          <TableCell>{org.memberCount ?? org._count?.members ?? '—'}</TableCell>
          <TableCell>
            <div className="flex gap-1">
              {!org.isApproved ? <Badge variant="warning">pending</Badge> : null}
              {org.isSuspended ? <Badge variant="destructive">suspended</Badge> : <Badge variant="success">active</Badge>}
            </div>
          </TableCell>
          <TableCell className="text-right">
            <div className="flex justify-end gap-1">
              {!org.isApproved ? <Button size="sm" variant="outline" disabled={busyId === org.id} onClick={() => act(org.id, 'approve')}><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Approve</Button> : null}
              {org.isSuspended
                ? <Button size="sm" variant="ghost" disabled={busyId === org.id} onClick={() => act(org.id, 'reactivate')}>Reactivate</Button>
                : <Button size="sm" variant="ghost" disabled={busyId === org.id} onClick={() => act(org.id, 'suspend')}><PauseCircle className="mr-1 h-3.5 w-3.5" />Suspend</Button>}
            </div>
          </TableCell>
        </TableRow>
      ))}</CardContent></Card>
    </div>
  );
}

function UsersTab({ onToast }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);

  const load = useCallback(() => {
    request.paged(endpoints.admin.users, { params: { limit: 50, search: debounced.trim() || undefined } })
      .then(({ data }) => setRows(data)).catch(() => setRows([]));
  }, [debounced]);
  useEffect(() => { load(); }, [load]);

  async function changeRole(userId, role) {
    try {
      await request.patch(endpoints.admin.userRole(userId), { role });
      onToast({ title: 'Role updated', variant: 'success' });
    } catch (err) { onToast({ title: 'Role change failed', description: err.message, variant: 'error' }); }
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search users…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Card><CardContent className="p-0">{listTable(rows, ['User', 'Platform role', 'Status', 'Joined'], (user) => (
        <TableRow key={user.id}>
          <TableCell>
            <p className="font-medium">{user.displayName ?? user.name ?? '—'}</p>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </TableCell>
          <TableCell>
            <Select value={user.platformRole ?? 'CANDIDATE'} onValueChange={(role) => changeRole(user.id, role)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{role.replace('_', ' ')}</SelectItem>)}</SelectContent>
            </Select>
          </TableCell>
          <TableCell><Badge variant={user.status === 'ACTIVE' ? 'success' : user.status === 'SUSPENDED' ? 'destructive' : 'secondary'}>{user.status ?? 'ACTIVE'}</Badge></TableCell>
          <TableCell className="text-right text-xs text-muted-foreground">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : ''}</TableCell>
        </TableRow>
      ))}</CardContent></Card>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    request.paged(endpoints.admin.auditLogs, { params: { limit: 100 } }).then(({ data }) => setRows(data)).catch(() => setRows([]));
  }, []);
  return (
    <Card><CardContent className="p-0">{listTable(rows, ['When', 'Action', 'Actor', 'Entity'], (log) => (
      <TableRow key={log.id}>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</TableCell>
        <TableCell className="font-medium">{log.action}</TableCell>
        <TableCell className="max-w-[200px] truncate text-muted-foreground">{log.actor?.email ?? log.actorEmail ?? log.actorId ?? '—'}</TableCell>
        <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">{log.entityType ? `${log.entityType}${log.entityId ? ` · ${log.entityId}` : ''}` : ''}</TableCell>
      </TableRow>
    ))}</CardContent></Card>
  );
}

function listTable(rows, headers, renderRow) {
  if (!rows) return <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (rows.length === 0) return <p className="p-6 text-sm text-muted-foreground">Nothing to show.</p>;
  return (
    <Table>
      <TableHeader><TableRow>{headers.map((h, i) => <TableHead key={i} className={i === headers.length - 1 ? 'text-right' : ''}>{h}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{rows.map(renderRow)}</TableBody>
    </Table>
  );
}

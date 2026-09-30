import { useCallback, useEffect, useState } from 'react';
import { Mail, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  fetchMyOrganizations,
  selectActiveOrganization,
  selectIsStaff,
} from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';

const ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Organization settings (`/organization`).
 *
 * Every write here hits an org-admin-guarded route on the server, but we still
 * gate the UI: non-staff get a read-only message, non-admins get the tabs
 * without the mutating controls. The active org comes from the auth slice (the
 * same `X-Organization-Id` the api client sends), so this page can't drift
 * from whatever context the rest of the app is operating in.
 */
export default function OrganizationSettingsPage() {
  const dispatch = useAppDispatch();
  const org = useAppSelector(selectActiveOrganization);
  const isStaff = useAppSelector(selectIsStaff);
  const isAdmin = org?.role === 'ORG_ADMIN' || org?.role === 'ADMIN';

  const [members, setMembers] = useState(null);
  const [settings, setSettings] = useState(null);
  const [invites, setInvites] = useState(null);

  const loadMembers = useCallback(() => {
    if (!org?.id) return;
    request.paged(endpoints.organizations.members(org.id), { params: { limit: 100 } })
      .then(({ data }) => setMembers(data)).catch(() => setMembers([]));
  }, [org?.id]);

  useEffect(() => {
    if (!org?.id) dispatch(fetchMyOrganizations());
  }, [dispatch, org?.id]);

  useEffect(() => {
    if (!org?.id || !isStaff) return;
    loadMembers();
    request.get(endpoints.organizations.settings(org.id)).then((data) => setSettings(normaliseSettings(data))).catch(() => setSettings(defaultSettings()));
    request.get(endpoints.organizations.invites(org.id)).then((data) => setInvites(Array.isArray(data) ? data : data?.items ?? [])).catch(() => setInvites([]));
  }, [org?.id, isStaff, loadMembers]);

  if (!isStaff || !org) {
    return (
      <div className="space-y-6">
        <PageHeader title="Organization" description="Manage your team, roles, and settings." />
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          <ShieldCheck className="mx-auto mb-2 h-8 w-8" /> You need organization-admin access to manage these settings.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={org.name ?? 'Organization'} description={`Signed in as ${org.role}.`} breadcrumb={[{ label: 'Organization' }]} />

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invites">Invitations</TabsTrigger>
          {isAdmin ? <TabsTrigger value="general">Settings</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="members" className="space-y-4">
          <MembersTab orgId={org.id} members={members} isAdmin={isAdmin} onChanged={loadMembers} onToast={(t) => dispatch(toast(t))} />
        </TabsContent>

        <TabsContent value="invites" className="space-y-4">
          <InvitesTab orgId={org.id} invites={invites} isAdmin={isAdmin} onChanged={() => request.get(endpoints.organizations.invites(orgIdSafe(org.id))).then((data) => setInvites(Array.isArray(data) ? data : data?.items ?? []))} onToast={(t) => dispatch(toast(t))} />
        </TabsContent>

        {isAdmin ? (
          <TabsContent value="general" className="space-y-4">
            <GeneralTab orgId={org.id} settings={settings} setSettings={setSettings} onSaved={(next) => { setSettings(next); dispatch(toast({ title: 'Settings saved', variant: 'success' })); }} onToast={(t) => dispatch(toast(t))} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function orgIdSafe(id) { return id; }

function MembersTab({ orgId, members, isAdmin, onChanged, onToast }) {
  async function changeRole(userId, role) {
    try {
      await request.patch(endpoints.organizations.member(orgId, userId), { role });
      onChanged();
    } catch (err) { onToast({ title: 'Could not update role', description: err.message, variant: 'error' }); }
  }
  async function remove(userId) {
    try {
      await request.delete(endpoints.organizations.member(orgId, userId));
      onChanged();
      onToast({ title: 'Member removed', variant: 'success' });
    } catch (err) { onToast({ title: 'Remove failed', description: err.message, variant: 'error' }); }
  }

  if (!members) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>;

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const userId = member.userId ?? member.user?.id ?? member.id;
              return (
                <TableRow key={userId}>
                  <TableCell>
                    <p className="font-medium">{member.user?.displayName ?? member.displayName ?? '—'}</p>
                    <p className="text-xs text-muted-foreground">{member.user?.email ?? member.email}</p>
                  </TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <Select value={member.role} onValueChange={(role) => changeRole(userId, role)}>
                        <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                        <SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{role.replace('_', ' ')}</SelectItem>)}</SelectContent>
                      </Select>
                    ) : <Badge variant="outline">{member.role}</Badge>}
                  </TableCell>
                  <TableCell><Badge variant={member.status === 'ACTIVE' ? 'success' : 'secondary'}>{member.status ?? 'ACTIVE'}</Badge></TableCell>
                  <TableCell className="text-right">
                    {isAdmin && member.role !== 'ORG_ADMIN' ? (
                      <Button size="icon" variant="ghost" onClick={() => remove(userId)} aria-label="Remove"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function InvitesTab({ orgId, invites, isAdmin, onChanged, onToast }) {
  const [form, setForm] = useState({ email: '', role: 'CANDIDATE', message: '' });
  const [sending, setSending] = useState(false);

  async function sendInvite(event) {
    event.preventDefault();
    const email = form.email.trim();
    if (!EMAIL_RE.test(email)) { onToast({ title: 'Enter a valid email address', variant: 'error' }); return; }
    setSending(true);
    try {
      await request.post(endpoints.organizations.invite(orgId), { invites: [{ email, role: form.role }], message: form.message.trim() || undefined });
      setForm({ email: '', role: 'CANDIDATE', message: '' });
      onChanged();
      onToast({ title: 'Invitation sent', variant: 'success' });
    } catch (err) { onToast({ title: 'Invite failed', description: err.message, variant: 'error' }); }
    finally { setSending(false); }
  }

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Invite someone</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={sendInvite} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="inv-email">Email</Label><Input id="inv-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required /></div>
              <div className="space-y-1.5"><Label>Role</Label>
                <Select value={form.role} onValueChange={(role) => setForm((f) => ({ ...f, role }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{role.replace('_', ' ')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="inv-msg">Message (optional)</Label><Textarea id="inv-msg" rows={2} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} /></div>
              <div className="sm:col-span-2"><Button type="submit" disabled={sending || !form.email}><Mail className="mr-1.5 h-4 w-4" /> {sending ? 'Sending…' : 'Send invite'}</Button></div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">Pending invitations</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!invites ? <div className="p-4"><Skeleton className="h-10" /></div> : invites.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No pending invitations.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Sent</TableHead><TableHead className="w-32" /></TableRow></TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell>{invite.email}</TableCell>
                    <TableCell><Badge variant="outline">{invite.role}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{invite.createdAt ? new Date(invite.createdAt).toLocaleDateString() : '—'}</TableCell>
                    <TableCell className="text-right">
                      {isAdmin ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={async () => { await request.post(endpoints.organizations.resendInvite(orgId, invite.id), {}); onToast({ title: 'Resent', variant: 'success' }); }}>Resend</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => { await request.delete(endpoints.organizations.revokeInvite(orgId, invite.id)); onChanged(); }}>Revoke</Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const SETTING_ROWS = [
  { key: 'allowSelfRegistration', label: 'Allow candidates to self-register for exams' },
  { key: 'requireProctorApproval', label: 'Proctor must approve setup before an exam starts' },
  { key: 'issueCertificates', label: 'Automatically issue certificates on pass' },
  { key: 'enableAiGrading', label: 'Allow AI-assisted essay grading' },
];

function GeneralTab({ orgId, settings, setSettings, onSaved, onToast }) {
  const [saving, setSaving] = useState(false);
  if (!settings) return <Skeleton className="h-48 rounded-xl" />;

  function toggle(key, value) { setSettings((prev) => ({ ...prev, [key]: value })); }

  async function save() {
    setSaving(true);
    try {
      // The server's settings write is PUT (full replace), not PATCH.
      await request.put(endpoints.organizations.settings(orgId), settings);
      onSaved(settings);
    } catch (err) { onToast({ title: 'Save failed', description: err.message, variant: 'error' }); }
    finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Organization settings</CardTitle></CardHeader>
      <CardContent className="space-y-1">
        {SETTING_ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
            <span className="text-sm">{row.label}</span>
            <Switch checked={Boolean(settings[row.key])} onCheckedChange={(checked) => toggle(row.key, checked)} />
          </div>
        ))}
        <Separator className="my-4" />
        <div className="flex items-center justify-between">
          <div className="space-y-1.5 max-w-xs">
            <Label>Exam access default</Label>
            <Select value={settings.defaultAccess ?? 'ORG_MEMBERS'} onValueChange={(value) => toggle('defaultAccess', value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ORG_MEMBERS">Org members only</SelectItem>
                <SelectItem value="PUBLIC_LINK">Anyone with the link</SelectItem>
                <SelectItem value="INVITED">Invited candidates only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function defaultSettings() {
  return { allowSelfRegistration: false, requireProctorApproval: false, issueCertificates: true, enableAiGrading: false, defaultAccess: 'ORG_MEMBERS' };
}

function normaliseSettings(data) {
  return { ...defaultSettings(), ...(data ?? {}) };
}

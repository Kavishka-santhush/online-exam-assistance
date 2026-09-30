import { useEffect, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { Save, Loader2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectUser, updateProfile } from '@/store/slices/authSlice';
import { selectAccessibility, setAccessibility, toast } from '@/store/slices/uiSlice';
import {
  fetchPreferences,
  updatePreferences,
  selectNotificationPreferences,
} from '@/store/slices/notificationSlice';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TIMEZONES = [
  'UTC',
  'Asia/Colombo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
];

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'si', label: 'සිංහල (Sinhala)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'العربية' },
];

function initialsOf(user) {
  const first = user?.firstName?.[0] ?? user?.displayName?.[0] ?? '';
  const last = user?.lastName?.[0] ?? '';
  const value = `${first}${last}`.trim();
  return value || user?.displayName?.slice(0, 2) || '?';
}

export default function ProfilePage() {
  const dispatch = useAppDispatch();
  const { user } = useUser();
  const profile = useAppSelector(selectUser);
  const accessibility = useAppSelector(selectAccessibility);
  const notifPrefs = useAppSelector(selectNotificationPreferences);

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    displayName: '',
    headline: '',
    timezone: 'UTC',
    language: 'en',
    phone: '',
    bio: '',
  });

  // Seed the form from the server `User` row (falls back to Clerk fields).
  useEffect(() => {
    if (!profile && !user) return;
    setForm((prev) => ({
      ...prev,
      firstName: profile?.firstName ?? user?.firstName ?? prev.firstName,
      lastName: profile?.lastName ?? user?.lastName ?? prev.lastName,
      displayName: profile?.displayName ?? user?.fullName ?? prev.displayName,
      headline: profile?.headline ?? prev.headline,
      timezone: profile?.timezone ?? prev.timezone,
      language: profile?.language ?? prev.language,
      phone: profile?.phone ?? prev.phone,
      bio: profile?.bio ?? prev.bio,
    }));
  }, [profile, user]);

  useEffect(() => {
    dispatch(fetchPreferences());
  }, [dispatch]);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave(event) {
    event?.preventDefault();
    setSaving(true);
    const result = await dispatch(updateProfile(form));
    setSaving(false);
    if (updateProfile.fulfilled.match(result)) {
      dispatch(toast({ title: 'Profile saved', description: 'Your changes are live.', variant: 'success' }));
    } else {
      dispatch(toast({ title: 'Could not save', description: result.payload?.message ?? 'Please try again.', variant: 'error' }));
    }
  }

  const email = user?.primaryEmailAddress?.emailAddress ?? profile?.email ?? '—';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your profile"
        description="Manage your identity, how the interface looks, and what we notify you about."
        breadcrumb={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Profile' }]}
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <Avatar className="size-16">
            {profile?.avatarUrl || user?.imageUrl ? (
              <AvatarImage src={profile?.avatarUrl ?? user?.imageUrl} alt={form.displayName || 'You'} />
            ) : null}
            <AvatarFallback className="text-lg">{initialsOf(profile || user)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{form.displayName || form.firstName || 'Unnamed user'}</h2>
              {profile?.platformRole ? <Badge variant="secondary">{profile.platformRole}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{email}</p>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        {/* ---- profile details ---- */}
        <TabsContent value="profile" className="mt-4">
          <form onSubmit={handleSave} className="space-y-0">
            <Card>
              <CardHeader>
                <CardTitle>Personal details</CardTitle>
                <CardDescription>These fill out your account identity. Your email is managed by your identity provider.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="firstName">First name</Label>
                    <Input id="firstName" value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lastName">Last name</Label>
                    <Input id="lastName" value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="displayName">Display name</Label>
                  <Input id="displayName" value={form.displayName} onChange={(e) => update('displayName', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="headline">Headline</Label>
                  <Input id="headline" placeholder="e.g. Senior Lecturer, Computer Science" value={form.headline} onChange={(e) => update('headline', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bio">Bio</Label>
                  <Textarea id="bio" rows={3} value={form.bio} onChange={(e) => update('bio', e.target.value)} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="timezone">Timezone</Label>
                    <select
                      id="timezone"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={form.timezone}
                      onChange={(e) => update('timezone', e.target.value)}
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="language">Language</Label>
                    <select
                      id="language"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={form.language}
                      onChange={(e) => update('language', e.target.value)}
                    >
                      {LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.code}>{lang.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone (optional)</Label>
                  <Input id="phone" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={saving}>
                    {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                    Save changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          </form>
        </TabsContent>

        {/* ---- accessibility / appearance ---- */}
        <TabsContent value="appearance" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Accessibility &amp; appearance</CardTitle>
              <CardDescription>These apply to the exam interface and are saved to this device.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Base font size</Label>
                  <span className="text-sm text-muted-foreground">{accessibility.fontSize}px</span>
                </div>
                <Slider
                  min={12}
                  max={24}
                  step={1}
                  value={[accessibility.fontSize]}
                  onValueChange={([value]) => dispatch(setAccessibility({ fontSize: value }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>High contrast</Label>
                  <p className="text-sm text-muted-foreground">Stronger colors for readability.</p>
                </div>
                <Switch
                  checked={accessibility.highContrast}
                  onCheckedChange={(checked) => dispatch(setAccessibility({ highContrast: checked }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Reduced motion</Label>
                  <p className="text-sm text-muted-foreground">Minimise animations and transitions.</p>
                </div>
                <Switch
                  checked={accessibility.reducedMotion}
                  onCheckedChange={(checked) => dispatch(setAccessibility({ reducedMotion: checked }))}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- notification preferences ---- */}
        <TabsContent value="notifications" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Email &amp; in-app notifications</CardTitle>
              <CardDescription>Choose which events we tell you about.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {notifPrefs == null ? (
                <p className="text-sm text-muted-foreground">Loading preferences…</p>
              ) : (
                NOTIF_CHANNELS.map((channel) => (
                  <div key={channel.key} className="flex items-center justify-between">
                    <div>
                      <Label>{channel.label}</Label>
                      <p className="text-sm text-muted-foreground">{channel.hint}</p>
                    </div>
                    <Switch
                      checked={Boolean(notifPrefs[channel.key])}
                      onCheckedChange={(checked) => dispatch(updatePreferences({ [channel.key]: checked }))}
                    />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const NOTIF_CHANNELS = [
  { key: 'examAssigned', label: 'New exam assigned', hint: 'When an instructor assigns you an exam.' },
  { key: 'resultsReleased', label: 'Results released', hint: 'When your grades are published.' },
  { key: 'certificateIssued', label: 'Certificate issued', hint: 'When a certificate is ready to download.' },
  { key: 'gradingUpdates', label: 'Grading updates', hint: 'For instructors and graders.' },
  { key: 'proctoringAlerts', label: 'Proctoring alerts', hint: 'For proctors — flags and session events.' },
];

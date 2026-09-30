import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Library, Plus, Search, Users2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectIsStaff } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Question-bank library (`/question-banks`).
 *
 * Banks are the reusable, org-scoped question pools exams draw from. Only
 * staff/authors manage them, so the create affordance and the "new bank"
 * dialog are gated on `selectIsStaff`; candidates who somehow land here get an
 * empty read-only state rather than a broken form. Each card shows the
 * server-maintained `questionCount` (we never re-count client-side — the bank
 * recount endpoint owns that number).
 */
export default function QuestionBanksPage() {
  const dispatch = useAppDispatch();
  const isStaff = useAppSelector(selectIsStaff);

  const [banks, setBanks] = useState(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isStaff) { setBanks([]); return; }
    let alive = true;
    request
      .get(endpoints.questionBanks.accessible, { params: { limit: 100 } })
      .then((data) => alive && setBanks(Array.isArray(data) ? data : data?.items ?? []))
      .catch((err) => { if (alive) { setBanks([]); dispatch(toast({ title: 'Could not load banks', description: err.message, variant: 'error' })); } });
    return () => { alive = false; };
  }, [dispatch, isStaff]);

  async function createBank(event) {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const bank = await request.post(endpoints.questionBanks.root, { name: form.name.trim(), description: form.description.trim() || undefined });
      setBanks((prev) => [bank, ...(prev ?? [])]);
      setCreating(false);
      setForm({ name: '', description: '' });
      dispatch(toast({ title: 'Bank created', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Create failed', description: err.message, variant: 'error' }));
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return (banks ?? []).filter((bank) => !q || `${bank.name} ${bank.description ?? ''}`.toLowerCase().includes(q));
  }, [banks, debounced]);

  if (!isStaff) {
    return (
      <div className="space-y-6">
        <PageHeader title="Question banks" description="Shared question libraries are managed by instructors." />
        <EmptyState icon={<Library className="h-6 w-6" />} title="Not available" description="You don't have access to the question-bank library." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Question banks"
        description="Reusable pools your exams draw questions from."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New bank</Button>}
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search banks…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      {banks === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Library className="h-6 w-6" />}
          title="No banks yet"
          description="Create a bank, then add questions you can reuse across many exams."
          action={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New bank</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((bank) => (
            <Link key={bank.id} to={`/question-banks/${bank.id}`} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <CardContent className="flex h-full flex-col p-5">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h3 className="font-semibold leading-snug">{bank.name}</h3>
                    {bank.isShared || bank.visibility === 'SHARED' ? <Badge variant="outline" className="gap-1"><Users2 className="h-3 w-3" /> Shared</Badge> : null}
                  </div>
                  {bank.description ? <p className="mb-4 line-clamp-2 text-sm text-muted-foreground">{bank.description}</p> : null}
                  <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{bank.questionCount ?? 0} questions</span>
                    {bank.category?.name ? <span>· {bank.category.name}</span> : null}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form onSubmit={createBank}>
            <DialogHeader><DialogTitle>New question bank</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="bank-name">Name</Label>
                <Input id="bank-name" value={form.name} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} placeholder="e.g. Data Structures — Midterms" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bank-desc">Description</Label>
                <Textarea id="bank-desc" rows={3} value={form.description} onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))} />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !form.name.trim()}>{saving ? 'Creating…' : 'Create bank'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

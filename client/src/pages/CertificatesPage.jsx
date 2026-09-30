import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, Download, Mail, Search, ShieldBan, ShieldCheck } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectIsStaff } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { downloadFromEndpoint } from '@/utils/download';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Certificates (`/certificates`).
 *
 * Same route, two audiences, gated by role — mirroring the rest of the app:
 *   - a **candidate** sees only their own credentials (`/certificates/mine`)
 *     and can download / copy a public verification link.
 *   - a **staff/author** sees the org-wide ledger (`/certificates`) with the
 *     issue controls (email a batch, revoke a bad credential).
 * We fetch the right collection based on the role selector and never leak the
 * org list to candidates — the server enforces that too, but the client
 * shouldn't even attempt the staff call.
 */
export default function CertificatesPage() {
  const dispatch = useAppDispatch();
  const isStaff = useAppSelector(selectIsStaff);

  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    request
      .get(isStaff ? endpoints.certificates.list : endpoints.certificates.mine, { params: { limit: 100 } })
      .then((data) => alive && setItems(Array.isArray(data) ? data : data?.items ?? []))
      .catch((err) => { if (alive) { setItems([]); dispatch(toast({ title: 'Could not load certificates', description: err.message, variant: 'error' })); } });
    return () => { alive = false; };
  }, [dispatch, isStaff]);

  async function download(cert) {
    setBusyId(cert.id);
    try {
      await downloadFromEndpoint(endpoints.certificates.download(cert.id), `${cert.certificateNo ?? cert.id}.pdf`);
    } catch {
      dispatch(toast({ title: 'Download failed', variant: 'error' }));
    } finally {
      setBusyId(null);
    }
  }

  async function email(cert) {
    setBusyId(cert.id);
    try {
      await request.post(endpoints.certificates.email(cert.id), {});
      dispatch(toast({ title: 'Email queued', description: 'The certificate was sent to the holder.', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Email failed', description: err.message, variant: 'error' }));
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(cert) {
    setBusyId(cert.id);
    try {
      await request.post(endpoints.certificates.revoke(cert.id), { reason: 'Revoked from dashboard' });
      setItems((prev) => prev.map((row) => (row.id === cert.id ? { ...row, status: 'REVOKED' } : row)));
      dispatch(toast({ title: 'Certificate revoked', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Revoke failed', description: err.message, variant: 'error' }));
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return items ?? [];
    return (items ?? []).filter((c) => `${c.holderName ?? c.candidate?.name ?? ''} ${c.examTitle ?? c.exam?.title ?? ''} ${c.certificateNo ?? ''}`.toLowerCase().includes(q));
  }, [items, debounced]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Certificates"
        description={isStaff ? 'Every credential your organization has issued.' : 'Your verified credentials — download and share.'}
        actions={isStaff ? <Button asChild variant="outline"><Link to="/analytics">Issue from an exam</Link></Button> : null}
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search holder, exam, or code…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      {items === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Award className="h-6 w-6" />} title="No certificates yet" description={isStaff ? 'Certificates appear here once a passing attempt is graded and released.' : 'Pass an exam that issues certificates to see yours here.'} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((cert) => {
            const holder = cert.holderName ?? cert.candidate?.name ?? cert.candidate?.displayName ?? '—';
            const examTitle = cert.examTitle ?? cert.exam?.title ?? 'Certificate';
            const revoked = cert.status === 'REVOKED';
            const verifyUrl = `${window.location.origin}/verify/${cert.verificationToken ?? cert.certificateNo ?? cert.id}`;
            return (
              <Card key={cert.id} className={revoked ? 'border-destructive/30' : 'border-primary/20'}>
                <CardContent className="flex h-full flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className={`grid size-9 place-items-center rounded-lg ${revoked ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                        {revoked ? <ShieldBan className="h-5 w-5" /> : <Award className="h-5 w-5" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold leading-tight">{examTitle}</p>
                        <p className="text-xs text-muted-foreground">{isStaff ? holder : cert.certificateNo}</p>
                      </div>
                    </div>
                    <Badge variant={revoked ? 'destructive' : 'success'}>{revoked ? 'Revoked' : 'Valid'}</Badge>
                  </div>

                  {cert.issuedAt ? <p className="text-xs text-muted-foreground">Issued {new Date(cert.issuedAt).toLocaleDateString()}</p> : null}

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <Button size="sm" variant="outline" disabled={revoked || busyId === cert.id} onClick={() => download(cert)}>
                      <Download className="mr-1 h-3.5 w-3.5" /> PDF
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(verifyUrl); dispatch(toast({ title: 'Verification link copied', variant: 'success' })); }}>
                      <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Verify link
                    </Button>
                    {isStaff && !revoked ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={busyId === cert.id} onClick={() => email(cert)}><Mail className="mr-1 h-3.5 w-3.5" /> Email</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={busyId === cert.id} onClick={() => revoke(cert)}><ShieldBan className="h-3.5 w-3.5" /></Button>
                      </>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

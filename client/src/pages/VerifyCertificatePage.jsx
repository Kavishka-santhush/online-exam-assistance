import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, BadgeX, Loader2, Search, ShieldCheck } from 'lucide-react';
import { request, endpoints } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Public certificate verification (`/verify/:code?`).
 *
 * Employers follow a `verify/:code` link straight to this page, so the code
 * can arrive either as a route param (prefill + auto-check) or be typed into
 * the box. Verification goes through `POST /certificates/verify` — the server
 * re-derives the integrity hash and returns the credential facts (holder,
 * exam, issue date, revocation). We render exactly what the server asserts
 * and add nothing: a verifier page that computed its own verdict would be
 * forgeable in the same way the paper certificate it replaces is.
 */
export default function VerifyCertificatePage() {
  const { code: codeParam } = useParams();
  const [code, setCode] = useState(codeParam ?? '');
  const [state, setState] = useState('idle'); // idle | checking | valid | invalid | revoked
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function check(value) {
    const token = (value ?? code).trim();
    if (!token) return;
    setState('checking');
    setError(null);
    try {
      const data = await request.post(endpoints.certificates.verify, { token });
      setResult(data);
      setState(data?.status === 'REVOKED' ? 'revoked' : data?.valid === false ? 'invalid' : 'valid');
    } catch (err) {
      setResult(null);
      setError(err.message ?? 'No certificate matches that code.');
      setState('invalid');
    }
  }

  // Deep link: `/verify/ABC123` runs the check on arrival.
  useEffect(() => {
    if (codeParam) check(codeParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam]);

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-primary/10">
          <ShieldCheck className="h-6 w-6 text-primary" />
        </div>
        <h1 className="mt-3 text-2xl font-bold">Verify a certificate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the certificate or verification code printed on the credential.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => { event.preventDefault(); check(); }}
      >
        <Input
          placeholder="e.g. CERT-2026-AB12CD"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="font-mono uppercase"
        />
        <Button type="submit" disabled={!code.trim() || state === 'checking'}>
          {state === 'checking' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
          Verify
        </Button>
      </form>

      {state === 'valid' && result ? (
        <Card className="border-emerald-500/40">
          <CardContent className="space-y-3 p-6">
            <div className="flex items-center gap-2 font-semibold text-emerald-600">
              <BadgeCheck className="h-5 w-5" /> Authentic certificate
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Field label="Holder" value={result.holderName ?? result.candidate?.name} />
              <Field label="Certificate no." value={result.certificateNo ?? code} mono />
              <Field label="Exam" value={result.examTitle ?? result.exam?.title} />
              <Field label="Issued" value={result.issuedAt ? new Date(result.issuedAt).toLocaleDateString() : '—'} />
              <Field label="Score" value={result.scorePercent != null ? `${Math.round(result.scorePercent)}%` : result.score ?? '—'} />
              <Field label="Issuer" value={result.organization?.name ?? result.issuer ?? '—'} />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {state === 'revoked' ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 p-6 text-sm">
            <BadgeX className="h-6 w-6 shrink-0 text-destructive" />
            <div>
              <p className="font-semibold text-destructive">This certificate has been revoked.</p>
              <p className="text-muted-foreground">{result?.revocationReason ?? 'The issuing organization withdrew it.'}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(state === 'invalid' || error) && state !== 'checking' ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 p-6 text-sm">
            <BadgeX className="h-6 w-6 shrink-0 text-destructive" />
            <div>
              <p className="font-semibold text-destructive">Not found</p>
              <p className="text-muted-foreground">{error ?? 'No certificate matches that code — check for typos.'}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        <Link to="/" className="underline">← Back to home</Link>
      </p>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-sm' : 'text-sm font-medium'}>{value ?? '—'}</dd>
    </div>
  );
}

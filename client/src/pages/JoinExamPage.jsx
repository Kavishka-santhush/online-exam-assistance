import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { Clock, HelpCircle, LogIn, ShieldCheck, Users } from 'lucide-react';
import { request, endpoints } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Public exam-join landing (`/join/:accessKey`).
 *
 * An access key (invite/token) lets a candidate discover an exam without
 * guessing its id. This page is deliberately fetch-only: it reads the
 * invite-scoped exam preview (`GET /exams/invite/:token`), renders the
 * "what you're about to take" card, and hands off to the real runtime route
 * (`/exam/:examId/take`). The runtime re-validates registration, timing
 * windows and proctor approval server-side — a friendly preview here is never
 * a security boundary, which is why we show a read-only summary and nothing
 * about question content.
 */
export default function JoinExamPage() {
  const { accessKey } = useParams();
  const [exam, setExam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    request
      .get(endpoints.exams.byToken(accessKey))
      .then((data) => alive && setExam(data?.exam ?? data))
      .catch((err) => alive && setError(err.message ?? 'This invite link is invalid or expired.'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [accessKey]);

  if (loading) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
        <HelpCircle className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Can't open this exam</h1>
        <p className="text-sm text-muted-foreground">{error ?? 'The invite link is no longer valid — ask your instructor for a fresh one.'}</p>
        <Button asChild variant="outline"><Link to="/">Back to home</Link></Button>
      </div>
    );
  }

  const settings = exam.settings ?? {};
  const meta = [
    settings.durationMinutes ?? exam.durationMinutes ? { icon: Clock, label: `${settings.durationMinutes ?? exam.durationMinutes} minutes` } : null,
    exam.questionCount != null ? { icon: HelpCircle, label: `${exam.questionCount} questions` } : null,
    exam.candidateCount != null ? { icon: Users, label: `${exam.candidateCount} enrolled` } : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">You've been invited to an exam</p>
        <h1 className="mt-1 text-2xl font-bold">{exam.title}</h1>
        {exam.organization?.name ? <p className="mt-1 text-sm text-muted-foreground">{exam.organization.name}</p> : null}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Before you start</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          {exam.description ? <p className="text-muted-foreground">{exam.description}</p> : null}

          <div className="flex flex-wrap gap-2">
            {meta.map(({ icon: Icon, label }) => (
              <span key={label} className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium">
                <Icon className="h-3.5 w-3.5" /> {label}
              </span>
            ))}
            {settings.isProctored ? <Badge variant="warning" className="gap-1"><ShieldCheck className="h-3 w-3" /> Proctored</Badge> : null}
          </div>

          {settings.isProctored ? (
            <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
              This exam is monitored. You'll need a working webcam, microphone, and a quiet private room. A setup check runs before you can begin.
            </p>
          ) : null}

          {exam.startsAt || exam.endsAt ? (
            <p className="text-xs text-muted-foreground">
              Available {exam.startsAt ? `from ${new Date(exam.startsAt).toLocaleString()}` : 'now'}
              {exam.endsAt ? ` until ${new Date(exam.endsAt).toLocaleString()}` : ''}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <SignedIn>
        <Button asChild size="lg" className="w-full">
          <Link to={`/exam/${exam.id}/take`}>Continue to exam</Link>
        </Button>
      </SignedIn>
      <SignedOut>
        <Button asChild size="lg" className="w-full">
          <Link to={`/sign-in?redirect=/exam/${exam.id}/take`}>
            <LogIn className="mr-2 h-4 w-4" /> Sign in to join
          </Link>
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          New here? <Link className="underline" to="/sign-up">Create an account</Link> first — your invite works either way.
        </p>
      </SignedOut>
    </div>
  );
}

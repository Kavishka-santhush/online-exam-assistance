import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { CheckCircle2, Flag, Loader2, Play, Radio, SkipForward, Square, Trophy } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { fetchExam, selectCurrentExam } from '@/store/slices/examSlice';
import { useLiveQuizSocket } from '@/hooks/useLiveQuizSocket';
import { useToast } from '@/hooks/useToast';
import { request, endpoints } from '@/lib/apiClient';
import { metaFor } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Kahoot-style live-quiz host console (`/exams/:examId/live`).
 *
 * Flow: create the ephemeral session over REST (`POST /attempts/live/exams/:id/sessions`
 * — the server snapshots the exam's auto-gradeable questions and minted a join
 * code), then drive it entirely through `useLiveQuizSocket({ role: 'host' })`,
 * whose `host.*` helpers hit the advance/close/end routes. The host sees the
 * same socket-derived state players see (single source of truth = the server's
 * broadcasts), so there is no separate "host truth" to keep in sync here.
 */
export default function LiveQuizHostPage() {
  const dispatch = useAppDispatch();
  const { examId } = useParams();
  const exam = useAppSelector(selectCurrentExam);
  const toast = useToast();

  const [code, setCode] = useState(null);
  const [creating, setCreating] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  const live = useLiveQuizSocket({ code, role: 'host', enabled: Boolean(code) });

  useEffect(() => {
    dispatch(fetchExam(examId));
  }, [dispatch, examId]);

  async function startSession() {
    setCreating(true);
    try {
      const session = await request.post(endpoints.attempts.createLiveQuiz(examId), {});
      setCode(session.code);
    } catch (err) {
      toast.error('Could not start session', err.message);
    } finally {
      setCreating(false);
    }
  }

  async function hostAction(fn, label) {
    setAdvancing(true);
    try {
      await fn();
    } catch (err) {
      toast.error(`${label} failed`, err.message);
    } finally {
      setAdvancing(false);
    }
  }

  if (!exam) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }

  const total = exam.questions?.length ?? 0;
  const progressIndex = Number(live.session?.currentQuestionIndex ?? 0);
  const question = live.question;
  const ended = live.status === 'ended' || Boolean(live.session?.ended);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live quiz host"
        description={exam.title}
        breadcrumb={[{ label: 'Exams', to: '/exams' }, { label: exam.title, to: `/exams/${examId}` }, { label: 'Live quiz' }]}
      />

      {!code ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
            <Radio className="h-10 w-10 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Start a live session</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Players join with a code from their device. Questions advance when you say so — Kahoot style, in front of the room.
              </p>
            </div>
            <Button size="lg" onClick={startSession} disabled={creating || total === 0}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {total === 0 ? 'Add questions first' : 'Start session'}
            </Button>
            {total === 0 ? (
              <Button asChild variant="outline" size="sm"><Link to={`/exams/${examId}/edit`}>Go to exam builder</Link></Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* ---- left: room state + controls ---- */}
          <div className="space-y-6 lg:col-span-2">
            <Card className="border-primary/40">
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="flex items-center gap-4">
                  <QRCodeCanvas value={`${window.location.origin}/live/${code}`} size={92} level="M" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Join code</p>
                    <p className="font-mono text-3xl font-black tracking-widest">{code}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Players go to <span className="font-medium">/live/{code}</span> or scan the QR
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <Badge variant={ended ? 'secondary' : 'success'} className="mb-2">
                    {ended ? 'Ended' : live.status === 'live' ? 'Live' : live.status}
                  </Badge>
                  <p className="text-sm text-muted-foreground">{live.participants.length} players · {progressIndex}/{total} answered</p>
                  <Progress value={total ? (progressIndex / total) * 100 : 0} className="mt-2 h-1.5 w-40" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Current question</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {ended ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Session ended — final standings on the right.</p>
                ) : question ? (
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <p className="text-xs text-muted-foreground">{metaFor(question.type).label}</p>
                    <p className="mt-1 font-semibold">{question.prompt ?? question.title}</p>
                    <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                      {(question.options ?? []).map((option, index) => {
                        const key = option.id ?? option.value ?? index;
                        const correct = option.correct ?? option.isCorrect;
                        const revealed = live.reveal;
                        const answerCount = revealed?.optionCounts?.[key] ?? revealed?.tally?.[key];
                        return (
                          <div key={key} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${revealed && correct ? 'border-emerald-500/50 bg-emerald-500/10' : ''}`}>
                            <span className="min-w-0 truncate">{option.text ?? option.label ?? String(key)}</span>
                            {answerCount != null ? <Badge variant="muted">{answerCount}</Badge> : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">Waiting to open the first question…</p>
                )}

                <div className="flex flex-wrap gap-2">
                  {live.reveal || !question ? (
                    <Button onClick={() => hostAction(live.host.advance, 'Advance')} disabled={advancing || ended}>
                      <SkipForward className="mr-1.5 h-4 w-4" /> Next question
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => hostAction(live.host.closeQuestion, 'Close question')} disabled={advancing}>
                      <CheckCircle2 className="mr-1.5 h-4 w-4" /> Close &amp; reveal
                    </Button>
                  )}
                  <Button variant="destructive" onClick={() => hostAction(live.host.end, 'End session')} disabled={advancing || ended}>
                    <Square className="mr-1.5 h-4 w-4" /> End session
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ---- right: players + leaderboard ---- */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Flag className="h-4 w-4" /> Players</CardTitle></CardHeader>
              <CardContent className="max-h-56 space-y-1.5 overflow-y-auto">
                {live.participants.length === 0 ? <p className="text-sm text-muted-foreground">No one has joined yet.</p> : null}
                {live.participants.map((player) => (
                  <div key={player.userId ?? player.displayName} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 text-sm">
                    <span className="truncate">{player.displayName ?? 'Guest'}</span>
                    {player.teamId ? <Badge variant="outline">{player.teamId}</Badge> : null}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Trophy className="h-4 w-4" /> Leaderboard</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {live.leaderboard.length === 0 ? <p className="text-sm text-muted-foreground">Scores appear after the first question.</p> : null}
                {live.leaderboard.slice(0, 10).map((row, index) => (
                  <div key={row.userId ?? row.displayName} className="flex items-center gap-2 text-sm">
                    <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${index < 3 ? 'bg-amber-500/15 text-amber-600' : 'bg-muted text-muted-foreground'}`}>{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{row.displayName ?? row.name}</span>
                    <span className="font-semibold tabular-nums">{row.score ?? row.totalScore ?? 0}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

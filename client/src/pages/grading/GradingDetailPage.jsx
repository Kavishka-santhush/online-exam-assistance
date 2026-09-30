import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, Loader2, Save, Sparkles, SpellCheck } from 'lucide-react';
import { request, endpoints } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { metaFor, requiresManualGrading, QUESTION_TYPE } from '@/utils/questionTypes';
import { resolveUploadUrl } from '@/utils/download';
import { QuestionRenderer } from '@/components/exam-taking/QuestionRenderer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// Free-text/submission types graded on a marks scale (not a binary
// correct/wrong) — these are the ones the AI-assist endpoint understands.
const essayLike = [QUESTION_TYPE.LONG_ANSWER, QUESTION_TYPE.CODING, QUESTION_TYPE.FILE_UPLOAD];

/**
 * The grading desk (`/grading/:answerId`).
 *
 * One server call — `GET /grading/answers/:id/submission` — returns everything
 * a grader needs: the answer, its question, the attempt header, the exam's
 * rubric (explicit or derived from the question's criteria), second-grader
 * state, override history, and a `queue` of the attempt's sibling answers so
 * navigation never re-hits the list endpoint.
 *
 * Scoring is a single write — `POST /grading/grade { answerId, marks, … }` —
 * and the *server* decides how marks roll up (rubric weighting, disagreement
 * handling, attempt recompute). We deliberately keep no grading state here
 * beyond the form draft: a client-side score cache would drift from the
 * authoritative answer row mid-session.
 */
export default function GradingDetailPage() {
  const { answerId } = useParams();
  const toast = useToast();

  const [submission, setSubmission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // form draft, re-seeded whenever we switch answers
  const [marks, setMarks] = useState('');
  const [isCorrect, setIsCorrect] = useState(null); // null = not applicable
  const [feedback, setFeedback] = useState('');
  const [graderNote, setGraderNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request.get(endpoints.grading.submission(answerId));
      setSubmission(data);
      setMarks(data?.answer?.manualScore != null ? String(data.answer.manualScore) : '');
      setIsCorrect(data?.answer?.isCorrect ?? null);
      setFeedback(data?.answer?.feedback ?? '');
      setGraderNote(data?.answer?.graderNote ?? '');
      setAiSuggestion(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [answerId]);

  useEffect(() => { load(); }, [load]);

  const question = submission?.question ?? submission?.answer?.question ?? {};
  const answer = submission?.answer ?? {};
  const maxMarks = Number(submission?.maxMarks ?? question.marks ?? 1);
  const rubric = submission?.rubric;

  // Guard the form client-side only against nonsense; the server re-validates
  // the range and authority before anything is persisted.
  const marksNumber = marks === '' ? null : Number(marks);
  const marksValid = marks === '' || (Number.isFinite(marksNumber) && marksNumber >= 0 && marksNumber <= maxMarks);

  async function save() {
    if (!marksValid) return;
    setSaving(true);
    try {
      await request.post(endpoints.grading.grade, {
        answerId,
        marks: marksNumber,
        isCorrect: isCorrect ?? undefined,
        feedback: feedback.trim() || undefined,
        graderNote: graderNote.trim() || undefined,
      });
      toast.success('Grade saved', 'Attempt totals recompute server-side.');
      await load();
    } catch (err) {
      toast.error('Could not save grade', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function askAi() {
    const url = question.type === QUESTION_TYPE.CODING ? endpoints.grading.aiCode(answerId) : endpoints.grading.aiEssay(answerId);
    setAiBusy(true);
    try {
      const result = await request.post(url, {});
      setAiSuggestion(result);
    } catch (err) {
      toast.error('AI assist failed', err.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function finaliseAttempt() {
    try {
      await request.post(endpoints.grading.finalise(submission.attempt.id), {});
      toast.success('Grading finalised', 'Result released per the exam visibility policy.');
    } catch (err) {
      toast.error('Finalise failed', err.message);
    }
  }

  const queue = submission?.queue ?? [];
  const gradedCount = useMemo(() => queue.filter((row) => row.graded).length, [queue]);

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-96 rounded-xl lg:col-span-2" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (error || !submission) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {error ?? 'Submission not found.'}
        <div className="mt-4"><Button asChild variant="outline"><Link to="/grading">Back to queue</Link></Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to="/grading"><ChevronLeft className="mr-1 h-4 w-4" /> Queue</Link></Button>
          <h1 className="text-xl font-semibold">{submission.exam?.title ?? 'Grading'}</h1>
          <p className="text-sm text-muted-foreground">
            {submission.attempt.candidate?.displayName ?? 'Candidate'} · attempt {submission.attempt.attemptNumber ?? 1}
            {submission.attempt.submittedAt ? ` · submitted ${new Date(submission.attempt.submittedAt).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={gradedCount === queue.length && queue.length > 0 ? 'success' : 'warning'}>
            {gradedCount}/{queue.length} answers graded
          </Badge>
          <Button variant="outline" size="sm" onClick={finaliseAttempt} disabled={queue.length === 0 || gradedCount < queue.filter((r) => r.needsManualGrading).length}>
            <CheckCircle2 className="mr-1.5 h-4 w-4" /> Finalise attempt
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- left: sibling-answer navigator ---- */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Answers</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {queue.map((row) => (
              <Link
                key={row.answerId}
                to={`/grading/${row.answerId}`}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted ${row.isCurrent ? 'bg-primary/10 font-medium text-primary' : ''}`}
              >
                <span className="w-6 shrink-0 text-muted-foreground">{row.order != null ? `${row.order}.` : ''}</span>
                <span className="min-w-0 flex-1 truncate">{row.prompt ?? metaFor(row.type).label}</span>
                {row.graded ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : row.needsManualGrading ? <span className="size-2 shrink-0 rounded-full bg-amber-500" /> : null}
              </Link>
            ))}
            {submission.otherGrades ? (
              <>
                <Separator className="my-3" />
                <p className="text-xs text-muted-foreground">
                  Other grader: {submission.otherGrades.manualScore ?? submission.otherGrades.secondScore ?? '—'} / {maxMarks}
                  {submission.otherGrades.disagreement ? <Badge variant="warning" className="ml-2">disagreement</Badge> : null}
                </p>
              </>
            ) : null}
            {submission.overrides?.length ? (
              <p className="mt-2 text-xs text-muted-foreground">Last override: {submission.overrides[0].previousScore} → {submission.overrides[0].newScore} ({submission.overrides[0].overriddenBy?.displayName})</p>
            ) : null}
          </CardContent>
        </Card>

        {/* ---- middle: the submission under review ---- */}
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-start justify-between gap-2 text-base">
                <span className="min-w-0">{question.prompt ?? 'Question'}</span>
                <Badge variant="outline" className="shrink-0">{metaFor(question.type).label}</Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground">{maxMarks} mark(s)</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <QuestionRenderer question={{ ...question, options: question.options ?? answer.options ?? [] }} value={answer.response} review disabled />

              {answer.files?.length ? (
                <div className="space-y-1.5">
                  {answer.files.map((file) => {
                    const src = resolveUploadUrl(file.url);
                    return (
                      <a key={file.id} href={src} target="_blank" rel="noreferrer" className="block rounded-md border px-3 py-2 text-sm hover:bg-muted">
                        📎 {file.originalName ?? file.kind ?? 'attachment'}
                      </a>
                    );
                  })}
                </div>
              ) : null}

              {typeof answer.response === 'string' && answer.wordCount != null ? (
                <p className="text-xs text-muted-foreground">{answer.wordCount} words · {Math.round((answer.timeSpentSec ?? 0) / 60)} min on this answer</p>
              ) : null}
            </CardContent>
          </Card>

          {rubric?.criteria?.length ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Rubric · {rubric.name}</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {rubric.criteria.map((criterion) => (
                  <div key={criterion.id ?? criterion.name} className="flex justify-between gap-3">
                    <span className="min-w-0">{criterion.name}{criterion.description ? <span className="block text-xs text-muted-foreground">{criterion.description}</span> : null}</span>
                    <span className="shrink-0 font-medium tabular-nums">{criterion.maxMarks}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* ---- right: score form ---- */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Award marks</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="marks">Marks (0–{maxMarks})</Label>
              <Input id="marks" type="number" min={0} max={maxMarks} step={0.5} value={marks} onChange={(event) => setMarks(event.target.value)} />
              {!marksValid ? <p className="text-xs text-destructive">Enter a number between 0 and {maxMarks}.</p> : null}
            </div>

            {requiresManualGrading(question.type) && !essayLike.includes(question.type) ? (
              <div className="flex gap-2">
                <Button size="sm" variant={isCorrect === true ? 'default' : 'outline'} onClick={() => setIsCorrect(true)}>Correct</Button>
                <Button size="sm" variant={isCorrect === false ? 'destructive' : 'outline'} onClick={() => setIsCorrect(false)}>Wrong</Button>
              </div>
            ) : null}

            {aiSuggestion ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium"><Sparkles className="h-4 w-4" /> AI suggestion</p>
                {aiSuggestion.suggestedScore != null || aiSuggestion.score != null ? (
                  <button type="button" className="mt-1 underline font-semibold" onClick={() => setMarks(String(aiSuggestion.suggestedScore ?? aiSuggestion.score))}>
                    {aiSuggestion.suggestedScore ?? aiSuggestion.score} / {maxMarks} — click to use
                  </button>
                ) : null}
                {aiSuggestion.rationale || aiSuggestion.feedback ? <p className="mt-1 text-xs text-muted-foreground">{aiSuggestion.rationale ?? aiSuggestion.feedback}</p> : null}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="feedback">Feedback to candidate (optional)</Label>
              <Textarea id="feedback" rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Shown only if the exam releases feedback…" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">Private grader note (optional)</Label>
              <Textarea id="note" rows={2} value={graderNote} onChange={(event) => setGraderNote(event.target.value)} />
            </div>

            <div className="flex flex-col gap-2">
              <Button onClick={save} disabled={saving || !marksValid || marks === ''}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save grade
              </Button>
              {[QUESTION_TYPE.LONG_ANSWER, QUESTION_TYPE.CODING].includes(question.type) ? (
                <Button variant="outline" onClick={askAi} disabled={aiBusy}>
                  {aiBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <SpellCheck className="mr-1.5 h-4 w-4" />} AI assist
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

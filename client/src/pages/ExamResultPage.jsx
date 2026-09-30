import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Award, CheckCircle2, XCircle, Download, FileText, Loader2 } from 'lucide-react';
import { useAppDispatch } from '@/hooks/useRedux';
import { request, endpoints } from '@/lib/apiClient';
import { toast } from '@/store/slices/uiSlice';
import { downloadFromEndpoint } from '@/utils/download';
import { metaFor } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { QuestionRenderer } from '@/components/exam-taking/QuestionRenderer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';

/**
 * Post-submit result / review screen (`/exams/:examId/results/:attemptId`).
 *
 * Loads the server's authoritative result (score, verdict, and the per-question
 * review payload that — subject to the exam's `resultVisibility` /
 * `showCorrectAnswers` policy — includes answer keys). The review reuses the very
 * same `QuestionRenderer` the candidate answered with, but in `review` mode so
 * correct options are highlighted; we never recompute a grade on the client.
 */
export default function ExamResultPage() {
  const dispatch = useAppDispatch();
  const { examId, attemptId } = useParams();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    request
      .get(endpoints.attempts.results(attemptId))
      .then((data) => alive && setResult(data))
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [attemptId]);

  async function downloadCertificate(certificateId) {
    try {
      await downloadFromEndpoint(endpoints.certificates.download(certificateId), `certificate-${certificateId}.pdf`);
    } catch {
      dispatch(toast({ title: 'Download failed', variant: 'error' }));
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {error ?? 'Result not available yet.'}
        <div className="mt-4"><Button asChild variant="outline"><Link to="/dashboard">Back to dashboard</Link></Button></div>
      </div>
    );
  }

  const percentage = Math.round((result.percentage ?? result.scorePercent ?? (result.maxScore ? (result.score / result.maxScore) * 100 : 0)) || 0);
  const passed = result.passed ?? percentage >= (result.passingScorePercent ?? 40);
  const review = result.review ?? result.answers ?? result.questions ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your result"
        breadcrumb={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Result' }]}
        actions={
          <Button asChild variant="outline">
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <div className={`grid size-16 place-items-center rounded-full ${passed ? 'bg-emerald-500/15 text-emerald-600' : 'bg-destructive/15 text-destructive'}`}>
            {passed ? <CheckCircle2 className="h-8 w-8" /> : <XCircle className="h-8 w-8" />}
          </div>
          <div>
            <p className="text-4xl font-black">{percentage}%</p>
            <p className="text-sm text-muted-foreground">
              {result.score ?? '—'} / {result.maxScore ?? '—'} marks · {passed ? 'Passed' : 'Not passed'}
            </p>
          </div>
          <Progress value={percentage} className="mt-2 h-2 max-w-sm" />
          {result.status === 'PENDING_GRADING' || result.pendingGrading ? (
            <Badge variant="warning">Awaiting manual grading — final score pending</Badge>
          ) : null}
        </CardContent>
      </Card>

      {result.certificate ? (
        <Card className="border-primary/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-3">
              <Award className="h-8 w-8 text-primary" />
              <div>
                <p className="font-semibold">Certificate earned</p>
                <p className="text-sm text-muted-foreground">{result.certificate.certificateNo ?? result.certificate.id}</p>
              </div>
            </div>
            <Button onClick={() => downloadCertificate(result.certificate.id)}>
              <Download className="mr-1.5 h-4 w-4" /> Download PDF
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {review.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Answer review</h2>
            <Button variant="outline" size="sm" onClick={() => downloadFromEndpoint(endpoints.reports.resultPdf, `result-${attemptId}.pdf`, { params: { attemptId } }).catch(() => dispatch(toast({ title: 'Export failed', variant: 'error' })))}>
              <FileText className="mr-1.5 h-4 w-4" /> Export PDF
            </Button>
          </div>
          {review.map((item, index) => {
            const question = item.question ?? item;
            const yourAnswer = item.answer ?? item.yourAnswer ?? item.response;
            return (
              <Card key={question.id ?? index}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="text-muted-foreground">{index + 1}.</span> {question.prompt ?? question.title}
                    {item.awardedMarks != null ? <Badge variant="muted" className="ml-auto">{item.awardedMarks}/{question.marks ?? item.maxMarks}</Badge> : null}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">{metaFor(question.type).label}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <QuestionRenderer question={question} value={yourAnswer} review disabled />
                  {item.correct ? (
                    <p className="flex items-center gap-1.5 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Correct</p>
                  ) : item.awardedMarks === 0 ? (
                    <p className="flex items-center gap-1.5 text-sm text-destructive"><XCircle className="h-4 w-4" /> Not correct</p>
                  ) : null}
                  {question.explanation && (item.correct === false || item.reviewNote) ? (
                    <p className="rounded-lg bg-muted/50 p-3 text-sm"><span className="font-medium">Explanation: </span>{question.explanation}</p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4" /> Answer review isn't available for this exam yet.
        </div>
      )}
    </div>
  );
}

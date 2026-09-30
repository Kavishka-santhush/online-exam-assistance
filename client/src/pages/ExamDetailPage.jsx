import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Send, Copy, Trash2, Play, ShieldCheck, BarChart3, Users2, Radio } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  fetchExam,
  selectCurrentExam,
  selectCurrentExamStatus,
  publishExam,
  cloneExam,
  deleteExam,
} from '@/store/slices/examSlice';
import { selectIsAuthor, selectIsStaff, selectIsProctor } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { endpoints } from '@/lib/apiClient';
import { downloadFromEndpoint } from '@/utils/download';
import { EXAM_STATUS_META } from '@/utils/examConstants';
import { metaFor } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

export default function ExamDetailPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { examId } = useParams();
  const exam = useAppSelector(selectCurrentExam);
  const status = useAppSelector(selectCurrentExamStatus);
  const isAuthor = useAppSelector(selectIsAuthor);
  const isStaff = useAppSelector(selectIsStaff);
  const isProctor = useAppSelector(selectIsProctor);

  useEffect(() => {
    dispatch(fetchExam(examId));
  }, [dispatch, examId]);

  async function handlePublish() {
    const result = await dispatch(publishExam({ id: examId }));
    dispatch(toast(publishExam.fulfilled.match(result) ? { title: 'Published', variant: 'success' } : { title: 'Publish failed', description: result.payload, variant: 'error' }));
  }
  async function handleClone() {
    const result = await dispatch(cloneExam(examId));
    if (cloneExam.fulfilled.match(result)) navigate(`/exams/${result.payload.id}/edit`);
  }
  async function handleDelete() {
    const result = await dispatch(deleteExam(examId));
    if (deleteExam.fulfilled.match(result)) {
      dispatch(toast({ title: 'Exam deleted', variant: 'success' }));
      navigate('/exams');
    }
  }
  async function exportResults() {
    try {
      await downloadFromEndpoint(endpoints.reports.resultsCsv, `results-${examId}.csv`, { params: { examId } });
    } catch {
      dispatch(toast({ title: 'Export failed', variant: 'error' }));
    }
  }

  if (status === 'loading' || !exam) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const meta = EXAM_STATUS_META[exam.status] ?? { label: exam.status ?? 'Draft', tone: 'muted' };
  const settings = exam.settings ?? {};
  const questions = exam.questions ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={exam.title}
        description={exam.description}
        breadcrumb={[{ label: 'Exams', to: '/exams' }, { label: exam.title }]}
        actions={
          isAuthor ? (
            <>
              <Button asChild variant="outline"><Link to={`/exams/${examId}/edit`}><Pencil className="mr-1.5 h-4 w-4" /> Edit</Link></Button>
              <Button variant="outline" onClick={handleClone}><Copy className="mr-1.5 h-4 w-4" /> Clone</Button>
              {exam.status !== 'PUBLISHED' && exam.status !== 'ACTIVE' ? (
                <Button onClick={handlePublish}><Send className="mr-1.5 h-4 w-4" /> Publish</Button>
              ) : null}
            </>
          ) : (
            <Button asChild><Link to={`/exam/${examId}/take`}><Play className="mr-1.5 h-4 w-4" /> Start exam</Link></Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.tone === 'muted' ? 'secondary' : meta.tone}>{meta.label}</Badge>
        <Badge variant="outline">{exam.type ?? 'Exam'}</Badge>
        {settings.isProctored ? <Badge variant="warning">Proctored</Badge> : null}
        {exam.durationMinutes ? <span className="text-sm text-muted-foreground">{exam.durationMinutes} minutes</span> : null}
        {isStaff ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {isProctor ? <Button asChild size="sm" variant="ghost"><Link to={`/exams/${examId}/proctor`}><ShieldCheck className="mr-1.5 h-4 w-4" /> Proctor</Link></Button> : null}
            <Button asChild size="sm" variant="ghost"><Link to={`/analytics/${examId}`}><BarChart3 className="mr-1.5 h-4 w-4" /> Analytics</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to={`/exams/${examId}/live`}><Radio className="mr-1.5 h-4 w-4" /> Live quiz</Link></Button>
            {isAuthor ? <Button size="sm" variant="ghost" onClick={exportResults}><Users2 className="mr-1.5 h-4 w-4" /> Export results</Button> : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Questions ({questions.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {questions.length === 0 ? <p className="text-sm text-muted-foreground">No questions yet.</p> : null}
              {questions.map((question, index) => (
                <div key={question.id ?? index} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{index + 1}. {question.prompt ?? question.title ?? '(untitled)'}</p>
                    <p className="text-xs text-muted-foreground">{metaFor(question.type).label} · {question.marks ?? 1} mark(s)</p>
                  </div>
                  <Badge variant="muted">{question.difficulty ?? 'MEDIUM'}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Passing score" value={`${settings.passingScorePercent ?? exam.passingPercent ?? 40}%`} />
              <Row label="Max attempts" value={String(settings.attemptLimit ?? 1)} />
              <Row label="Shuffle" value={settings.shuffleQuestions ? 'On' : 'Off'} />
              <Row label="Access" value={settings.access ?? 'org members'} />
              <Row label="Result visibility" value={settings.resultVisibility ?? 'immediate'} />
              <Separator className="my-2" />
              <Row label="Proctoring" value={settings.isProctored ? 'Enabled' : 'None'} />
            </CardContent>
          </Card>

          {isAuthor ? (
            <Card className="border-destructive/30">
              <CardHeader><CardTitle className="text-destructive">Danger zone</CardTitle></CardHeader>
              <CardContent>
                <Button variant="destructive" className="w-full" onClick={handleDelete}><Trash2 className="mr-1.5 h-4 w-4" /> Delete exam</Button>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

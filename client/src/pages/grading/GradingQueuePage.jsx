import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ClipboardList, Inbox, Loader2 } from 'lucide-react';
import { request, endpoints } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Manual-grading queue (`/grading`).
 *
 * Shows the attempts *assigned to me as grader* (`GET /grading/my-queue`) —
 * not the raw exam-wide queue, because an inbox that mixes everyone's work is
 * noise. Each row already carries `pendingAnswers`, so a grader can triage by
 * load and due date. Clicking "Grade" resolves that attempt's first pending
 * answer (`/grading/attempts/:id/submissions`) and deep-links straight into
 * the grading desk, saving a click through the submission list.
 */
export default function GradingQueuePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState(null); // null = loading
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    request
      .paged(endpoints.grading.myQueue, { params: { limit: 50 } })
      .then(({ data }) => alive && setRows(data))
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        toast.error('Could not load the queue', err.message);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openGrading(row) {
    setBusyId(row.attemptId);
    try {
      const detail = await request.get(endpoints.grading.attemptAnswers(row.attemptId));
      const pending = (detail.answers ?? []).find((answer) => answer.needsManualGrading && !answer.finalScore && answer.gradingStatus !== 'GRADED');
      const target = pending ?? (detail.answers ?? [])[0];
      if (!target) toast.info('Nothing to grade in this attempt');
      else navigate(`/grading/${target.answerId}`);
    } catch (err) {
      toast.error('Could not open submission', err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Grading queue"
        description="Attempts waiting for a human score — yours first."
        breadcrumb={[{ label: 'Grading' }]}
      />

      {rows === null ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Inbox className="h-6 w-6" />} title="Queue is clear" description="No attempts are assigned to you for manual grading." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Exam</TableHead>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Due</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const overdue = row.dueAt && new Date(row.dueAt) < new Date();
                  return (
                    <TableRow key={row.id ?? row.attemptId}>
                      <TableCell className="max-w-[240px] truncate font-medium">{row.exam?.title ?? '—'}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{row.attempt?.user?.displayName ?? row.attempt?.user?.email ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{row.attempt?.submittedAt ? new Date(row.attempt.submittedAt).toLocaleString() : '—'}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={row.pendingAnswers > 0 ? 'warning' : 'success'}>{row.pendingAnswers ?? 0}</Badge>
                      </TableCell>
                      <TableCell className={`text-right ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
                        {row.dueAt ? new Date(row.dueAt).toLocaleDateString() : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => openGrading(row)} disabled={busyId === row.attemptId}>
                          {busyId === row.attemptId ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ClipboardList className="mr-1.5 h-3.5 w-3.5" />}
                          Grade
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Looking for one exam's whole queue? Open an <Link to="/exams" className="underline">exam</Link> and use its analytics/release tools.
      </p>
    </div>
  );
}

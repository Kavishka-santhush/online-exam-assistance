import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MessagesSquare, ShieldAlert } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  fetchProctorDashboard,
  proctorControl,
  selectProctorDashboard,
  selectProctorAlerts,
} from '@/store/slices/proctoringSlice';
import { fetchExam, selectCurrentExam } from '@/store/slices/examSlice';
import { useProctoringWatch } from '@/hooks/useProctoringSocket';
import { useToast } from '@/hooks/useToast';
import { ProctorWatchGrid } from '@/components/proctoring/ProctorWatchGrid';
import { ProctorChat } from '@/components/proctoring/ProctorChat';
import { PageHeader } from '@/components/common/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Proctor command centre (`/exams/:examId/proctor`).
 *
 * Seed-and-stream: `fetchProctorDashboard` paints the first watch grid, then
 * `useProctoringWatch` joins the exam's proctor room and folds every live
 * violation/presence/control event into the same slice rows — so the grid
 * never needs polling. Control actions route through the `proctorControl`
 * thunk (pause/resume/+5m/flag/terminate); the server is what actually
 * enforces them on the candidate's attempt, this page just requests them.
 */
export default function ProctorDashboardPage() {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { examId } = useParams();
  const dashboard = useAppSelector(selectProctorDashboard);
  const alerts = useAppSelector(selectProctorAlerts);
  const exam = useAppSelector(selectCurrentExam);

  const [chatAttemptId, setChatAttemptId] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    dispatch(fetchProctorDashboard(examId));
    dispatch(fetchExam(examId));
  }, [dispatch, examId]);

  // Live stream into the same slice (also re-watches when the socket drops).
  useProctoringWatch({ examId, enabled: true });

  async function onControl(action, attemptId, payload = {}) {
    if (action === 'monitor') {
      // Focus is a view concern for now — selecting the row highlights it.
      setChatAttemptId(attemptId);
      return;
    }
    const result = await dispatch(proctorControl({ action, attemptId, payload }));
    if (proctorControl.fulfilled.match(result)) toast.success(`Action sent`, describe(action));
    else toast.error('Action failed', result.payload?.message ?? String(result.payload ?? ''));
  }

  const stats = dashboard.stats ?? {};
  const loading = dashboard.status === 'loading';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Proctor dashboard"
        description={exam?.title ? `Monitoring “${exam.title}”` : 'Live invigilation for this exam.'}
        breadcrumb={[{ label: 'Exams', to: '/exams' }, { label: exam?.title ?? 'Exam', to: `/exams/${examId}` }, { label: 'Proctor' }]}
        actions={
          alerts.length > 0 ? (
            <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-sm font-medium text-destructive">
              <ShieldAlert className="h-4 w-4" /> {alerts.length} live alert{alerts.length > 1 ? 's' : ''}
            </span>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="In progress" value={stats.started ?? dashboard.sessions.length} loading={loading} />
        <StatCard label="Completed" value={stats.completed ?? 0} loading={loading} />
        <StatCard label="Flagged" value={stats.flagged ?? 0} loading={loading} />
        <StatCard label="Avg. progress" value={`${Math.round((stats.averageProgress ?? 0) * 100)}%`} loading={loading} />
      </div>

      <ProctorWatchGrid
        sessions={dashboard.sessions}
        onControl={onControl}
        selectedAttemptId={chatAttemptId}
        onOpenChat={(attemptId) => { setChatAttemptId(attemptId); setChatOpen(true); }}
      />

      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><MessagesSquare className="h-4 w-4" /> Candidate chat</DialogTitle>
          </DialogHeader>
          {chatAttemptId ? <ProctorChat attemptId={chatAttemptId} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, loading }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        {loading ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-bold">{value}</p>}
      </CardContent>
    </Card>
  );
}

function describe(action) {
  return { pause: 'Attempt paused', resume: 'Attempt resumed', extraTime: '5 minutes granted', flag: 'Session flagged', terminate: 'Attempt terminated' }[action] ?? 'Done';
}

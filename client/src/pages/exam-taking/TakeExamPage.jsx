import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { fetchExam, selectCurrentExam, selectCurrentExamStatus } from '@/store/slices/examSlice';
import { startAttempt, selectActiveAttempt, selectAttemptStatus, resetAttempt } from '@/store/slices/attemptSlice';
import { resetProctoring } from '@/store/slices/proctoringSlice';
import { ExamInterface } from '@/components/exam-taking/ExamInterface';
import { ProctoringSetup } from '@/components/proctoring/ProctoringSetup';
import { Button } from '@/components/ui/button';

/**
 * Full-bleed candidate exam route (`/exam/:examId/take`, sibling of the app
 * shell so there is no sidebar a proctored candidate could navigate away with).
 *
 * Orchestrates the three runtime phases and the integrity gate:
 *   1. `loading`  — fetch the exam to learn its proctoring requirements.
 *   2. `setup`    — proctored exams show `ProctoringSetup` and only start the
 *      attempt once setup is submitted/approved (a normal exam skips this).
 *   3. `exam`     — `ExamInterface` owns the questions, timer and realtime.
 *
 * Starting an attempt is the server's job: `POST /attempts/exams/:id/start`
 * creates-or-resumes the attempt, returns the answer-key-stripped runtime and
 * arms the authoritative clock, so the client never fabricates an attempt.
 */
export default function TakeExamPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { examId } = useParams();
  const [params] = useSearchParams();
  const accessCode = params.get('code') ?? undefined;
  const inviteToken = params.get('invite') ?? undefined;

  const exam = useAppSelector(selectCurrentExam);
  const examStatus = useAppSelector(selectCurrentExamStatus);
  const attempt = useAppSelector(selectActiveAttempt);
  const attemptStatus = useAppSelector(selectAttemptStatus);
  const attemptError = useAppSelector((state) => state.attempts.error);
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    dispatch(fetchExam(examId));
    return () => {
      dispatch(resetAttempt());
      dispatch(resetProctoring());
    };
  }, [dispatch, examId]);

  const proctored = Boolean(exam?.settings?.isProctored);

  const begin = useCallback(() => {
    dispatch(startAttempt({ examId, accessCode, inviteToken }));
  }, [dispatch, examId, accessCode, inviteToken]);

  // Non-proctored exams start immediately once the exam definition is loaded.
  useEffect(() => {
    if (examStatus === 'ready' && exam && !proctored && !attempt && attemptStatus !== 'error') begin();
  }, [examStatus, exam, proctored, attempt, attemptStatus, begin]);

  const onFinish = useCallback(
    (payload) => {
      const attemptId = payload?.attemptId ?? attempt?.id;
      navigate(`/exams/${examId}/results/${attemptId}`, { replace: true });
    },
    [navigate, examId, attempt],
  );

  if (examStatus === 'loading' || (!exam && examStatus !== 'error')) {
    return <Centered><Loader2 className="h-6 w-6 animate-spin" /> Loading exam…</Centered>;
  }

  if (examStatus === 'error' || !exam) {
    return (
      <Centered>
        <AlertTriangle className="mb-2 h-8 w-8 text-destructive" />
        <p className="font-medium">We couldn't open this exam</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate('/dashboard')}>Back to dashboard</Button>
      </Centered>
    );
  }

  // Proctoring gate for a proctored exam that hasn't been set up yet.
  if (proctored && !setupDone && !attempt) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <ProctoringSetup
          attemptId={null}
          requirements={exam.settings?.proctoring ?? {}}
          onReady={() => {
            setSetupDone(true);
            begin();
          }}
        />
      </div>
    );
  }

  if (attemptStatus === 'error') {
    return (
      <Centered>
        <AlertTriangle className="mb-2 h-8 w-8 text-destructive" />
        <p className="font-medium">{attemptError ?? 'You cannot start this exam'}</p>
        <p className="mt-1 text-sm text-muted-foreground">Check the access code or contact your instructor.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate('/dashboard')}>Back to dashboard</Button>
      </Centered>
    );
  }

  if (!attempt) {
    return <Centered><Loader2 className="h-6 w-6 animate-spin" /> Preparing your session…</Centered>;
  }

  return (
    <ExamInterface
      attemptId={attempt.id}
      examId={examId}
      title={exam.title}
      proctored={proctored}
      settings={exam.settings ?? {}}
      onFinish={onFinish}
    />
  );
}

function Centered({ children }) {
  return <div className="flex min-h-screen flex-col items-center justify-center bg-muted/20 px-4 text-center text-muted-foreground">{children}</div>;
}

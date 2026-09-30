import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, Send, Loader2, WifiOff, Maximize2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  selectActiveAttempt,
  selectAttemptQuestions,
  selectCurrentQuestion,
  selectCursor,
  selectAnswers,
  selectIsSubmitting,
  selectOfflineQueue,
  selectFlagged,
  saveAnswer,
  navigateQuestion,
  toggleMarkForReview,
  submitAttempt,
  setCursor,
} from '@/store/slices/attemptSlice';
import { selectAccessibility } from '@/store/slices/uiSlice';
import { useCountdown } from '@/hooks/useCountdown';
import { useAutosave } from '@/hooks/useAutosave';
import { useExamSocket } from '@/hooks/useExamSocket';
import { useProctoringCandidate } from '@/hooks/useProctoringSocket';
import { useBrowserLockdown } from '@/hooks/useBrowserLockdown';
import { request, endpoints } from '@/lib/apiClient';
import { Timer } from './Timer';
import { NavigationPanel } from './NavigationPanel';
import { SubmitConfirm } from './SubmitConfirm';
import { QuestionRenderer } from './QuestionRenderer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

/**
 * The full candidate exam runtime (used inside the full-bleed `TakeExamPage`).
 *
 * This component is the integration point for every exam-taking concern:
 *   - `useCountdown` drives the server-authoritative clock + auto-submit on 0,
 *   - `useAutosave` persists the answer map on an interval + on tab-hide,
 *   - `useExamSocket` re-syncs runtime/timer over the realtime channel,
 *   - `useProctoringCandidate` folds violation/message pushes into the store,
 *   - `useBrowserLockdown` reports integrity events to `/proctoring/:id/violation`.
 *
 * Answering is **optimistic**: `QuestionRenderer` calls `onChange`, we immediately
 * write the store via `saveAnswer` (which flips local state synchronously then
 * POSTs), so typing never blocks on the network; offline failures queue in the
 * attempt slice and flush on reconnect.
 */
export function ExamInterface({ attemptId, examId, title, proctored = false, settings = {}, onFinish }) {
  const dispatch = useAppDispatch();
  const attempt = useAppSelector(selectActiveAttempt);
  const questions = useAppSelector(selectAttemptQuestions);
  const question = useAppSelector(selectCurrentQuestion);
  const cursor = useAppSelector(selectCursor);
  const answers = useAppSelector(selectAnswers);
  const flagged = useAppSelector(selectFlagged);
  const submitting = useAppSelector(selectIsSubmitting);
  const offlineQueue = useAppSelector(selectOfflineQueue);
  const accessibility = useAppSelector(selectAccessibility);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleChange = useCallback(
    (value) => {
      if (!question) return;
      dispatch(saveAnswer({ attemptId, questionId: question.id, answer: value, answeredAt: new Date().toISOString() }));
    },
    [dispatch, attemptId, question],
  );

  const goTo = useCallback(
    (index) => {
      const clamped = Math.max(0, Math.min(questions.length - 1, index));
      dispatch(setCursor(clamped));
      dispatch(navigateQuestion({ attemptId, target: { index: clamped } }));
    },
    [dispatch, attemptId, questions.length],
  );

  const finishSubmit = useCallback(async () => {
    const result = await dispatch(submitAttempt({ attemptId }));
    if (submitAttempt.fulfilled.match(result)) {
      setConfirmOpen(false);
      onFinish?.(result.payload);
    }
  }, [dispatch, attemptId, onFinish]);

  // ---- realtime + integrity hooks ----
  useCountdown({ onExpire: () => finishSubmit() });
  useAutosave();
  useExamSocket({ attemptId, examId, enabled: Boolean(attemptId), onSubmitted: (payload) => onFinish?.(payload) });
  useProctoringCandidate({ attemptId, enabled: proctored });

  const reportViolation = useCallback(
    async (type, detail) => {
      try {
        await request.post(endpoints.proctoring.violations(attemptId), { type, ...detail });
      } catch {
        /* best effort — the server also infers some violations itself */
      }
    },
    [attemptId],
  );

  const proctorSettings = settings.proctoring ?? {};
  const { requestFullscreenMode } = useBrowserLockdown({
    enabled: proctored,
    blockCopyPaste: proctorSettings.browserLockdown !== false,
    blockRightClick: proctorSettings.browserLockdown !== false,
    requireFullscreen: proctorSettings.fullscreenRequired !== false,
    onViolation: reportViolation,
  });

  const answeredCount = useMemo(
    () =>
      questions.filter((item) => {
        const value = answers[item.id];
        return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
      }).length,
    [questions, answers],
  );

  const progressPct = questions.length ? Math.round((answeredCount / questions.length) * 100) : 0;
  const isFlagged = question ? flagged.includes(question.id) : false;

  if (!question) {
    return (
      <div className="grid min-h-[60vh] place-items-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Preparing your exam…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/20" style={{ fontSize: accessibility.fontSize }}>
      {/* header */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{title ?? attempt?.exam?.title ?? 'Exam'}</p>
          <div className="mt-1 flex max-w-xs items-center gap-2">
            <Progress value={progressPct} className="h-1.5" />
            <span className="whitespace-nowrap text-xs text-muted-foreground">{answeredCount}/{questions.length}</span>
          </div>
        </div>

        {offlineQueue.length > 0 ? (
          <Badge variant="warning" className="gap-1">
            <WifiOff className="h-3 w-3" /> {offlineQueue.length} queued
          </Badge>
        ) : null}

        <Timer />

        {proctored ? (
          <Button variant="outline" size="sm" onClick={requestFullscreenMode}>
            <Maximize2 className="mr-1.5 h-4 w-4" /> Fullscreen
          </Button>
        ) : null}

        <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={submitting}>
          <Send className="mr-1.5 h-4 w-4" /> Submit
        </Button>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-6 p-4 lg:grid-cols-[1fr_260px]">
        {/* question */}
        <main className="rounded-xl border bg-background p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              Question {cursor + 1} of {questions.length}
            </span>
            {question.marks != null ? <Badge variant="secondary">{question.marks} mark{question.marks === 1 ? '' : 's'}</Badge> : null}
          </div>

          <div className="mb-5 text-lg font-medium leading-relaxed">{question.prompt ?? question.content ?? question.title}</div>

          {question.instructions ? <p className="mb-4 text-sm text-muted-foreground">{question.instructions}</p> : null}

          <QuestionRenderer question={question} value={answers[question.id]} onChange={handleChange} disabled={submitting} />

          {/* controls */}
          <div className="mt-6 flex items-center justify-between border-t pt-4">
            <Button variant="outline" onClick={() => goTo(cursor - 1)} disabled={cursor === 0}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <Button
              variant={isFlagged ? 'secondary' : 'ghost'}
              onClick={() => dispatch(toggleMarkForReview({ attemptId, questionId: question.id }))}
            >
              <Flag className={isFlagged ? 'mr-1 h-4 w-4 text-amber-500' : 'mr-1 h-4 w-4'} />
              {isFlagged ? 'Flagged' : 'Flag for review'}
            </Button>
            {cursor === questions.length - 1 ? (
              <Button onClick={() => setConfirmOpen(true)}>
                Finish <Send className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={() => goTo(cursor + 1)}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </main>

        {/* nav rail */}
        <aside className="hidden lg:block">
          <div className="sticky top-20 rounded-xl border bg-background p-4">
            <NavigationPanel onGoTo={goTo} disabled={submitting} />
          </div>
        </aside>
      </div>

      <SubmitConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onSubmit={finishSubmit}
        submitting={submitting}
        offlineCount={offlineQueue.length}
      />
    </div>
  );
}

export default ExamInterface;

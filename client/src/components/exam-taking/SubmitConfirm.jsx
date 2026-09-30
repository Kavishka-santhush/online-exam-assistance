import { useAppSelector } from '@/hooks/useRedux';
import { selectAttemptQuestions, selectAnswers } from '@/store/slices/attemptSlice';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Submit confirmation dialog.
 *
 * Shows the answered/unanswered split so a candidate can catch a skipped
 * question before locking in, and keeps the confirm button disabled while the
 * (server-authoritative) submit is in flight. Pure presentational — the caller
 * owns `open` and the actual `submitAttempt` dispatch, so this component never
 * touches the network itself.
 */
export function SubmitConfirm({ open, onOpenChange, onSubmit, submitting = false, offlineCount = 0 }) {
  const questions = useAppSelector(selectAttemptQuestions);
  const answers = useAppSelector(selectAnswers);

  const isEmpty = (value) =>
    value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

  const unanswered = questions.filter((question) => isEmpty(answers[question.id]));
  const answeredCount = questions.length - unanswered.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit your exam?</DialogTitle>
          <DialogDescription>
            Once submitted you can't change your answers. Please review the summary below.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-bold text-primary">{answeredCount}</p>
            <p className="text-xs text-muted-foreground">Answered</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-bold text-amber-600">{unanswered.length}</p>
            <p className="text-xs text-muted-foreground">Unanswered</p>
          </div>
        </div>

        {unanswered.length > 0 ? (
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="mb-1 font-medium">You still have {unanswered.length} unanswered:</p>
            <p className="text-muted-foreground">
              Question {unanswered.map((q) => questions.indexOf(q) + 1).slice(0, 20).join(', ')}
              {unanswered.length > 20 ? '…' : ''}
            </p>
          </div>
        ) : null}

        {offlineCount > 0 ? (
          <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            {offlineCount} answer change(s) are queued and will be sent when you reconnect. Submitting flushes them first.
          </div>
        ) : null}

        <DialogFooter className="mt-2 gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Keep working
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit for good'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SubmitConfirm;

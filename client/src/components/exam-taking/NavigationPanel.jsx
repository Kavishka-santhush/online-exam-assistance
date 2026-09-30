import { useAppSelector } from '@/hooks/useRedux';
import {
  selectAttemptQuestions,
  selectCursor,
  selectAnswers,
  selectFlagged,
} from '@/store/slices/attemptSlice';
import { cn } from '@/lib/utils';

/**
 * Question navigation rail.
 *
 * Renders one cell per question, colour-coded from the attempt slice's derived
 * state (`answers` → answered, `flagged` → mark-for-review, `cursor` → current).
 * Clicking a cell calls `onGoTo(index)`; the parent routes that through
 * `navigateQuestion` so the server records the visit too. It reads straight from
 * the store (no props for the data) so it stays live as answers autosave.
 */
export function NavigationPanel({ onGoTo, disabled = false }) {
  const questions = useAppSelector(selectAttemptQuestions);
  const answers = useAppSelector(selectAnswers);
  const flagged = useAppSelector(selectFlagged);
  const cursor = useAppSelector(selectCursor);

  const isAnswered = (question) => {
    const value = answers[question.id];
    return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
  };

  const answeredCount = questions.filter(isAnswered).length;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="text-sm font-medium">
        Question <span className="text-primary">{cursor + 1}</span> / {questions.length || '—'}
      </div>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
        {questions.map((question, index) => {
          const answered = isAnswered(question);
          const isFlagged = flagged.includes(question.id);
          const isCurrent = index === cursor;
          return (
            <button
              key={question.id}
              type="button"
              disabled={disabled}
              onClick={() => onGoTo?.(index)}
              className={cn(
                'relative aspect-square rounded-md border text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                isCurrent ? 'border-primary ring-2 ring-primary/40' : 'border-input',
                answered ? 'bg-primary/15 text-primary' : 'bg-background text-muted-foreground hover:bg-muted',
                isFlagged && 'border-amber-400',
              )}
              aria-current={isCurrent ? 'step' : undefined}
              aria-label={`Question ${index + 1}${answered ? ', answered' : ''}${isFlagged ? ', flagged' : ''}`}
            >
              {index + 1}
              {isFlagged ? <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500" /> : null}
            </button>
          );
        })}
      </div>
      <div className="mt-auto grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/40" /> Answered ({answeredCount})
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-amber-400" /> Flagged ({flagged.length})
        </span>
      </div>
    </div>
  );
}

export default NavigationPanel;

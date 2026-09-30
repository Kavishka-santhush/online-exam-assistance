import { useState } from 'react';
import { AlertTriangle, ShieldCheck, Send } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectCandidateProctoring, sendProctorReply } from '@/store/slices/proctoringSlice';
import { violationLabel } from '@/utils/proctoringConstants';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * Candidate-facing proctoring panel.
 *
 * Shows the live feed of integrity events the proctor/servers flagged for *this*
 * attempt and the two-way chat, all read from `proctoring.candidate` (which
 * `useProctoringCandidate` keeps current over the socket). It's intentionally
 * calm and non-technical: the candidate sees *that* something was flagged and can
 * message the proctor, but never the risk score or thresholds — leaking those
 * would tell a cheater exactly how much headroom they have.
 */
export function CandidateProctorFeed({ attemptId }) {
  const dispatch = useAppDispatch();
  const { violations = [], messages = [] } = useAppSelector(selectCandidateProctoring);
  const [text, setText] = useState('');

  function reply(event) {
    event?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    dispatch(sendProctorReply({ attemptId, body, kind: 'REPLY' }));
  }

  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border bg-background p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-primary" /> Monitoring active
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase text-muted-foreground">Session notices</p>
        <ScrollArea className="h-28">
          {violations.length === 0 ? (
            <p className="text-sm text-muted-foreground">All clear. Keep focused on your exam.</p>
          ) : (
            <ul className="space-y-1.5">
              {violations.slice(0, 12).map((violation, index) => (
                <li key={violation.id ?? index} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span className="flex-1 truncate">{violationLabel(violation.type)}</span>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Proctor messages</p>
        <ScrollArea className="h-32 flex-1">
          <div className="space-y-2">
            {messages.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
            {messages.map((message, index) => {
              const mine = message.direction === 'to-proctor';
              return (
                <div key={message.id ?? index} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs ${mine ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    {message.body}
                    {message.kind === 'WARNING' ? <Badge variant="destructive" className="ml-1">warning</Badge> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
        <form onSubmit={reply} className="mt-2 flex gap-2">
          <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Message your proctor…" className="h-8 text-xs" />
          <Button size="icon" type="submit" className="size-8" aria-label="Send"><Send className="h-3.5 w-3.5" /></Button>
        </form>
      </div>
    </div>
  );
}

export default CandidateProctorFeed;

import { Video, Pause, Play, StopCircle, Clock, Flag, MessageSquare, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/common/EmptyState';
import { violationLabel, violationSeverity } from '@/utils/proctoringConstants';
import { cn } from '@/lib/utils';

/**
 * Proctor live watch grid.
 *
 * Renders the `proctor.sessions` rows kept hot by `useProctoringWatch`. Each card
 * surfaces the candidate's connection, progress, risk band and latest violation,
 * plus the control affordances a proctor can take (focus, pause/resume, extra
 * time, terminate, flag). All actions bubble up through `onControl(action,
 * attemptId)` so the page owns the `proctorControl` dispatch and keeps this a
 * dumb view.
 */
export function ProctorWatchGrid({ sessions = [], onControl, onOpenChat, selectedAttemptId }) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<Video className="h-6 w-6" />}
        title="No active sessions"
        description="Candidates appear here live as they pass setup and begin the exam."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((session) => {
        const risk = session.risk ?? session.lastViolation?.count ?? 0;
        const band = risk >= 5 ? 'high' : risk >= 2 ? 'medium' : 'low';
        return (
          <div key={session.attemptId} className={cn('rounded-xl border bg-background p-4', selectedAttemptId === session.attemptId && 'ring-2 ring-primary')}>
            <div className="mb-2 flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{session.candidateName ?? session.displayName ?? `Attempt ${session.attemptId}`}</p>
                <p className="text-xs text-muted-foreground">{session.status ?? (session.paused ? 'Paused' : session.active ? 'Running' : 'Setup')}</p>
              </div>
              <div className="flex items-center gap-1.5">
                {session.online === false ? <WifiOff className="h-4 w-4 text-destructive" /> : <Wifi className="h-4 w-4 text-emerald-500" />}
                {session.flagged ? <Flag className="h-4 w-4 text-amber-500" /> : null}
              </div>
            </div>

            <div className="mb-3 grid aspect-video place-items-center rounded-md bg-muted text-sm text-muted-foreground">
              {session.streamUrl ? (
                <video src={session.streamUrl} autoPlay muted playsInline className="h-full w-full rounded-md object-cover" />
              ) : (
                <span className="flex flex-col items-center gap-1"><Video className="h-6 w-6" /> awaiting feed</span>
              )}
            </div>

            <Progress value={Math.round((session.progress ?? 0) * 100)} className="mb-1 h-1.5" />
            <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{Math.round((session.progress ?? 0) * 100)}% answered</span>
              <Badge variant={band === 'high' ? 'destructive' : band === 'medium' ? 'warning' : 'success'}>{band} risk</Badge>
            </div>

            {session.lastViolation ? (
              <p className="mb-3 truncate rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                ⚠ {violationLabel(session.lastViolation.type)} · {violationSeverity(session.lastViolation.type)}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onControl?.('monitor', session.attemptId)}>
                <Video className="mr-1 h-3.5 w-3.5" /> Focus
              </Button>
              <Button size="sm" variant="outline" onClick={() => onControl?.(session.paused ? 'resume' : 'pause', session.attemptId)}>
                {session.paused ? <Play className="mr-1 h-3.5 w-3.5" /> : <Pause className="mr-1 h-3.5 w-3.5" />}
                {session.paused ? 'Resume' : 'Pause'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onControl?.('extraTime', session.attemptId, { seconds: 300 })}>
                <Clock className="mr-1 h-3.5 w-3.5" /> +5m
              </Button>
              <Button size="sm" variant="outline" onClick={() => onControl?.('flag', session.attemptId, { reason: 'Manual flag' })}>
                <Flag className="mr-1 h-3.5 w-3.5" /> Flag
              </Button>
              {onOpenChat ? (
                <Button size="sm" variant="ghost" onClick={() => onOpenChat(session.attemptId)}>
                  <MessageSquare className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onControl?.('terminate', session.attemptId)}>
                <StopCircle className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ProctorWatchGrid;

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Trophy, XCircle } from 'lucide-react';
import { useLiveQuizSocket } from '@/hooks/useLiveQuizSocket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

// Kahoot-ish shape+colour memory aid: players recognise "the red diamond"
// faster than reading every option again under time pressure.
const OPTION_STYLES = [
  'border-red-500/50 bg-red-500/10 hover:bg-red-500/20',
  'border-blue-500/50 bg-blue-500/10 hover:bg-blue-500/20',
  'border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20',
  'border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20',
];
const OPTION_SHAPES = ['◆', '●', '▲', '■'];

/**
 * Player-facing live-quiz screen (`/live/:code`).
 *
 * Ephemeral by design: no Redux, no attempt record — `useLiveQuizSocket` keeps
 * the room state locally and the server owns scores/leaderboard. The lobby
 * gate (pick a nickname) exists because the socket join needs an identity to
 * broadcast, and answers are lock-in: once sent we disable the board so a
 * player can't shop for the "right" colour after seeing peers' counts.
 */
export default function LiveQuizJoinPage() {
  const { code } = useParams();
  const [identity, setIdentity] = useState(null); // { displayName, teamId }
  const [nameDraft, setNameDraft] = useState('');
  const [myPick, setMyPick] = useState(null);

  const live = useLiveQuizSocket({ code, role: 'player', identity: identity ?? {}, enabled: Boolean(identity) });

  // Re-arm the board for each new question: `myPick` is per-round lock-in state,
  // not session state, so it must clear when the host opens the next one.
  const questionKey = live.question?.id ?? live.question?.prompt ?? null;
  const lastQuestionKey = useRef(null);
  useEffect(() => {
    if (questionKey !== lastQuestionKey.current) {
      lastQuestionKey.current = questionKey;
      setMyPick(null);
    }
  }, [questionKey]);

  // ---- lobby: not joined yet ----
  if (!identity) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
        <div className="text-center">
          <h1 className="text-3xl font-black">Join <span className="font-mono text-primary">{code}</span></h1>
          <p className="mt-1 text-sm text-muted-foreground">Enter the game the host started in your room.</p>
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <div className="space-y-2">
              <Label htmlFor="nick">Your name</Label>
              <Input id="nick" maxLength={24} placeholder="e.g. Nimal" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
            </div>
            <Button
              size="lg"
              className="w-full"
              disabled={!nameDraft.trim()}
              onClick={() => setIdentity({ displayName: nameDraft.trim() })}
            >
              Join game
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- statuses from the hook ----
  if (live.status === 'joining') {
    return <Centered><Loader2 className="h-8 w-8 animate-spin text-primary" /><p className="mt-3 text-sm text-muted-foreground">Joining {code}…</p></Centered>;
  }
  if (live.status === 'error') {
    return (
      <Centered>
        <XCircle className="h-10 w-10 text-destructive" />
        <p className="mt-3 font-semibold">Couldn't join</p>
        <p className="mt-1 text-sm text-muted-foreground">{live.error ?? 'That game has finished or the code is wrong.'}</p>
        <Button asChild variant="outline" className="mt-4"><Link to="/dashboard">Back to dashboard</Link></Button>
      </Centered>
    );
  }

  // ---- ended: final standings ----
  if (live.status === 'ended') {
    const myRank = live.leaderboard.findIndex((row) => row.userId === live.session?.userId);
    return (
      <Centered>
        <Trophy className="h-10 w-10 text-amber-500" />
        <h1 className="mt-3 text-2xl font-black">Game over{myRank >= 0 ? ` — you placed #${myRank + 1}` : ''}!</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your score: <span className="font-semibold">{live.myScore}</span></p>
        <Card className="mt-6 w-full max-w-sm text-left">
          <CardContent className="space-y-1.5 p-4">
            {live.leaderboard.slice(0, 10).map((row, index) => (
              <div key={row.userId ?? index} className="flex items-center gap-2 text-sm">
                <span className="size-6 text-center font-bold text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{row.displayName ?? row.name}</span>
                <span className="font-semibold tabular-nums">{row.score ?? row.totalScore ?? 0}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Button asChild variant="outline" className="mt-6"><Link to="/dashboard">Done</Link></Button>
      </Centered>
    );
  }

  // ---- live: lobby wait vs question vs reveal ----
  const options = live.question?.options ?? [];

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <Badge variant="success">LIVE · {code}</Badge>
        <span className="text-sm text-muted-foreground">{live.participants.length} players · you: {live.myScore}</span>
      </header>

      {!live.question && !live.reveal ? (
        <Centered>
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 font-semibold">Waiting for the host…</p>
          <p className="mt-1 text-sm text-muted-foreground">Get ready — the first question drops when they open it.</p>
        </Centered>
      ) : null}

      {live.question ? (
        <div className="space-y-4">
          <p className="text-lg font-bold">{live.question.prompt ?? live.question.title}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {options.map((option, index) => {
              const key = option.id ?? option.value ?? index;
              const picked = String(myPick) === String(key);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={Boolean(myPick)}
                  className={`flex items-center gap-3 rounded-2xl border-2 p-5 text-left font-semibold transition-colors disabled:opacity-70 ${OPTION_STYLES[index % 4]} ${picked ? 'ring-2 ring-primary' : ''}`}
                  onClick={() => { setMyPick(key); live.answer(key, {}); }}
                >
                  <span className="text-2xl">{OPTION_SHAPES[index % 4]}</span>
                  <span className="min-w-0 flex-1">{option.text ?? option.label ?? String(key)}</span>
                  {picked ? <CheckCircle2 className="h-5 w-5" /> : null}
                </button>
              );
            })}
          </div>
          {myPick != null ? <p className="text-center text-sm text-muted-foreground">Answer locked in — wait for the reveal.</p> : null}
        </div>
      ) : null}

      {live.reveal && !live.question ? (
        <Card className="border-primary/40">
          <CardContent className="space-y-3 p-6 text-center">
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Last round</p>
            {live.reveal.correctAnswer != null || live.reveal.correct != null ? (
              <p className="text-lg font-bold">
                Correct answer: {optionText(live.reveal.correctAnswer ?? live.reveal.correct, options)}
              </p>
            ) : null}
            {typeof live.reveal.correct === 'boolean' ? (
              <p className={live.reveal.correct ? 'font-semibold text-emerald-600' : 'font-semibold text-destructive'}>
                {live.reveal.correct ? 'You got it! 🎉' : 'Not this time.'}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">Next question coming up…</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Centered({ children }) {
  return <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-4 text-center">{children}</div>;
}

function optionText(answer, options) {
  const match = options.find((option, index) => String(option.id ?? option.value ?? index) === String(answer));
  return match?.text ?? match?.label ?? String(answer);
}

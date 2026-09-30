import { useCallback, useEffect, useRef, useState } from 'react';
import { request, endpoints } from '@/lib/apiClient';
import { joinLiveQuiz, leaveLiveQuiz, onSocket, emitSocket } from '@/lib/socket';

/**
 * Kahoot-style Live Quiz realtime (host + participant).
 *
 * Unlike the self-paced exam, a live-quiz session is intentionally *ephemeral*
 * (a game in progress, not a graded attempt), so it keeps its state in local
 * component memory rather than in a Redux slice. The room is `live-quiz:<CODE>`;
 * joining goes through `attempt.service.joinLiveQuiz` over the socket so
 * participant accounting and the leaderboard stay server-authoritative.
 *
 * Server → client events handled here:
 *   `live-quiz:participant-joined` · `live-quiz:question-open`
 *   `live-quiz:question-closed`    · `live-quiz:leaderboard`
 *   `live-quiz:ended`              · `live-quiz:answer-ack`
 *
 * @param {object} opts
 * @param {string} opts.code            join code (uppercase room suffix)
 * @param {'host'|'player'} opts.role
 * @param {object} [opts.identity]      { displayName, teamId } for players
 * @param {boolean} [opts.enabled]
 */
export function useLiveQuizSocket({ code, role = 'player', identity = {}, enabled = true } = {}) {
  const [status, setStatus] = useState('idle'); // idle | joining | live | ended | error
  const [session, setSession] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [question, setQuestion] = useState(null); // open question payload
  const [reveal, setReveal] = useState(null); // results for the closed question
  const [leaderboard, setLeaderboard] = useState([]);
  const [myScore, setMyScore] = useState(0);
  const [error, setError] = useState(null);

  const codeRef = useRef(code);
  codeRef.current = code;
  // Host actions + answers are keyed by the session id the join snapshot
  // returns, not the human-readable code, mirroring the server's routes.
  const sessionIdRef = useRef(null);

  const join = useCallback(async () => {
    if (!code) return;
    setStatus('joining');
    setError(null);
    try {
      // REST join first — returns the current session snapshot for late joiners.
      const snapshot = await request.get(endpoints.attempts.liveSession(code));
      setSession(snapshot);
      sessionIdRef.current = snapshot?.sessionId ?? snapshot?.id ?? null;
      if (snapshot?.leaderboard) setLeaderboard(snapshot.leaderboard);
      if (snapshot?.participants) setParticipants(snapshot.participants);

      const ack = await joinLiveQuiz({ code, displayName: identity.displayName, teamId: identity.teamId });
      if (ack?.ok) {
        setStatus(snapshot?.status === 'ENDED' ? 'ended' : 'live');
        if (ack.session) {
          setSession(ack.session);
          sessionIdRef.current = ack.session?.sessionId ?? ack.session?.id ?? sessionIdRef.current;
        }
      } else {
        setError(ack?.error ?? 'join failed');
        setStatus('error');
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [code, identity.displayName, identity.teamId]);

  useEffect(() => {
    if (!enabled || !code) return undefined;
    join();

    const offs = [
      onSocket('live-quiz:participant-joined', (payload) => {
        setParticipants((prev) => {
          const list = prev.filter((p) => p.userId !== payload.userId);
          return [...list, { ...payload }];
        });
      }),
      onSocket('live-quiz:question-open', (payload) => {
        setQuestion(payload?.question ?? payload ?? null);
        setReveal(null);
      }),
      onSocket('live-quiz:question-closed', (payload) => {
        setQuestion(null);
        setReveal(payload ?? null);
      }),
      onSocket('live-quiz:leaderboard', (payload) => {
        if (Array.isArray(payload?.standings)) setLeaderboard(payload.standings);
        else if (Array.isArray(payload)) setLeaderboard(payload);
      }),
      onSocket('live-quiz:answer-ack', (payload) => {
        if (payload?.scoreDelta) setMyScore((prev) => prev + payload.scoreDelta);
      }),
      onSocket('live-quiz:ended', (payload) => {
        setStatus('ended');
        if (Array.isArray(payload?.finalStandings)) setLeaderboard(payload.finalStandings);
      }),
    ];

    return () => {
      offs.forEach((off) => off());
      if (role === 'player') leaveLiveQuiz({ code: codeRef.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code, role]);

  /** Player submits a lock-in answer for the current question. */
  const answer = useCallback(
    async (answerValue, { timeMs } = {}) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const result = await request.post(endpoints.attempts.liveAnswer(sessionId), { answer: answerValue, timeMs });
        if (typeof result?.score === 'number') setMyScore(result.score);
        // Fire-and-forget socket copy so peers see "X answered" quickly.
        emitSocket('live-quiz:answer', { code: codeRef.current, answer: answerValue });
      } catch (err) {
        setError(err.message);
      }
    },
    [],
  );

  // ---- host controls (REST, server re-checks the host is staff) ----
  const host = {
    advance: useCallback(async () => request.post(endpoints.attempts.liveAdvance(sessionIdRef.current), {}), []),
    closeQuestion: useCallback(async () => request.post(endpoints.attempts.liveCloseQuestion(sessionIdRef.current), {}), []),
    end: useCallback(async () => request.post(endpoints.attempts.liveEnd(sessionIdRef.current), {}), []),
  };

  return { status, session, participants, question, reveal, leaderboard, myScore, error, answer, join, host };
}

export default useLiveQuizSocket;

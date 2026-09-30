import { useEffect } from 'react';
import { useAppDispatch } from './useRedux';
import { getSocket, onSocket, watchProctorExam, unwatchProctorExam, monitorCandidate, emitSocket, socketConnected } from '@/lib/socket';
import {
  violationReceived,
  proctorMessageReceived,
  setupStatusChanged,
  sessionUpdated,
  sessionRemoved,
} from '@/store/slices/proctoringSlice';
import { toast } from '@/store/slices/uiSlice';

/**
 * Proctoring realtime — two consumers, two hooks, one slice.
 *
 * `useProctoringCandidate` runs on the candidate's exam screen. The server
 * pushes identity/violation/message events to the candidate's personal room
 * (`user:<id>`), which they are already in from the socket handshake, so this
 * hook only subscribes — it never needs to join a room itself.
 *
 * `useProctoringWatch` runs on a proctor's dashboard. It explicitly joins the
 * exam's `exam:<id>:proctors` room via `proctor:watch` (which returns a fresh
 * dashboard snapshot the server has already authorised) and folds the live
 * per-attempt events into the watch grid rows.
 *
 * Both funnel events into the `proctoring` slice reducers so REST snapshots and
 * socket updates render through identical state.
 */

const CANDIDATE_STATUS_EVENTS = {
  'proctor:setup-pending': 'PENDING',
  'proctor:awaiting-approval': 'AWAITING_APPROVAL',
  'proctor:approved': 'APPROVED',
  'proctor:session-active': 'ACTIVE',
  'proctor:rejected': 'REJECTED',
};

export function useProctoringCandidate({ attemptId, enabled = true } = {}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!enabled) return undefined;

    const offs = [
      onSocket('proctor:violation', (payload) => {
        if (payload?.attemptId && attemptId && payload.attemptId !== attemptId) return;
        dispatch(violationReceived(payload ?? {}));
        if (payload?.message) dispatch(toast({ title: 'Proctoring alert', description: payload.message, variant: 'warning' }));
      }),
      onSocket('proctor:message', (payload) => {
        dispatch(proctorMessageReceived(payload ?? { direction: 'from-proctor' }));
      }),
      onSocket('proctor:flagged', (payload) => {
        dispatch(toast({ title: 'Session flagged', description: payload?.message ?? 'A proctor is reviewing your session.', variant: 'warning' }));
      }),
      ...Object.entries(CANDIDATE_STATUS_EVENTS).map(([event, status]) =>
        onSocket(event, (payload) => {
          if (payload?.attemptId && attemptId && payload.attemptId !== attemptId) return;
          dispatch(setupStatusChanged({ status }));
        }),
      ),
    ];

    return () => offs.forEach((off) => off());
  }, [dispatch, attemptId, enabled]);
}

export function useProctoringWatch({ examId, enabled = true } = {}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!enabled || !examId || !socketConnected()) {
      // Wait until a socket exists; the shell connects it on sign-in.
      if (!examId || !enabled) return undefined;
    }

    let watching = false;
    const start = async () => {
      const ack = await watchProctorExam({ examId });
      if (ack?.ok) {
        watching = true;
        if (ack.snapshot) dispatch(sessionUpdated({ examId })); // no-op merge, keeps reducer warm
      }
    };
    start();

    const patch = (attemptId, data) => dispatch(sessionUpdated({ attemptId, ...data }));

    const offs = [
      onSocket('proctor:violation', (payload) => {
        dispatch(violationReceived(payload ?? {}));
        if (payload?.attemptId) patch(payload.attemptId, { lastViolation: payload, risk: (payload.count ?? 0) });
      }),
      onSocket('proctor:violation-resolved', (payload) => {
        if (payload?.attemptId) patch(payload.attemptId, { violationResolved: payload.violationId });
      }),
      onSocket('proctor:flagged', (payload) => patch(payload.attemptId, { flagged: true, flagReason: payload.reason })),
      onSocket('proctor:presence', (payload) => patch(payload.attemptId, { online: payload.online ?? true, progress: payload.progress ?? undefined })),
      onSocket('proctor:session-active', (payload) => patch(payload.attemptId, { active: true, approved: payload.approved ?? true })),
      onSocket('proctor:setup-pending', (payload) => patch(payload.attemptId, { setupStatus: 'PENDING' })),
      onSocket('proctor:attempt-paused', (payload) => patch(payload.attemptId, { paused: true })),
      onSocket('proctor:attempt-resumed', (payload) => patch(payload.attemptId, { paused: false })),
      onSocket('proctor:extra-time', (payload) => patch(payload.attemptId, { extraTimeSec: payload.seconds })),
      onSocket('proctor:session-ended', (payload) => dispatch(sessionRemoved({ attemptId: payload.attemptId }))),
      onSocket('proctor:message', (payload) => patch(payload.attemptId, { lastMessage: payload, unread: (payload.seen ? 0 : 1) })),
      onSocket('proctor:message-read', (payload) => patch(payload.attemptId, { messageRead: payload.messageId })),
    ];

    return () => {
      offs.forEach((off) => off());
      if (watching) unwatchProctorExam({ examId });
    };
  }, [dispatch, examId, enabled]);

  return { monitor: (attemptId) => monitorCandidate({ attemptId }) };
}

/**
 * WebRTC signalling relay helper — forwards an SDP offer/answer or ICE
 * candidate to a specific peer (a proctor or the candidate) through the server,
 * which never touches media and only routes to `user:<id>`.
 */
export function sendWebRtcSignal({ to, toRoom, data }, ack) {
  emitSocket('webrtc:signal', { to, toRoom, data }, ack);
}

export function useWebRtcSignals({ enabled = true, onSignal } = {}) {
  const socketRef = getSocket();
  useEffect(() => {
    if (!enabled || typeof onSignal !== 'function') return undefined;
    return onSocket('webrtc:signal', (envelope) => onSignal(envelope));
  }, [enabled, onSignal, socketRef]);
}

export default useProctoringCandidate;

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { request, endpoints } from '@/lib/apiClient';

/**
 * Proctoring slice.
 *
 * Two consumers share this slice, keyed by role:
 *
 *   - **candidate side** — the setup checklist status, the live violation feed,
 *     proctor messages and the risk score, mostly pushed over the socket
 *     (`proctor:*`, `exam:*`) and seeded by `GET /proctoring/:attempt/snapshot`.
 *   - **proctor side** — the watch-grid rows for an exam (`sessions`), pop-up
 *     violation `alerts`, and unread message counts, seeded by
 *     `GET /proctoring/exams/:id/dashboard` then kept live by the socket.
 *
 * Socket handlers in `hooks/useProctoringSocket` dispatch the `*Received`
 * reducers below so realtime and REST converge on one store shape.
 */

export const fetchCandidateSnapshot = createAsyncThunk('proctoring/fetchCandidateSnapshot', async (attemptId, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.proctoring.snapshot(attemptId));
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const completeProctorSetup = createAsyncThunk(
  'proctoring/completeSetup',
  async ({ attemptId, payload }, { rejectWithValue }) => {
    try {
      return await request.post(endpoints.proctoring.setupComplete(attemptId), payload);
    } catch (error) {
      return rejectWithValue({ message: error.message, code: error.code, details: error.details });
    }
  },
);

export const sendProctorReply = createAsyncThunk(
  'proctoring/reply',
  async ({ attemptId, body, kind = 'REPLY' }, { rejectWithValue }) => {
    try {
      return await request.post(endpoints.proctoring.reply(attemptId), { body, kind });
    } catch (error) {
      return rejectWithValue(error.message);
    }
  },
);

export const fetchProctorDashboard = createAsyncThunk('proctoring/fetchDashboard', async (examId, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.proctoring.dashboard(examId));
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const proctorControl = createAsyncThunk(
  'proctoring/control',
  async ({ action, attemptId, payload = {} }, { rejectWithValue }) => {
    const url = {
      pause: endpoints.proctoring.pause(attemptId),
      resume: endpoints.proctoring.resume(attemptId),
      terminate: endpoints.proctoring.terminate(attemptId),
      extraTime: endpoints.proctoring.extraTime(attemptId),
      flag: endpoints.proctoring.flag(attemptId),
    }[action];
    if (!url) return rejectWithValue('unknown control action');
    try {
      return await request.post(url, payload);
    } catch (error) {
      return rejectWithValue({ message: error.message, code: error.code, details: error.details });
    }
  },
);

const initialState = {
  candidate: {
    attemptId: null,
    setupStatus: 'UNKNOWN', // PENDING | AWAITING_APPROVAL | APPROVED | REJECTED | ACTIVE
    active: false,
    violations: [], // [{ id, type, severity, count, at, message }]
    violationCount: 0,
    riskScore: 0,
    messages: [], // [{ id, direction: 'from-proctor'|'to-proctor', body, at, kind }]
    monitor: null, // config + presence snapshot
  },
  proctor: {
    examId: null,
    sessions: [], // watch-grid rows
    stats: { started: 0, completed: 0, flagged: 0, averageProgress: 0 },
    alerts: [], // transient violation pop-ups
    unread: 0,
    status: 'idle',
  },
  loading: false,
  error: null,
};

const proctoringSlice = createSlice({
  name: 'proctoring',
  initialState,
  reducers: {
    resetProctoring: () => ({ ...initialState }),
    clearAlerts(state) {
      state.proctor.alerts = [];
    },
    removeAlert(state, action) {
      state.proctor.alerts = state.proctor.alerts.filter((alert) => alert.id !== action.payload);
    },

    // ---- candidate socket events ----
    violationReceived(state, action) {
      const violation = action.payload;
      state.candidate.violations.unshift(violation);
      state.candidate.violations = state.candidate.violations.slice(0, 100);
      state.candidate.violationCount = violation.count ?? state.candidate.violationCount + 1;
      state.proctor.alerts.unshift({ ...violation, id: violation.id ?? `${violation.type}-${Date.now()}` });
      state.proctor.alerts = state.proctor.alerts.slice(0, 20);
    },
    proctorMessageReceived(state, action) {
      const message = action.payload;
      state.candidate.messages.push({ ...message, direction: message.direction ?? 'from-proctor' });
      if ((message.direction ?? 'from-proctor') === 'from-proctor') state.proctor.unread += 1;
    },
    setupStatusChanged(state, action) {
      state.candidate.setupStatus = action.payload.status ?? action.payload;
      state.candidate.active = ['APPROVED', 'ACTIVE'].includes(state.candidate.setupStatus);
    },
    timerAdjusted(state, action) {
      // candidate-side notice that the proctor granted / removed time
      state.candidate.monitor = { ...(state.candidate.monitor ?? {}), timerAdjusted: action.payload };
    },

    // ---- proctor socket events ----
    sessionUpdated(state, action) {
      const row = action.payload;
      const index = state.proctor.sessions.findIndex((session) => session.attemptId === row.attemptId);
      if (index >= 0) state.proctor.sessions[index] = { ...state.proctor.sessions[index], ...row };
      else state.proctor.sessions.push(row);
    },
    sessionRemoved(state, action) {
      state.proctor.sessions = state.proctor.sessions.filter((session) => session.attemptId !== action.payload.attemptId);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCandidateSnapshot.fulfilled, (state, action) => {
        const snapshot = action.payload ?? {};
        state.candidate.attemptId = snapshot.attemptId ?? state.candidate.attemptId;
        state.candidate.setupStatus = snapshot.setupStatus ?? snapshot.status ?? state.candidate.setupStatus;
        state.candidate.active = Boolean(snapshot.active ?? ['APPROVED', 'ACTIVE'].includes(state.candidate.setupStatus));
        state.candidate.violations = snapshot.violations ?? state.candidate.violations;
        state.candidate.violationCount = snapshot.violationCount ?? state.candidate.violations?.length ?? 0;
        state.candidate.riskScore = snapshot.riskScore ?? state.candidate.riskScore;
        state.candidate.messages = snapshot.messages ?? state.candidate.messages;
        state.candidate.monitor = snapshot.monitor ?? snapshot.config ?? state.candidate.monitor;
      })
      .addCase(fetchProctorDashboard.pending, (state) => {
        state.proctor.status = 'loading';
      })
      .addCase(fetchProctorDashboard.fulfilled, (state, action) => {
        const dashboard = action.payload ?? {};
        state.proctor.examId = dashboard.examId ?? state.proctor.examId;
        state.proctor.sessions = dashboard.sessions ?? dashboard.candidates ?? [];
        state.proctor.stats = dashboard.stats ?? state.proctor.stats;
        state.proctor.status = 'ready';
      })
      .addCase(sendProctorReply.fulfilled, (state, action) => {
        state.candidate.messages.push({ ...action.payload, direction: 'to-proctor' });
      });
  },
});

export const {
  resetProctoring,
  clearAlerts,
  removeAlert,
  violationReceived,
  proctorMessageReceived,
  setupStatusChanged,
  timerAdjusted,
  sessionUpdated,
  sessionRemoved,
} = proctoringSlice.actions;

export const selectCandidateProctoring = (state) => state.proctoring.candidate;
export const selectProctorDashboard = (state) => state.proctoring.proctor;
export const selectProctorAlerts = (state) => state.proctoring.proctor.alerts;

export default proctoringSlice.reducer;

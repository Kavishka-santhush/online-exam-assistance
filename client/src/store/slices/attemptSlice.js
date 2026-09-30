import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { request, endpoints } from '@/lib/apiClient';

/**
 * Attempt slice — the live exam-taking session for a candidate.
 *
 * Holds the current question set, the answer map (keyed by questionId), the
 * navigation cursor, the mark-for-review set and the server timer snapshot. The
 * two behaviours that matter most for exam integrity are encoded here:
 *
 *   - **Optimistic + durable saves.** Every answer change updates local state
 *     immediately (so typing is never blocked on the network), then autosaves.
 *     If the request fails because we are offline, the mutation is pushed to
 *     `offlineQueue` and replayed on reconnect — mirroring the server's
 *     `syncOfflineQueue` endpoint.
 *   - **Server-authoritative timer.** `runtime` carries the server's remaining
 *     time; `timerSlice` counts down against `serverTime`, never the clock the
 *     candidate could tamper with.
 */

export const registerForExam = createAsyncThunk('attempts/register', async ({ examId, payload = {} }, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.attempts.register(examId), payload);
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details, code: error.code });
  }
});

export const startAttempt = createAsyncThunk(
  'attempts/start',
  async ({ examId, accessCode, inviteToken }, { rejectWithValue }) => {
    try {
      return await request.post(endpoints.attempts.start(examId), { accessCode, inviteToken });
    } catch (error) {
      return rejectWithValue({ message: error.message, details: error.details, code: error.code, status: error.status });
    }
  },
);

export const loadRuntime = createAsyncThunk('attempts/loadRuntime', async (attemptId, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.attempts.runtime(attemptId));
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const saveAnswer = createAsyncThunk(
  'attempts/saveAnswer',
  async ({ attemptId, questionId, answer, answeredAt }, { dispatch, rejectWithValue }) => {
    dispatch(answerChanged({ questionId, answer, answeredAt })); // optimistic
    try {
      return await request.post(endpoints.attempts.answer(attemptId), { questionId, answer, answeredAt });
    } catch (error) {
      if (isNetworkError(error)) dispatch(queueOffline({ kind: 'answer', attemptId, body: { questionId, answer } }));
      return rejectWithValue({ message: error.message, code: error.code, details: error.details });
    }
  },
);

export const autosave = createAsyncThunk(
  'attempts/autosave',
  async ({ attemptId, answers }, { dispatch, rejectWithValue }) => {
    try {
      return await request.post(endpoints.attempts.autosave(attemptId), { answers });
    } catch (error) {
      if (isNetworkError(error)) dispatch(queueOffline({ kind: 'autosave', attemptId, body: { answers } }));
      return rejectWithValue({ message: error.message, code: error.code });
    }
  },
);

export const navigateQuestion = createAsyncThunk(
  'attempts/navigate',
  async ({ attemptId, target }, { dispatch, rejectWithValue }) => {
    dispatch(setCursor(target));
    try {
      return await request.post(endpoints.attempts.navigate(attemptId), target);
    } catch (error) {
      if (isNetworkError(error)) dispatch(queueOffline({ kind: 'navigate', attemptId, body: target }));
      return rejectWithValue(error.message);
    }
  },
);

export const toggleMarkForReview = createAsyncThunk(
  'attempts/toggleMark',
  async ({ attemptId, questionId }, { dispatch, getState, rejectWithValue }) => {
    const next = !getState().attempts.flagged.includes(questionId);
    dispatch(markToggled({ questionId, flagged: next }));
    try {
      return await request.post(endpoints.attempts.markForReview(attemptId), { questionId, flagged: next });
    } catch (error) {
      dispatch(markToggled({ questionId, flagged: !next })); // revert
      return rejectWithValue(error.message);
    }
  },
);

export const revealHint = createAsyncThunk('attempts/revealHint', async ({ attemptId, questionId }, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.attempts.revealHint(attemptId), { questionId });
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const runSampleTests = createAsyncThunk('attempts/runTests', async ({ attemptId, questionId, code, language }, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.attempts.runTests(attemptId), { questionId, code, language });
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

export const pauseAttempt = createAsyncThunk('attempts/pause', async ({ attemptId, reason }, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.attempts.pause(attemptId), { reason });
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const resumeAttempt = createAsyncThunk('attempts/resume', async (attemptId, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.attempts.resume(attemptId), {});
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const submitAttempt = createAsyncThunk(
  'attempts/submit',
  async ({ attemptId, answers = null }, { dispatch, getState, rejectWithValue }) => {
    dispatch(setSubmitting(true));
    try {
      const pending = getState().attempts.offlineQueue;
      // Best-effort: flush anything queued so nothing the candidate typed is lost.
      if (pending.length) await dispatch(flushOfflineQueue());
      return await request.post(endpoints.attempts.submit(attemptId), { answers, ip: undefined });
    } catch (error) {
      return rejectWithValue({ message: error.message, code: error.code, details: error.details });
    } finally {
      dispatch(setSubmitting(false));
    }
  },
);

export const flushOfflineQueue = createAsyncThunk('attempts/flushOffline', async (_, { getState, dispatch, rejectWithValue }) => {
  const queue = getState().attempts.offlineQueue;
  if (!queue.length) return { flushed: 0 };
  const remaining = [];
  let flushed = 0;
  for (const item of queue) {
    try {
      const url =
        item.kind === 'answer'
          ? endpoints.attempts.answer(item.attemptId)
          : item.kind === 'autosave'
            ? endpoints.attempts.autosave(item.attemptId)
            : item.kind === 'navigate'
              ? endpoints.attempts.navigate(item.attemptId)
              : null;
      if (!url) continue;
      await request.post(url, item.body);
      flushed += 1;
    } catch (error) {
      if (isNetworkError(error)) remaining.push(item);
    }
  }
  dispatch(queueReplaced(remaining));
  return { flushed, remaining: remaining.length };
});

function isNetworkError(error) {
  return !error.status || error.code === 'NETWORK_ERROR' || error.code === 'ERR_NETWORK';
}

const initialState = {
  active: null, // { id, examId, exam, status, expiresAt }
  questions: [], // ordered [{ id, order, type, content, ... } (answer keys stripped)]
  sections: [],
  answers: {}, // questionId -> answer value
  flagged: [], // questionId[] marked for review
  answered: {}, // questionId -> boolean
  cursor: 0, // index into questions
  runtime: null, // server timer snapshot
  status: 'idle', // idle | loading | ready | error
  error: null,
  submitting: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  offlineQueue: [], // durable mutations awaiting reconnect
  lastSavedAt: null,
};

const attemptSlice = createSlice({
  name: 'attempts',
  initialState,
  reducers: {
    resetAttempt: () => ({ ...initialState, online: typeof navigator === 'undefined' ? true : navigator.onLine }),
    setOnline: (state, action) => {
      state.online = Boolean(action.payload);
    },
    setCursor: (state, action) => {
      state.cursor = typeof action.payload === 'number' ? action.payload : state.cursor;
    },
    setSubmitting: (state, action) => {
      state.submitting = Boolean(action.payload);
    },
    answerChanged: (state, { payload }) => {
      state.answers[payload.questionId] = payload.answer;
      const empty = payload.answer === undefined || payload.answer === null || payload.answer === '' ||
        (Array.isArray(payload.answer) && payload.answer.length === 0);
      state.answered[payload.questionId] = !empty;
      state.lastSavedAt = null;
    },
    markToggled: (state, { payload }) => {
      const set = new Set(state.flagged);
      if (payload.flagged) set.add(payload.questionId);
      else set.delete(payload.questionId);
      state.flagged = [...set];
    },
    queueOffline: (state, { payload }) => {
      state.offlineQueue.push({ ...payload, queuedAt: Date.now() });
    },
    queueReplaced: (state, { payload }) => {
      state.offlineQueue = payload;
    },
    hydrateAttempt: (state, { payload }) => {
      Object.assign(state, {
        active: payload.active,
        questions: payload.questions ?? [],
        sections: payload.sections ?? [],
        answers: payload.answers ?? {},
        flagged: payload.flagged ?? [],
        answered: payload.answered ?? {},
        cursor: payload.cursor ?? 0,
        runtime: payload.runtime ?? null,
        status: 'ready',
        error: null,
      });
    },
  },
  extraReducers: (builder) => {
    const applyRuntime = (state, runtime) => {
      if (!runtime) return;
      if (runtime.questions) state.questions = runtime.questions;
      if (runtime.sections) state.sections = runtime.sections;
      if (runtime.answers) {
        state.answers = { ...state.answers, ...runtime.answers };
        for (const [questionId, value] of Object.entries(runtime.answers ?? {})) {
          state.answered[questionId] = value !== undefined && value !== null && value !== '';
        }
      }
      if (Array.isArray(runtime.flagged)) state.flagged = runtime.flagged;
      if (runtime.currentQuestionIndex != null) state.cursor = runtime.currentQuestionIndex;
      state.runtime = runtime.timer ?? runtime ?? state.runtime;
      state.status = 'ready';
    };

    builder
      .addCase(startAttempt.fulfilled, (state, action) => {
        state.active = action.payload.attempt ?? action.payload;
        applyRuntime(state, action.payload);
      })
      .addCase(startAttempt.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(loadRuntime.fulfilled, (state, action) => applyRuntime(state, action.payload))
      .addCase(saveAnswer.fulfilled, (state) => {
        state.lastSavedAt = Date.now();
      })
      .addCase(autosave.fulfilled, (state) => {
        state.lastSavedAt = Date.now();
      })
      .addCase(submitAttempt.fulfilled, (state, action) => {
        state.active = { ...state.active, status: action.payload.status ?? 'SUBMITTED' };
        state.offlineQueue = [];
      });
  },
});

export const {
  resetAttempt,
  setOnline,
  setCursor,
  setSubmitting,
  answerChanged,
  markToggled,
  queueOffline,
  queueReplaced,
  hydrateAttempt,
} = attemptSlice.actions;

export const selectActiveAttempt = (state) => state.attempts.active;
export const selectAttemptQuestions = (state) => state.attempts.questions;
export const selectCurrentQuestion = (state) => state.attempts.questions[state.attempts.cursor] ?? null;
export const selectAnswers = (state) => state.attempts.answers;
export const selectAnswerFor = (questionId) => (state) => state.attempts.answers[questionId];
export const selectCursor = (state) => state.attempts.cursor;
export const selectAttemptRuntime = (state) => state.attempts.runtime;
export const selectOfflineQueue = (state) => state.attempts.offlineQueue;
export const selectIsSubmitting = (state) => state.attempts.submitting;
export const selectAttemptStatus = (state) => state.attempts.status;
export const selectAnsweredCount = (state) => Object.values(state.attempts.answered).filter(Boolean).length;
export const selectFlagged = (state) => state.attempts.flagged;

export default attemptSlice.reducer;

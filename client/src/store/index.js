import { configureStore } from '@reduxjs/toolkit';

import authReducer from './slices/authSlice';
import uiReducer from './slices/uiSlice';
import examReducer from './slices/examSlice';
import attemptReducer from './slices/attemptSlice';
import timerReducer from './slices/timerSlice';
import proctoringReducer from './slices/proctoringSlice';
import notificationReducer from './slices/notificationSlice';

/**
 * Root Redux store.
 *
 * Slice map mirrors the server's bounded contexts. `serializableCheck` is off
 * for the exam/attempt slices because they legitimately carry Date objects and
 * File handles from autosave/offline-queue payloads; ignoring the paths (rather
 * than disabling the middleware) keeps the check active everywhere else.
 */
export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
    exams: examReducer,
    attempts: attemptReducer,
    timer: timerReducer,
    proctoring: proctoringReducer,
    notifications: notificationReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      immutableCheck: { warnAfter: 128 },
      serializableCheck: {
        ignoreActions: [
          'attempts/queueOffline',
          'attempts/flushOffline',
          'attempts/saveAnswer',
          'attempts/autosave',
        ],
        ignorePaths: ['attempts.offlineQueue', 'attempts.pendingAnswers', 'proctoring.mediaStream'],
      },
    }),
});

export default store;

/**
 * Proctoring violation catalogue.
 *
 * `type` values are what the client emits to `POST /proctoring/:attempt/violation`
 * and what the server echoes back down the `proctor:violation` socket event, so
 * the detection hooks in `useBrowserLockdown` and the proctor watch-grid share
 * one vocabulary. `severity` drives the colour/weight in `ViolationAlert`, and
 * `autoTerminable` marks the events that count toward the exam's
 * `autoTerminateAfterViolations` threshold.
 */

export const VIOLATION_TYPE = {
  TAB_HIDDEN: 'TAB_HIDDEN',
  WINDOW_BLUR: 'WINDOW_BLUR',
  FULLSCREEN_EXIT: 'FULLSCREEN_EXIT',
  COPY: 'COPY',
  PASTE: 'PASTE',
  RIGHT_CLICK: 'RIGHT_CLICK',
  KEYBOARD_SHORTCUT: 'KEYBOARD_SHORTCUT',
  DEVTOOLS_OPEN: 'DEVTOOLS_OPEN',
  NO_FACE: 'NO_FACE',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  FACE_MISMATCH: 'FACE_MISMATCH',
  SECOND_SCREEN: 'SECOND_SCREEN',
  AUDIO_DETECT: 'AUDIO_DETECT',
  MOTION_DETECT: 'MOTION_DETECT',
  NETWORK_LOSS: 'NETWORK_LOSS',
  PROCESS_SWITCH: 'PROCESS_SWITCH',
  CLIPBOARD_ACCESS: 'CLIPBOARD_ACCESS',
};

export const VIOLATION_SEVERITY = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
};

/**
 * Per-type defaults. `severity` + `autoTerminable` let the client both warn the
 * candidate and decide what to forward to the proctor without bespoke logic.
 */
export const VIOLATION_META = {
  [VIOLATION_TYPE.TAB_HIDDEN]: { label: 'Left the exam tab', severity: 'HIGH', autoTerminable: true },
  [VIOLATION_TYPE.WINDOW_BLUR]: { label: 'Window lost focus', severity: 'MEDIUM', autoTerminable: true },
  [VIOLATION_TYPE.FULLSCREEN_EXIT]: { label: 'Exited fullscreen', severity: 'HIGH', autoTerminable: true },
  [VIOLATION_TYPE.COPY]: { label: 'Copied content', severity: 'MEDIUM', autoTerminable: false },
  [VIOLATION_TYPE.PASTE]: { label: 'Pasted content', severity: 'HIGH', autoTerminable: false },
  [VIOLATION_TYPE.RIGHT_CLICK]: { label: 'Right-click attempt', severity: 'LOW', autoTerminable: false },
  [VIOLATION_TYPE.KEYBOARD_SHORTCUT]: { label: 'Blocked keyboard shortcut', severity: 'MEDIUM', autoTerminable: false },
  [VIOLATION_TYPE.DEVTOOLS_OPEN]: { label: 'DevTools opened', severity: 'CRITICAL', autoTerminable: true },
  [VIOLATION_TYPE.NO_FACE]: { label: 'No face detected', severity: 'HIGH', autoTerminable: true },
  [VIOLATION_TYPE.MULTIPLE_FACES]: { label: 'Multiple faces detected', severity: 'CRITICAL', autoTerminable: true },
  [VIOLATION_TYPE.FACE_MISMATCH]: { label: 'Identity mismatch', severity: 'CRITICAL', autoTerminable: true },
  [VIOLATION_TYPE.SECOND_SCREEN]: { label: 'Possible second screen', severity: 'MEDIUM', autoTerminable: false },
  [VIOLATION_TYPE.AUDIO_DETECT]: { label: 'Background speech detected', severity: 'MEDIUM', autoTerminable: false },
  [VIOLATION_TYPE.MOTION_DETECT]: { label: 'Unexpected motion', severity: 'LOW', autoTerminable: false },
  [VIOLATION_TYPE.NETWORK_LOSS]: { label: 'Connection dropped', severity: 'MEDIUM', autoTerminable: false },
  [VIOLATION_TYPE.PROCESS_SWITCH]: { label: 'Application switched', severity: 'HIGH', autoTerminable: true },
  [VIOLATION_TYPE.CLIPBOARD_ACCESS]: { label: 'Clipboard accessed', severity: 'MEDIUM', autoTerminable: false },
};

export function violationLabel(type) {
  return VIOLATION_META[type]?.label ?? 'Suspicious activity';
}

export function violationSeverity(type) {
  return VIOLATION_META[type]?.severity ?? VIOLATION_SEVERITY.MEDIUM;
}

export function isAutoTerminable(type) {
  return Boolean(VIOLATION_META[type]?.autoTerminable);
}

/** Setup checklist items shown before a proctored exam begins. */
export const PROCTOR_SETUP_STEPS = [
  { key: 'system', label: 'System check', description: 'Browser, camera, microphone and screen-share capability.' },
  { key: 'id', label: 'ID verification', description: 'Photo of a government ID for the proctor to review.' },
  { key: 'face', label: 'Face capture', description: 'Selfie compared against your ID.' },
  { key: 'environment', label: 'Environment scan', description: '360° webcam sweep of your surroundings.' },
  { key: 'agreement', label: 'Proctoring agreement', description: 'Accept the monitoring terms to continue.' },
];

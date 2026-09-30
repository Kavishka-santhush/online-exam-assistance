import { useCallback, useState } from 'react';

/**
 * Capability probe for the pre-exam system check (`ProctoringSetup`).
 *
 * Answers, synchronously from feature detection plus one round of live getUser-
 * Media/getDisplayMedia permission prompts, whether this browser can actually
 * supply the devices the exam's proctoring rules require. It does not decide the
 * exam's policy — the component compares the result against
 * `settings.proctoring.requireCamera/Microphone/ScreenShare` and blocks the
 * "start exam" button until every required capability reports `granted`.
 */
const initial = {
  webRtc: 'unknown',
  camera: 'unknown',
  microphone: 'unknown',
  screenShare: 'unknown',
  fullscreen: 'unknown',
  secureContext: 'unknown',
  detail: {},
  checked: false,
};

function supportsWebRtc() {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.RTCPeerConnection);
}

async function probeDevice(kind) {
  if (!navigator.mediaDevices?.getUserMedia) return { state: 'unsupported', error: 'no getUserMedia' };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: { facingMode: 'user' } } : { audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { state: 'granted' };
  } catch (error) {
    // `notallowed` is a deliberate denial (fixable by the user); `absent` means
    // the hardware does not exist, which no permission grant can fix.
    const state = error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError' ? 'absent' : 'denied';
    return { state, error: error?.message };
  }
}

async function probeScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return { state: 'unsupported' };
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return { state: 'granted' };
  } catch (error) {
    return { state: error?.name === 'NotAllowedError' ? 'denied' : 'absent', error: error?.message };
  }
}

export function useCapabilities() {
  const [caps, setCaps] = useState(initial);

  const runChecks = useCallback(async ({ checkCamera = true, checkMicrophone = true, checkScreenShare = false } = {}) => {
    const next = { ...initial, checked: true };
    next.secureContext = window.isSecureContext ? 'ok' : 'insecure';
    next.webRtc = supportsWebRtc() ? 'ok' : 'unsupported';
    next.fullscreen = document.documentElement?.requestFullscreen ? 'ok' : 'unsupported';

    const detail = {};
    if (checkCamera) detail.camera = await probeDevice('camera');
    if (checkMicrophone) detail.microphone = await probeDevice('microphone');
    if (checkScreenShare) detail.screenShare = await probeScreenShare();

    next.camera = detail.camera?.state ?? 'skipped';
    next.microphone = detail.microphone?.state ?? 'skipped';
    next.screenShare = detail.screenShare?.state ?? 'skipped';
    next.detail = detail;

    setCaps(next);
    return next;
  }, []);

  const reset = useCallback(() => setCaps(initial), []);

  return { capabilities: caps, runChecks, reset };
}

export default useCapabilities;

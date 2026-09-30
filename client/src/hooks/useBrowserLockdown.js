import { useCallback, useEffect, useRef, useState } from 'react';
import { VIOLATION_TYPE } from '@/utils/proctoringConstants';

/**
 * Browser lockdown (JavaScript-enforced).
 *
 * The candidate-facing proctoring "teeth" for a browser-only deployment:
 *
 *   - tab / window switching  → `visibilitychange` + `blur`
 *   - fullscreen enforcement  → `fullscreenchange` (leaving is a violation and
 *     we try to re-enter)
 *   - copy / paste / cut      → clipboard events blocked + reported
 *   - right click             → `contextmenu` suppressed
 *   - keyboard shortcuts      → Ctrl+C/V/X/P/S/U, F12, Ctrl+Shift+I/J, Alt+Tab
 *   - DevTools                → a window-size heuristic + debugger-timing probe
 *
 * It never *decides* consequences — every detection calls `onViolation(type,
 * detail)` and the owning component forwards to `POST /proctoring/:attempt/
 * violation` (and shows the candidate a `ViolationAlert`). Auto-termination on
 * an N-violation threshold is the server's job (it holds the authoritative
 * counter), so the client just reports faithfully and de-duplicates bursts.
 *
 * @param {object}   options
 * @param {boolean}  options.enabled            master switch (exam is proctored)
 * @param {boolean}  options.blockCopyPaste
 * @param {boolean}  options.blockRightClick
 * @param {boolean}  options.requireFullscreen
 * @param {Function} options.onViolation         (type, detail) => void
 */
export function useBrowserLockdown({
  enabled = false,
  blockCopyPaste = true,
  blockRightClick = true,
  requireFullscreen = true,
  onViolation = () => {},
} = {}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [locked, setLocked] = useState(false);

  // Keep the latest callback in a ref so our listeners never go stale and we
  // don't re-attach the whole web of handlers whenever the caller re-renders.
  const report = useRef(onViolation);
  report.current = onViolation;

  // Coalesce rapid repeats of the same violation (a stuck Alt key, a resize
  // loop) so we don't spam the proctor or trip the auto-terminate counter.
  const lastFired = useRef({});
  const fire = useCallback((type, detail) => {
    const now = Date.now();
    if (now - (lastFired.current[type] ?? 0) < 1500) return;
    lastFired.current[type] = now;
    report.current(type, { ...detail, at: new Date().toISOString() });
  }, []);

  const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

  const requestFullscreenMode = useCallback(async () => {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      setLocked(isFullscreen());
    } catch {
      /* user gesture required; the setup screen drives the first entry */
    }
  }, []);

  const exitFullscreenMode = useCallback(async () => {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    } catch {
      /* ignore */
    }
    setLocked(false);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const onVisibility = () => {
      if (document.hidden) fire(VIOLATION_TYPE.TAB_HIDDEN, {});
    };
    const onBlur = () => fire(VIOLATION_TYPE.WINDOW_BLUR, {});

    const onFullscreenChange = () => {
      const fs = isFullscreen();
      setFullscreen(fs);
      setLocked(fs);
      if (requireFullscreen && !fs) fire(VIOLATION_TYPE.FULLSCREEN_EXIT, {});
    };

    const onContext = (event) => {
      if (!blockRightClick) return;
      event.preventDefault();
      fire(VIOLATION_TYPE.RIGHT_CLICK, {});
    };

    const blockClipboard = (name) => (event) => {
      if (!blockCopyPaste) return;
      event.preventDefault();
      fire(name, {});
    };
    const onCopy = blockClipboard(VIOLATION_TYPE.COPY);
    const onCut = blockClipboard(VIOLATION_TYPE.COPY);
    const onPaste = blockClipboard(VIOLATION_TYPE.PASTE);

    const BLOCKED_KEYS = [
      { key: 'c', ctrl: true, meta: true },
      { key: 'v', ctrl: true, meta: true },
      { key: 'x', ctrl: true, meta: true },
      { key: 'p', ctrl: true, meta: true },
      { key: 's', ctrl: true, meta: true },
      { key: 'u', ctrl: true, meta: true },
      { key: 'F12' },
      { key: 'Tab', alt: true },
      { key: 'I', ctrl: true, shift: true },
      { key: 'J', ctrl: true, shift: true },
      { key: 'C', ctrl: true, shift: true },
    ];
    const onKeyDown = (event) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      for (const combo of BLOCKED_KEYS) {
        const needsCtrl = combo.ctrl || combo.meta;
        const matchesKey = event.key.toLowerCase() === combo.key.toLowerCase();
        const matchesCtrl = needsCtrl ? ctrlOrMeta : true;
        const matchesShift = combo.shift ? event.shiftKey : true;
        const matchesAlt = combo.alt ? event.altKey : true;
        if (matchesKey && matchesCtrl && matchesShift && matchesAlt) {
          event.preventDefault();
          event.stopPropagation();
          fire(VIOLATION_TYPE.KEYBOARD_SHORTCUT, { key: event.key });
          return;
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    if (blockRightClick) document.addEventListener('contextmenu', onContext);
    if (blockCopyPaste) {
      document.addEventListener('copy', onCopy);
      document.addEventListener('cut', onCut);
      document.addEventListener('paste', onPaste);
    }
    window.addEventListener('keydown', onKeyDown, true);

    // DevTools heuristic: the gap between the outer window and the viewport
    // grows sharply when a docked panel opens. Cheap, imperfect, and enough to
    // flag the attempt for a human proctor to inspect.
    let devtoolsTimer = null;
    if (requireFullscreen) {
      devtoolsTimer = setInterval(() => {
        const threshold = 160;
        const widthGap = window.outerWidth - window.innerWidth;
        const heightGap = window.outerHeight - window.innerHeight;
        if (widthGap > threshold || heightGap > threshold) {
          fire(VIOLATION_TYPE.DEVTOOLS_OPEN, { widthGap, heightGap });
        }
      }, 2000);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown, true);
      if (devtoolsTimer) clearInterval(devtoolsTimer);
    };
  }, [enabled, blockCopyPaste, blockRightClick, requireFullscreen, fire]);

  return { locked, fullscreen, requestFullscreenMode, exitFullscreenMode };
}

export default useBrowserLockdown;

import { useEffect } from 'react';
import { useAppDispatch, useAppStore } from './useRedux';
import { setTheme, setAccessibility, setSidebar } from '@/store/slices/uiSlice';

const STORAGE_KEY = 'exam-platform.ui';

/**
 * Persist a small slice of UI preferences (theme, sidebar collapse, candidate
 * accessibility settings) to localStorage so a reload keeps the user's look and
 * the exam's font/contrast choices.
 *
 * On mount it *hydrates* the store from storage (the slices start from OS
 * defaults), then subscribes to write back whenever one of those fields changes.
 * Deliberately selective — toasts, busy spinners and the command-palette open
 * state are ephemeral and must not leak across reloads.
 */
export function usePersistUi() {
  const dispatch = useAppDispatch();
  const store = useAppStore();

  // hydrate once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.theme) dispatch(setTheme(saved.theme));
      if (typeof saved.sidebarCollapsed === 'boolean') dispatch(setSidebar(saved.sidebarCollapsed));
      if (saved.accessibility) dispatch(setAccessibility(saved.accessibility));
    } catch {
      /* corrupt storage — ignore and let defaults stand */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // write-back subscription
  useEffect(() => {
    let last = null;
    const unsubscribe = store.subscribe(() => {
      const ui = store.getState().ui;
      const snapshot = {
        theme: ui.theme,
        sidebarCollapsed: ui.sidebarCollapsed,
        accessibility: ui.accessibility,
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized !== last) {
        last = serialized;
        try {
          localStorage.setItem(STORAGE_KEY, serialized);
        } catch {
          /* storage full / disabled — non-fatal */
        }
      }
    });
    return unsubscribe;
  }, [store]);
}

export default usePersistUi;

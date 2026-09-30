import { createSlice, nanoid } from '@reduxjs/toolkit';

/**
 * UI slice — ephemeral presentation state that does not belong to any domain:
 * theme, sidebar state, the command palette, toast notifications, and the
 * candidate-facing accessibility controls (font size / high-contrast) that the
 * exam interface reads. Persisted to localStorage by `hooks/usePersistUi`.
 */

const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

const initialState = {
  theme: 'system', // 'light' | 'dark' | 'system'
  resolvedTheme: prefersDark ? 'dark' : 'light',
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  toasts: [],
  accessibility: {
    fontSize: 16, // px, drives exam UI root font-size
    highContrast: false,
    reducedMotion: false,
  },
  busy: false, // global overlay spinner
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setTheme(state, action) {
      state.theme = action.payload;
      state.resolvedTheme = action.payload === 'system' ? (prefersDark ? 'dark' : 'light') : action.payload;
    },
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setSidebar(state, action) {
      state.sidebarCollapsed = Boolean(action.payload);
    },
    setCommandPalette(state, action) {
      state.commandPaletteOpen = Boolean(action.payload);
    },
    toastAdded: {
      reducer(state, action) {
        state.toasts.unshift(action.payload);
        if (state.toasts.length > 6) state.toasts.length = 6;
      },
      prepare({ title, description, variant = 'default', duration = 5000 }) {
        return { payload: { id: nanoid(), title, description, variant, duration } };
      },
    },
    toastRemoved(state, action) {
      state.toasts = state.toasts.filter((toast) => toast.id !== action.payload);
    },
    clearToasts(state) {
      state.toasts = [];
    },
    setAccessibility(state, action) {
      Object.assign(state.accessibility, action.payload);
    },
    setBusy(state, action) {
      state.busy = Boolean(action.payload);
    },
  },
});

export const {
  setTheme,
  toggleSidebar,
  setSidebar,
  setCommandPalette,
  toastAdded,
  toastRemoved,
  clearToasts,
  setAccessibility,
  setBusy,
} = uiSlice.actions;

/** Convenience action creators so callers do not repeat the reducer name. */
export const toast = (options) => toastAdded(options);

export const selectTheme = (state) => state.ui.theme;
export const selectResolvedTheme = (state) => state.ui.resolvedTheme;
export const selectSidebarCollapsed = (state) => state.ui.sidebarCollapsed;
export const selectToasts = (state) => state.ui.toasts;
export const selectAccessibility = (state) => state.ui.accessibility;
export const selectBusy = (state) => state.ui.busy;

export default uiSlice.reducer;

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './useRedux';
import { setTheme, selectTheme, selectResolvedTheme, selectAccessibility } from '@/store/slices/uiSlice';
import { usePrefersDark, usePrefersReducedMotion } from './useMediaQuery';

/**
 * Theme + accessibility driver.
 *
 * Reads the `ui` slice and reflects it onto the document: toggles the `dark`
 * class Tailwind uses for dark mode, sets a `data-high-contrast` attribute our
 * CSS keys off, exposes the chosen font size as a root CSS variable (the exam UI
 * inherits it) and, when the OS reports `prefers-reduced-motion`, disables the
 * Framer Motion transitions by tagging `<html>`. Mounted once in the app shell.
 */
export function useTheme() {
  const dispatch = useAppDispatch();
  const theme = useAppSelector(selectTheme);
  const resolved = useAppSelector(selectResolvedTheme);
  const accessibility = useAppSelector(selectAccessibility);
  const systemDark = usePrefersDark();
  const reducedMotion = usePrefersReducedMotion();

  // Resolve 'system' against the live OS preference.
  useEffect(() => {
    if (theme === 'system') dispatch(setTheme('system'));
  }, [theme, systemDark, dispatch]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.setProperty('color-scheme', resolved);
  }, [resolved]);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-high-contrast', Boolean(accessibility.highContrast));
    root.style.fontSize = `${accessibility.fontSize}px`;
  }, [accessibility.highContrast, accessibility.fontSize]);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-reduced-motion', reducedMotion || Boolean(accessibility.reducedMotion));
  }, [reducedMotion, accessibility.reducedMotion]);

  return { theme, resolvedTheme: resolved, setTheme: (value) => dispatch(setTheme(value)), toggle: () => dispatch(setTheme(resolved === 'dark' ? 'light' : 'dark')) };
}

export default useTheme;

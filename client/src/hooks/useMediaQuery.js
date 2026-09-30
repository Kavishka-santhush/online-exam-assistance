import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Used for responsive layout (collapse the
 * sidebar / switch the proctor grid to a compact view), `prefers-reduced-motion`
 * (the accessibility slice respects it) and print styles.
 *
 * @param {string} query  e.g. '(min-width: 1024px)'
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const list = window.matchMedia(query);
    const handler = (event) => setMatches(event.matches);
    setMatches(list.matches);
    // addEventListener on MediaQueryList is modern; fall back to the legacy API.
    if (list.addEventListener) {
      list.addEventListener('change', handler);
      return () => list.removeEventListener('change', handler);
    }
    list.addListener(handler);
    return () => list.removeListener(handler);
  }, [query]);

  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 767px)');
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
export const usePrefersDark = () => useMediaQuery('(prefers-color-scheme: dark)');

export default useMediaQuery;

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounced value — e.g. question-bank search boxes that hit `GET /questions`
 * and should not fire a request on every keystroke.
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Debounced callback — keeps a stable function identity (so it can be an effect
 * dependency) while deferring its invocation, useful for autosize / scroll
 * handlers and the proctor grid's throttled cursor-position pings.
 */
export function useDebouncedCallback(fn, delay = 300) {
  const timer = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const run = useCallback(
    (...args) => {
      cancel();
      timer.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay, cancel],
  );

  useEffect(() => cancel, [cancel]);
  return run;
}

export default useDebouncedValue;

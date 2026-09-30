import { useDispatch, useSelector, useStore } from 'react-redux';

/**
 * Pre-typed Redux hooks.
 *
 * Every feature imports these rather than the raw react-redux hooks so the
 * store shape has one binding surface and swapping / narrowing it later is a
 * single-file change.
 */

export const useAppDispatch = () => useDispatch();
export const useAppSelector = useSelector;
export const useAppStore = useStore;

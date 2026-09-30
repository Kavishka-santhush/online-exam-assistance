import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware className joiner used by every shadcn/ui primitive. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

const APP_NAME = import.meta.env.VITE_APP_NAME || 'Exam Platform';

export { APP_NAME };

/** Join URL segments without leaving stray slashes. */
export function joinUrl(base, ...parts) {
  const clean = (value) => String(value).replace(/^\/+|\/+$/g, '');
  return [base, ...parts].filter(Boolean).map(clean).join('/');
}

/** Byte count -> human string (used in upload / recording UIs). */
export function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

/** Seconds -> `H:MM:SS` / `MM:SS` for the exam timer. */
export function formatDuration(totalSeconds, { showHours = true } = {}) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours && showHours) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

/** Minutes -> `1h 30m` / `45m` for settings summaries. */
export function formatMinutes(minutes) {
  const value = Math.round(Number(minutes) || 0);
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Currency from integer cents (Stripe / exam-fee amounts). */
export function formatCurrency(cents, currency = 'usd') {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export function formatDate(value, options = {}) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', ...options }).format(date);
}

export function formatDateTime(value, options = {}) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...options }).format(date);
}

/** Relative "3 minutes ago" style label. */
export function timeAgo(value) {
  if (!value) return '';
  const date = new Date(value).getTime();
  const diff = Date.now() - date;
  const units = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms || unit === 'second') {
      return formatter.format(-Math.round(diff / ms), unit);
    }
  }
  return '';
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Percentage with a bounded, tidy decimal. */
export function percentage(part, total, digits = 1) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(digits));
}

/** Initials for avatar fallbacks. */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Truncate a long id/token for display (cert numbers, attempt ids). */
export function shorten(value, front = 6, back = 4) {
  const str = String(value ?? '');
  if (str.length <= front + back + 1) return str;
  return `${str.slice(0, front)}…${str.slice(-back)}`;
}

export function uniqueBy(list, keySelector) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keySelector(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Deep-ish clone that keeps Dates and drops functions (safe for redux state). */
export function plainClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(plainClone);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'function') continue;
    out[key] = plainClone(entry);
  }
  return out;
}

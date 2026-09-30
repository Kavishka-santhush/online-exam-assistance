/**
 * Client-side file download helpers.
 *
 * Exports (CSV/XLSX/PDF), result bundles and certificates come back either as a
 * JSON envelope containing a server `/uploads/…` URL (the server writes every
 * artifact with Multer to local disk) or as a raw binary blob. These two shapes
 * need different handling — a blob must be wrapped in an object-URL, a hosted
 * file can simply be navigated to — so the logic lives in one place instead of
 * being re-derived at each download button.
 */

import { api } from '@/lib/apiClient';

/** Trigger a browser download from an in-memory Blob. */
export function downloadBlob(blob, filename = 'download') {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Download a server-hosted file (already on local disk under /uploads). */
export function downloadUrl(url, filename) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename ?? '';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Fetch a protected endpoint as a binary blob (Excel export, PDF certificate,
 * result CSV) and save it. The axios instance already attaches the Clerk token
 * and org header; `responseType:'blob'` keeps the envelope-unwrap interceptor
 * from mangling the body.
 */
export async function downloadFromEndpoint(url, filename, { params = {}, method = 'get' } = {}) {
  const response = await api.request({
    url,
    method,
    params,
    responseType: 'blob',
  });
  downloadBlob(response.data, filename);
  return response;
}

/** Resolve a server-relative `/uploads/...` path to an absolute origin URL. */
export function resolveUploadUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = import.meta.env.VITE_API_URL || window.location.origin;
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Read a File input into a data URL — used by local-only image previews. */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

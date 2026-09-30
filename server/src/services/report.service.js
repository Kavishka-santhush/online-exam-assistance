/**
 * Report service.
 *
 * All PDF rendering: certificates, invoices, result documents, answer sheets,
 * and analytics reports. Uses Puppeteer via `config/puppeteer.js` and writes
 * files to local disk under `<uploadRoot>/reports/`.
 *
 * Every `render*` function returns `{ url, storagePath, sizeBytes, mimeType }`
 * or throws `BROWSER_UNAVAILABLE` if Chromium isn't installed.
 */

const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const puppeteer = require('../config/puppeteer');
const { ApiError } = require('../utils/response.util');

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const CATEGORY = 'reports';

function resolveDir() {
  const now = new Date();
  const rel = `${CATEGORY}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const abs = path.join(env.uploadRoot, rel);
  fs.mkdirSync(abs, { recursive: true });
  return { abs, rel: rel.split(path.sep).join('/') };
}

function writePdf(pdfBuffer, fileName) {
  const { abs, rel } = resolveDir();
  const filePath = path.join(abs, fileName);
  fs.writeFileSync(filePath, pdfBuffer);
  return {
    url: `/uploads/${rel}/${fileName}`,
    storagePath: filePath,
    sizeBytes: pdfBuffer.length,
    mimeType: 'application/pdf',
  };
}

function safeFileName(prefix, id) {
  return `${prefix}-${String(id).replace(/[^a-z0-9]/gi, '_').slice(0, 32)}-${Date.now()}.pdf`;
}

// ---------------------------------------------------------------------------
// Certificate PDF
// ---------------------------------------------------------------------------

async function renderCertificatePdf({ certificateId }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering is not available on this server');

  const cert = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: {
      template: true,
      organization: { select: { name: true, branding: true, website: true } },
      exam: { select: { title: true, totalMarks: true, passingPercent: true } },
      user: { select: { email: true } },
    },
  });
  if (!cert) throw ApiError.notFound('Certificate not found');

  const config = cert.template?.config ?? {};
  const branding = cert.organization?.branding ?? {};
  const html = buildCertificateHtml(cert, config, branding);
  const format = mapPaperSize(config.size);
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format: format.format, landscape: format.landscape, margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' } });
  const fileName = safeFileName('cert', cert.certificateNo);
  const result = writePdf(pdfBuffer, fileName);

  logger.info('certificate PDF rendered', { certificateId, fileName, sizeBytes: result.sizeBytes });
  return result;
}

function mapPaperSize(size) {
  const map = {
    A4_PORTRAIT: { format: 'A4', landscape: false },
    A4_LANDSCAPE: { format: 'A4', landscape: true },
    LETTER_PORTRAIT: { format: 'Letter', landscape: false },
    LETTER_LANDSCAPE: { format: 'Letter', landscape: true },
    A3_LANDSCAPE: { format: 'A3', landscape: true },
  };
  return map[size] ?? { format: 'A4', landscape: true };
}

function buildCertificateHtml(cert, config, branding) {
  const colors = config.colors ?? { primary: '#0f766e', accent: '#b45309', text: '#0f172a', background: '#ffffff', border: '#0f766e' };
  const fonts = config.fonts ?? { heading: 'Georgia, serif', body: 'Helvetica, Arial, sans-serif' };
  const layout = config.layout ?? {};
  const borderStyle = config.border?.style === 'none' ? 'none' : `${config.border?.width ?? 8}px ${config.border?.style ?? 'double'} ${colors.border}`;

  const name = cert.candidateName ?? '';
  const examTitle = cert.examTitle ?? '';
  const scoreText = layout.showScore !== false ? `${Number(cert.scorePercent).toFixed(1)}%` : '';
  const gradeText = layout.gradeLetter !== false && cert.gradeLetter ? `Grade: ${cert.gradeLetter}` : '';
  const issuedDate = new Date(cert.issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const validUntil = cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long' }) : '';
  const orgName = cert.organization?.name ?? '';
  const logoUrl = branding.logoUrl ?? null;
  const certNo = cert.certificateNo;
  const verifyUrl = cert.metadata?.verificationUrl ?? '';
  const qrDataUrl = cert.qrDataUrl ?? '';

  const heading = config.heading ?? 'Certificate of Achievement';
  const subheading = config.subheading ?? 'This is to certify that';
  const bodyText = (config.bodyText ?? 'has successfully completed {examTitle}').replace('{examTitle}', examTitle).replace('{candidateName}', name);
  const congrats = config.congratulations ?? 'Congratulations on this accomplishment.';
  const footer = (config.footerNote ?? 'Verify this certificate at {verificationUrl}').replace('{verificationUrl}', verifyUrl);
  const signatoryName = config.signatoryName ?? branding.signatoryName ?? 'Authorized Signatory';
  const signatoryTitle = config.signatoryTitle ?? branding.signatoryTitle ?? '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Certificate ${certNo}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:297mm;height:210mm;display:flex;align-items:center;justify-content:center;background:${colors.background};font-family:${fonts.body};color:${colors.text};overflow:hidden}
.certificate{width:280mm;height:195mm;border:${borderStyle};padding:20mm 25mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;position:relative;background:${config.backgroundImage ? `url(${config.backgroundImage}) center/cover` : colors.background}}
.heading{font-family:${fonts.heading};font-size:2.6em;color:${colors.primary};text-align:center;margin-bottom:4mm}
.subheading{font-size:1.1em;color:${colors.text};opacity:0.7;margin-bottom:6mm}
.name{font-family:${fonts.heading};font-size:2.2em;color:${colors.accent};margin-bottom:4mm;border-bottom:2px solid ${colors.accent};padding-bottom:2mm}
.body-text{font-size:1.15em;text-align:center;max-width:80%;margin-bottom:4mm}
.congrats{font-style:italic;opacity:0.8;margin-bottom:4mm}
.meta{display:flex;gap:20mm;font-size:0.9em;opacity:0.7}
.signatures{display:flex;justify-content:space-between;width:100%;margin-top:8mm}
.sig-block{text-align:center}
.sig-line{border-top:1.5px solid ${colors.text};width:60mm;margin:0 auto 2mm}
.sig-name{font-weight:bold;font-size:0.95em}
.sig-title{font-size:0.8em;opacity:0.7}
.qr{position:absolute;bottom:14mm;${layout.qrPosition === 'bottom-right' ? 'right' : 'left'}:14mm;width:22mm}
.qr img{width:100%}
.logo{position:absolute;top:12mm;${layout.logoPosition === 'top-left' ? 'left' : layout.logoPosition === 'top-right' ? 'right' : 'center'}:${layout.logoPosition === 'top-center' ? '50%;transform:translateX(-50%)' : '14mm'};max-height:18mm}
.logo img{max-height:18mm}
.cert-no{position:absolute;top:14mm;right:16mm;font-size:0.7em;opacity:0.5}
.validity{font-size:0.75em;opacity:0.6;margin-top:2mm}
</style></head><body>
<div class="certificate">
  ${logoUrl ? `<div class="logo"><img src="${logoUrl}"></div>` : ''}
  <div class="cert-no">${certNo}</div>
  <div>
    <div class="heading">${heading}</div>
    <div class="subheading">${subheading}</div>
    <div class="name">${name}</div>
    <div class="body-text">${bodyText}</div>
    <div class="congrats">${congrats}</div>
    <div class="meta">
      ${scoreText ? `<span>Score: ${scoreText}</span>` : ''}
      ${gradeText ? `<span>${gradeText}</span>` : ''}
      <span>Issued: ${issuedDate}</span>
    </div>
    ${validUntil && layout.showValidity !== false ? `<div class="validity">Valid until: ${validUntil}</div>` : ''}
  </div>
  <div class="signatures">
    <div class="sig-block"><div class="sig-line"></div><div class="sig-name">${signatoryName}</div><div class="sig-title">${signatoryTitle}</div></div>
    <div class="sig-block"><div class="sig-line"></div><div class="sig-name">${orgName}</div><div class="sig-title">${cert.organization?.website ?? ''}</div></div>
  </div>
  ${qrDataUrl && layout.showQR !== false ? `<div class="qr"><img src="${qrDataUrl}"></div>` : ''}
  <div style="font-size:0.7em;opacity:0.5;position:absolute;bottom:8mm;left:50%;transform:translateX(-50%)">${footer}</div>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Invoice PDF
// ---------------------------------------------------------------------------

async function renderInvoicePdf({ invoiceId }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering is not available on this server');

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      organization: { select: { name: true, branding: true, website: true, addressLine1: true, city: true, country: true } },
      user: { select: { displayName: true, email: true, firstName: true, lastName: true } },
      exam: { select: { title: true } },
    },
  });
  if (!invoice) throw ApiError.notFound('Invoice not found');

  const html = buildInvoiceHtml(invoice);
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format: 'A4', landscape: false });
  const fileName = safeFileName('invoice', invoice.number);
  const result = writePdf(pdfBuffer, fileName);

  logger.info('invoice PDF rendered', { invoiceId, fileName });
  return result;
}

function buildInvoiceHtml(invoice) {
  const org = invoice.organization ?? {};
  const branding = org.branding ?? {};
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const currency = (invoice.currency ?? 'usd').toUpperCase();
  const fmtMoney = (cents) => `${currency} ${(cents / 100).toFixed(2)}`;

  const rows = items.map((item) => `<tr><td>${item.description ?? ''}</td><td>${item.qty ?? 1}</td><td>${fmtMoney(item.unitCents ?? 0)}</td><td>${fmtMoney(item.totalCents ?? 0)}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${invoice.number}</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1e293b;padding:40px}
h1{color:${branding.primaryColor ?? '#0f766e'};margin-bottom:4px}
.header{display:flex;justify-content:space-between;margin-bottom:30px}
table{width:100%;border-collapse:collapse;margin-top:20px}
th,td{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left}
th{background:#f8fafc}
.totals{margin-top:20px;text-align:right}
.totals td{border:none;padding:4px 10px}
.grand{font-weight:bold;font-size:16px}
</style></head><body>
<div class="header"><div><h1>INVOICE</h1><p>${invoice.number}</p></div>
<div style="text-align:right"><strong>${org.name ?? ''}</strong><br>${org.addressLine1 ?? ''}<br>${org.city ?? ''} ${org.country ?? ''}<br>${org.website ?? ''}</div></div>
<p><strong>Billed to:</strong> ${invoice.billingName ?? invoice.user?.displayName ?? ''}<br>${invoice.billingEmail ?? invoice.user?.email ?? ''}</p>
<p><strong>Issued:</strong> ${new Date(invoice.issuedAt).toLocaleDateString()} | <strong>Status:</strong> ${invoice.status}</p>
<table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
<div class="totals"><table>
<tr><td>Subtotal</td><td>${fmtMoney(invoice.subtotalCents)}</td></tr>
${invoice.discountCents > 0 ? `<tr><td>Discount</td><td>-${fmtMoney(invoice.discountCents)}</td></tr>` : ''}
${invoice.taxCents > 0 ? `<tr><td>Tax</td><td>${fmtMoney(invoice.taxCents)}</td></tr>` : ''}
<tr class="grand"><td>Total</td><td>${fmtMoney(invoice.totalCents)}</td></tr>
</table></div>
${invoice.notes ? `<p style="margin-top:30px;font-size:12px;color:#64748b">${invoice.notes}</p>` : ''}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Result document PDF
// ---------------------------------------------------------------------------

async function renderResultPdf({ attemptId }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering is not available on this server');

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      exam: { select: { id: true, title: true, totalMarks: true, passingPercent: true, organizationId: true } },
      user: { select: { displayName: true, email: true, firstName: true, lastName: true } },
      organization: { select: { name: true, branding: true } },
      answers: { orderBy: { order: 'asc' }, include: { question: { select: { id: true, prompt: true, type: true, marks: true } } } },
    },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const html = buildResultHtml(attempt);
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format: 'A4', landscape: false });
  const fileName = safeFileName('result', attemptId);
  const result = writePdf(pdfBuffer, fileName);

  await prisma.uploadedFile.create({
    data: {
      attemptId, organizationId: attempt.organizationId, examId: attempt.examId, userId: attempt.userId,
      kind: 'RESULT_PDF', url: result.url, storagePath: result.storagePath,
      originalName: fileName, mimeType: 'application/pdf', sizeBytes: result.sizeBytes,
      metadata: { attemptId },
    },
  }).catch(() => null);

  return result;
}

function buildResultHtml(attempt) {
  const branding = attempt.organization?.branding ?? {};
  const answers = attempt.answers ?? [];
  const scoreRows = answers.map((a) => `<tr><td>${a.order ?? ''}</td><td>${(a.question?.prompt ?? '').slice(0, 80)}</td><td>${a.question?.type ?? ''}</td><td>${Number(a.finalScore ?? 0).toFixed(1)}</td><td>${Number(a.maxMarks ?? a.question?.marks ?? 0).toFixed(1)}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Result — ${attempt.exam?.title ?? ''}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#1e293b;padding:30px}h1{color:${branding.primaryColor ?? '#0f766e'};font-size:22px}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #e2e8f0;padding:7px 10px;text-align:left}th{background:#f1f5f9}.summary{display:flex;gap:20px;margin:15px 0}.card{border:1px solid #e2e8f0;border-radius:8px;padding:12px 18px;text-align:center}.card .value{font-size:22px;font-weight:bold;color:${branding.primaryColor ?? '#0f766e'}}</style></head><body>
<h1>Exam Result</h1><p><strong>${attempt.exam?.title ?? ''}</strong> | ${attempt.user?.displayName ?? ''} | ${new Date(attempt.submittedAt ?? Date.now()).toLocaleDateString()}</p>
<div class="summary">
<div class="card"><div class="value">${Number(attempt.scorePercent ?? 0).toFixed(1)}%</div><div>Score</div></div>
<div class="card"><div class="value">${attempt.gradeLetter ?? '—'}</div><div>Grade</div></div>
<div class="card"><div class="value">${attempt.passed ? 'PASS' : 'FAIL'}</div><div>Result</div></div>
<div class="card"><div class="value">${Number(attempt.finalScore ?? 0).toFixed(1)} / ${Number(attempt.totalMarks ?? 0).toFixed(1)}</div><div>Marks</div></div>
</div>
<table><thead><tr><th>#</th><th>Question</th><th>Type</th><th>Scored</th><th>Max</th></tr></thead><tbody>${scoreRows}</tbody></table>
<p style="margin-top:20px;font-size:11px;color:#64748b">Generated by ${attempt.organization?.name ?? 'Exam Platform'} — ${env.API_BASE_URL}</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Answer sheet PDF (all questions with model answers — for instructor use)
// ---------------------------------------------------------------------------

async function renderAnswerSheetPdf({ examId }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering unavailable');

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      organization: { select: { name: true, branding: true } },
      examQuestions: { orderBy: { order: 'asc' }, include: { question: { select: { id: true, prompt: true, type: true, marks: true, content: true, explanation: true } } } },
    },
  });
  if (!exam) throw ApiError.notFound('Exam not found');

  const html = buildAnswerSheetHtml(exam);
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format: 'A4', landscape: false });
  const fileName = safeFileName('answer-sheet', examId);
  return writePdf(pdfBuffer, fileName);
}

function buildAnswerSheetHtml(exam) {
  const questions = exam.examQuestions ?? [];
  const rows = questions.map((eq, i) => {
    const q = eq.question ?? {};
    const options = (q.content?.options ?? []).map((o) => `<li>${o.text ?? ''} ${o.isCorrect ? ' ✓' : ''}</li>`).join('');
    return `<div class="question"><h3>Q${i + 1} (${q.type}, ${q.marks} marks)</h3><p>${q.prompt ?? ''}</p>${options ? `<ul>${options}</ul>` : ''}${q.content?.correctOptionId ? `<p><strong>Answer:</strong> ${q.content.correctOptionId}</p>` : ''}${q.explanation ? `<p class="explanation">${q.explanation}</p>` : ''}</div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Answer Sheet — ${exam.title}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;font-size:13px;padding:30px;color:#1e293b}h1{font-size:20px;color:${exam.organization?.branding?.primaryColor ?? '#0f766e'}}.question{margin:15px 0;padding:12px;border:1px solid #e2e8f0;border-radius:6px}.explanation{font-size:12px;color:#64748b;font-style:italic}</style></head><body>
<h1>Answer Key — ${exam.title}</h1><p>Total marks: ${Number(exam.totalMarks).toFixed(1)} | Duration: ${exam.durationMinutes} min</p>
${rows}</body></html>`;
}

// ---------------------------------------------------------------------------
// Analytics export PDF
// ---------------------------------------------------------------------------

async function renderAnalyticsPdf({ examId, statistics }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering unavailable');

  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, organizationId: true, totalMarks: true, passingPercent: true }, include: { organization: { select: { name: true, branding: true } } } });
  if (!exam) throw ApiError.notFound('Exam not found');

  const html = buildAnalyticsHtml(exam, statistics);
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format: 'A4', landscape: false });
  const fileName = safeFileName('analytics', examId);
  return writePdf(pdfBuffer, fileName);
}

function buildAnalyticsHtml(exam, stats = {}) {
  const questionRows = (stats.questionStats ?? []).map((q) => `<tr><td>${q.prompt?.slice(0, 60) ?? q.questionId}</td><td>${(q.difficultyIndex ?? 0).toFixed(2)}</td><td>${(q.discriminationIndex ?? 0).toFixed(2)}</td><td>${(q.skipRate ?? 0).toFixed(1)}%</td><td>${(q.avgTimeSec ?? 0).toFixed(0)}s</td></tr>`).join('');
  const topicRows = (stats.topicPerformance ?? []).map((t) => `<tr><td>${t.topic}</td><td>${(t.avgScorePercent ?? 0).toFixed(1)}%</td><td>${t.attemptCount ?? 0}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Analytics — ${exam.title}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;font-size:13px;padding:30px;color:#1e293b}h1{font-size:20px}h2{font-size:16px;margin-top:20px}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left}th{background:#f1f5f9}</style></head><body>
<h1>Exam Analytics Report</h1><p><strong>${exam.title}</strong> by ${exam.organization?.name ?? ''} — Generated ${new Date().toLocaleDateString()}</p>
<h2>Summary</h2><p>Attempts: ${stats.totalAttempts ?? 0} | Avg Score: ${(stats.averagePercent ?? 0).toFixed(1)}% | Pass Rate: ${(stats.passRate ?? 0).toFixed(1)}%</p>
<h2>Question Statistics</h2><table><thead><tr><th>Question</th><th>Difficulty</th><th>Discrimination</th><th>Skip %</th><th>Avg Time</th></tr></thead><tbody>${questionRows}</tbody></table>
<h2>Topic Performance</h2><table><thead><tr><th>Topic</th><th>Avg Score</th><th>Attempts</th></tr></thead><tbody>${topicRows}</tbody></table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Generic HTML-to-PDF (used by controllers for custom templates)
// ---------------------------------------------------------------------------

async function renderGenericPdf({ html, fileName = 'document', format = 'A4', landscape = false }) {
  if (!puppeteer.isAvailable()) throw ApiError.internal('PDF rendering unavailable');
  const pdfBuffer = await puppeteer.htmlToPdf(html, { format, landscape });
  return writePdf(pdfBuffer, `${fileName}-${Date.now()}.pdf`);
}

// ---------------------------------------------------------------------------
// CSV export helpers (no Puppeteer needed)
// ---------------------------------------------------------------------------

function renderCsv(rows, headers) {
  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\n');
}

async function exportResultsCsv({ examId }) {
  const attempts = await prisma.attempt.findMany({
    where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } },
    include: { user: { select: { displayName: true, email: true } } },
    orderBy: { submittedAt: 'asc' },
  });
  const headers = ['Candidate', 'Email', 'Score', 'Max Marks', 'Percent', 'Grade', 'Passed', 'Submitted At', 'Duration (s)', 'Attempt #'];
  const rows = attempts.map((a) => [
    a.user?.displayName ?? '', a.user?.email ?? '',
    Number(a.finalScore ?? 0).toFixed(2), Number(a.totalMarks ?? 0).toFixed(2),
    Number(a.scorePercent ?? 0).toFixed(2), a.gradeLetter ?? '',
    a.passed ? 'Yes' : 'No', a.submittedAt?.toISOString() ?? '',
    a.usedTimeSec, a.attemptNumber,
  ]);
  return { csv: renderCsv(rows, headers), fileName: `results-${examId}.csv`, mimeType: 'text/csv', rowCount: rows.length };
}

async function exportAnalyticsCsv({ examId }) {
  const answers = await prisma.answer.findMany({
    where: { attempt: { examId } },
    include: { question: { select: { id: true, prompt: true, type: true, marks: true } }, attempt: { select: { userId: true } } },
  });
  const headers = ['Question ID', 'Question', 'Type', 'Candidate', 'Answered', 'Score', 'Max', 'Correct', 'Time Spent (s)', 'Skipped'];
  const rows = answers.map((a) => [
    a.questionId, (a.question?.prompt ?? '').slice(0, 100), a.question?.type ?? '', a.attempt?.userId ?? '',
    a.textAnswer != null || a.response != null ? 'Yes' : 'No',
    Number(a.finalScore ?? 0).toFixed(2), Number(a.maxMarks ?? 0).toFixed(2),
    a.isCorrect ? 'Yes' : a.isPartial ? 'Partial' : 'No', a.timeSpentSec, a.wasSkipped ? 'Yes' : 'No',
  ]);
  return { csv: renderCsv(rows, headers), fileName: `analytics-${examId}.csv`, mimeType: 'text/csv', rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  renderCertificatePdf,
  renderInvoicePdf,
  renderResultPdf,
  renderAnswerSheetPdf,
  renderAnalyticsPdf,
  renderGenericPdf,
  exportResultsCsv,
  exportAnalyticsCsv,
  renderCsv,
};

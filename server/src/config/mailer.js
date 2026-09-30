/**
 * Transactional email: Nodemailer transport + React Email rendering.
 *
 * When SMTP_HOST is unset (local development) messages are logged instead of
 * sent, and the rendered HTML is written to `<UPLOAD_DIR>/emails/` so the
 * developer can open it in a browser. Nothing else changes for the caller.
 */

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const renderModule = require('@react-email/render');
const { resolveTemplate } = require('./emailTemplates');
const env = require('./env');
const logger = require('../utils/logger.util');

const render = renderModule.render ?? renderModule.default ?? renderModule;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!env.SMTP_HOST) {
    logger.warn('SMTP_HOST is not set - emails will be logged and written to disk only');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 5,
  });
  return transporter;
}

function fromHeader(overrides = {}) {
  const name = overrides.fromName ?? env.MAIL_FROM_NAME;
  const address = overrides.fromAddress ?? env.MAIL_FROM_ADDRESS;
  return `${name} <${address}>`;
}

/** Render a React Email component to { html, text } - or pass through raw html. */
function buildBody({ template, props = {}, html, text }) {
  if (html) return { html, text: text ?? stripTags(html) };
  if (!template) throw new Error('sendMail requires either `template` or `html`');
  const component = resolveTemplate(template);
  if (typeof component !== 'function') throw new Error(`Unknown email template "${template}"`);
  const rendered = htmlOf(render(component(props), { pretty: false }));
  return { html: rendered, text: text ?? props.plainText ?? stripTags(rendered) };
}

function htmlOf(rendered) {
  return typeof rendered === 'string' ? rendered : rendered?.html ?? '';
}

function stripTags(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function writePreviewFile(to, subject, html) {
  const directory = path.join(env.uploadRoot, 'emails');
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${Date.now()}-${String(to).replace(/[^a-z0-9]+/gi, '-')}.html`);
  await fs.promises.writeFile(file, html, 'utf8');
  return file;
}

/**
 * @param {object} params
 * @param {string|string[]} params.to
 * @param {string} params.subject
 * @param {Function} [params.template] React Email component (function of props)
 * @param {object} [params.props]      props passed to the template
 * @param {string} [params.html]       pre-rendered html (reports, receipts)
 * @param {string} [params.text]       plain-text alternative
 * @param {Array}  [params.attachments] nodemailer attachment descriptors
 * @param {string} [params.replyTo]
 */
async function sendMail({ to, subject, template, props = {}, html, text, attachments = [], replyTo, ...overrides }) {
  const recipients = Array.isArray(to) ? to : [to];
  const body = buildBody({ template, props, html, text });
  const client = getTransporter();

  if (!client) {
    const written = [];
    for (const recipient of recipients) {
      written.push(await writePreviewFile(recipient, subject, body.html));
    }
    logger.info(`email suppressed (no SMTP): "${subject}" -> ${recipients.join(', ')}`, { previews: written });
    return { delivered: false, reason: 'NO_SMTP_CONFIGURED', recipients, subject, previews: written };
  }

  const info = await client.sendMail({
    from: fromHeader(overrides),
    to: recipients.join(', '),
    subject,
    text: body.text,
    html: body.html,
    replyTo: replyTo ?? undefined,
    attachments: attachments.length ? attachments : undefined,
    ...overrides.headers,
  });

  logger.info(`email sent: "${subject}" -> ${recipients.join(', ')}`, { messageId: info.messageId });
  return { delivered: true, messageId: info.messageId, recipients, subject };
}

/** Fire-and-forget wrapper: a failed email must never fail an API request. */
function queueMail(params) {
  sendMail(params).catch((error) => {
    logger.error('email delivery failed', { error: error.message, subject: params.subject, to: params.to });
  });
}

async function verifyConnection() {
  const client = getTransporter();
  if (!client) return { ok: false, reason: 'NO_SMTP_CONFIGURED' };
  await client.verify();
  return { ok: true };
}

module.exports = {
  buildBody,
  fromHeader,
  getTransporter,
  queueMail,
  render,
  resolveTemplate,
  sendMail,
  stripTags,
  verifyConnection,
};

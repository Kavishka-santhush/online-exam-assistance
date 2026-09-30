/**
 * Transactional email templates (React Email).
 *
 * The server has no JSX transpiler, so every template is written with
 * `createElement` (aliased to `h`). Visually they are identical to the JSX
 * versions - `<Heading>x</Heading>` is `h(Heading, null, 'x')`.
 *
 * `mailer.sendMail({ template: 'ExamAssigned' })` resolves the name through the
 * registry at the bottom; each entry takes a plain props object and returns a
 * full document element which `@react-email/render` turns into HTML.
 */

const { createElement: h } = require('react');
const {
  Body, Button, Column, Container, Head, Heading, Hr, Html, Img, Link, Preview, Row, Section, Text,
} = require('@react-email/components');
const env = require('./env');

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  brand: '#4f46e5',
  brandDark: '#3730a3',
  warn: '#b45309',
  ok: '#047857',
  bad: '#b91c1c',
  surface: '#f8fafc',
};

/** Shared shell: preview text, header lockup, content slot, footer. */
function page({ preview, title, heading, accent = COLORS.brand, logoUrl, orgName, children }) {
  return h(
    Html,
    { lang: 'en' },
    h(Head, null, h('title', null, title ?? heading ?? 'Exam Platform')),
    h(
      Body,
      { style: { backgroundColor: COLORS.surface, margin: 0, padding: '24px 0', fontFamily: 'Helvetica, Arial, sans-serif' } },
      preview ? h(Preview, null, preview) : null,
      h(
        Container,
        {
          style: {
            maxWidth: '600px',
            backgroundColor: '#ffffff',
            border: `1px solid ${COLORS.line}`,
            borderRadius: '12px',
            overflow: 'hidden',
          },
        },
        h(
          Section,
          { style: { backgroundColor: accent, padding: '20px 32px' } },
          logoUrl
            ? h(Img, { src: logoUrl, alt: orgName ?? 'organization', width: '140', style: { marginBottom: '8px' } })
            : h(
              Text,
              { style: { color: '#ffffff', fontSize: '13px', fontWeight: 700, letterSpacing: '1px', margin: 0, textTransform: 'uppercase' } },
              orgName ?? 'Exam Platform',
            ),
          heading
            ? h(Heading, { as: 'h1', style: { color: '#ffffff', fontSize: '22px', lineHeight: '28px', margin: '8px 0 0' } }, heading)
            : null,
        ),
        h(Section, { style: { padding: '28px 32px' } }, children),
        h(Hr, { style: { borderColor: COLORS.line, margin: '0' } }),
        h(
          Section,
          { style: { padding: '18px 32px 26px', backgroundColor: COLORS.surface } },
          h(
            Text,
            { style: { color: COLORS.muted, fontSize: '12px', lineHeight: '18px', margin: 0 } },
            `Sent by ${orgName ?? 'Exam Platform'} · ${platformLabel()}`,
          ),
          h(
            Text,
            { style: { color: COLORS.muted, fontSize: '12px', lineHeight: '18px', margin: '6px 0 0' } },
            'You can manage which emails you receive in Notification settings.',
          ),
        ),
      ),
    ),
  );
}

function platformLabel() {
  try {
    return new URL(env.API_BASE_URL).host;
  } catch {
    return 'exam platform';
  }
}

function greeting(userName) {
  return h(Text, { style: paragraph() }, `Hi ${userName || 'there'},`);
}

function paragraph(extra = {}) {
  return { color: COLORS.ink, fontSize: '15px', lineHeight: '24px', margin: '0 0 16px', ...extra };
}

function buttonProps(href, extra = {}) {
  return {
    href,
    style: {
      backgroundColor: COLORS.brand,
      borderRadius: '8px',
      color: '#ffffff',
      display: 'inline-block',
      fontSize: '15px',
      fontWeight: 600,
      lineHeight: '20px',
      padding: '12px 22px',
      textDecoration: 'none',
      ...extra,
    },
  };
}

function callout(text, tone = COLORS.warn) {
  return h(
    Section,
    {
      style: {
        backgroundColor: COLORS.surface,
        borderLeft: `4px solid ${tone}`,
        borderRadius: '6px',
        padding: '12px 16px',
        margin: '0 0 18px',
      },
    },
    h(Text, { style: { color: COLORS.ink, fontSize: '14px', lineHeight: '21px', margin: 0 } }, text),
  );
}

/** Key/value rows: exam title, score, date, seat number, invoice total... */
function facts(rows) {
  return h(
    Section,
    { style: { backgroundColor: COLORS.surface, borderRadius: '8px', padding: '6px 16px', margin: '0 0 18px' } },
    rows.filter(Boolean).map(([label, value], index) => h(
      Row,
      { key: `${label}-${index}`, style: { padding: '8px 0', borderBottom: index === rows.length - 1 ? 'none' : `1px solid ${COLORS.line}` } },
      h(Column, { style: { color: COLORS.muted, fontSize: '13px', width: '45%' } }, label),
      h(Column, { style: { color: COLORS.ink, fontSize: '14px', fontWeight: 600 } }, String(value ?? '-')),
    )),
  );
}

function signature(orgName) {
  return h(
    Text,
    { style: { color: COLORS.muted, fontSize: '13px', lineHeight: '20px', margin: '22px 0 0' } },
    `— ${orgName ?? 'The Exam Platform team'}`,
  );
}

const money = (cents, currency = 'usd') => {
  const amount = Number(cents ?? 0) / 100;
  const symbol = String(currency).toLowerCase() === 'usd' ? '$' : `${String(currency).toUpperCase()} `;
  return `${symbol}${amount.toFixed(2)}`;
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function OrganizationInvite(props) {
  const {
    userName, organizationName, organizationLogoUrl, role = 'CANDIDATE', message, invitedBy, link, expiresAt, resent,
  } = props;
  const roleLabel = String(role).replace(/_/g, ' ').toLowerCase();
  return page({
    preview: `You have been invited to join ${organizationName}`,
    heading: resent ? 'Invitation resent' : 'You are invited',
    logoUrl: organizationLogoUrl,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(
        Text,
        { style: paragraph() },
        `${invitedBy ?? `The administrators of ${organizationName}`} invited you to join as ${roleLabel === 'candidate' ? 'a candidate' : `an organisation ${roleLabel}`}.`,
      ),
      message ? callout(message, COLORS.brand) : null,
      facts([['Organization', organizationName], ['Role', roleLabel], ['Invitation expires', expiresAt ? new Date(expiresAt).toDateString() : 'in 14 days']]),
      link
        ? h(Section, { style: { margin: '0 0 8px' } }, h(Button, buttonProps(link), 'Accept invitation'))
        : null,
      link
        ? h(
          Text,
          { style: { color: COLORS.muted, fontSize: '12px', lineHeight: '18px', margin: '12px 0 0' } },
          'If the button does not work, copy this link into your browser: ',
          h(Link, { href: link, style: { color: COLORS.brandDark } }, link),
        )
        : null,
    ],
  });
}

function ExamAssigned(props) {
  const { userName, examTitle, startsAt, endsAt, durationMinutes, totalMarks, organizationName, organizationLogoUrl, link, instructions } = props;
  return page({
    preview: `New exam available: ${examTitle}`,
    heading: 'A new exam is ready for you',
    logoUrl: organizationLogoUrl,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `${organizationName ?? 'Your instructor'} assigned a new exam to your account.`),
      facts([
        ['Exam', examTitle],
        ['Opens', startsAt ? new Date(startsAt).toLocaleString() : 'now'],
        ['Closes', endsAt ? new Date(endsAt).toLocaleString() : 'no fixed end'],
        ['Duration', durationMinutes ? `${durationMinutes} minutes` : null],
        ['Total marks', totalMarks ?? null],
      ]),
      instructions ? callout(instructions, COLORS.brand) : null,
      link ? h(Section, null, h(Button, buttonProps(link), 'Review the exam')) : null,
      signature(`${organizationName ?? 'Exam Platform'} team`),
    ],
  });
}

function ExamReminder(props) {
  const { userName, examTitle, startsAt, remainingMinutes, link, organizationName, proctored } = props;
  return page({
    preview: `${examTitle} starts soon`,
    heading: 'Your exam starts soon',
    orgName: organizationName,
    children: [
      greeting(userName),
      h(
        Text,
        { style: paragraph() },
        `${examTitle} opens at ${startsAt ? new Date(startsAt).toLocaleString() : 'its scheduled time'}${remainingMinutes ? ` - that is in about ${remainingMinutes} minutes` : ''}.`,
      ),
      proctored ? callout('This exam is proctored. Connect your camera and run the system check before the deadline.', COLORS.warn) : null,
      facts([['Exam', examTitle], ['Starts', startsAt ? new Date(startsAt).toLocaleString() : null], ['Proctored', proctored ? 'yes' : 'no']]),
      link ? h(Section, null, h(Button, buttonProps(link), 'Start the check-in')) : null,
    ],
  });
}

function ResultsReleased(props) {
  const { userName, examTitle, scorePercent, finalScore, totalMarks, gradeLetter, passed, link, organizationName, feedback } = props;
  const tone = passed === false ? COLORS.bad : COLORS.ok;
  return page({
    preview: `Results are out for ${examTitle}`,
    heading: passed === false ? 'Your results are available' : passed ? 'You passed - well done' : 'Your results are available',
    accent: tone,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `The results for ${examTitle} have been released.`),
      facts([
        ['Score', finalScore != null && totalMarks != null ? `${finalScore} / ${totalMarks}` : null],
        ['Percentage', scorePercent != null ? `${scorePercent}%` : null],
        ['Grade', gradeLetter ?? null],
        ['Outcome', passed == null ? null : passed ? 'Pass' : 'Below the pass mark'],
      ]),
      feedback ? callout(feedback, COLORS.brand) : null,
      link ? h(Section, null, h(Button, buttonProps(link), 'See the breakdown')) : null,
    ],
  });
}

function CertificateIssued(props) {
  const { userName, examTitle, certificateNo, candidateName, verifyUrl, pdfUrl, issuedAt, organizationName, organizationLogoUrl, scorePercent } = props;
  return page({
    preview: `Your certificate for ${examTitle} is ready`,
    heading: 'Your certificate is ready',
    accent: COLORS.brandDark,
    logoUrl: organizationLogoUrl,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `Congratulations ${candidateName ?? userName ?? ''}, your verified certificate for ${examTitle} has been issued.`),
      facts([
        ['Certificate', certificateNo],
        ['Issued', issuedAt ? new Date(issuedAt).toDateString() : new Date().toDateString()],
        ['Score', scorePercent != null ? `${scorePercent}%` : null],
      ]),
      h(
        Section,
        { style: { margin: '0 0 6px' } },
        pdfUrl ? h(Button, { ...buttonProps(pdfUrl), style: { ...buttonProps(pdfUrl).style, marginRight: '10px' } }, 'Download PDF') : null,
        verifyUrl ? h(Button, buttonProps(verifyUrl, { backgroundColor: '#ffffff', color: COLORS.brandDark, border: `1px solid ${COLORS.brand}` }), 'Verify online') : null,
      ),
      h(
        Text,
        { style: { color: COLORS.muted, fontSize: '12px', lineHeight: '18px', margin: '14px 0 0' } },
        'Share the verification link with employers - it proves the certificate is authentic without exposing your personal data.',
      ),
    ],
  });
}

function PaymentReceipt(props) {
  const { userName, organizationName, description, amountCents, currency, invoiceNumber, paidAt, link, items } = props;
  return page({
    preview: `Receipt: ${description ?? 'payment received'}`,
    heading: 'Payment received',
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `We received your payment of ${money(amountCents, currency)}${description ? ` for ${description.toLowerCase()}` : ''}.`),
      facts([
        ['Description', description],
        ['Amount', money(amountCents, currency)],
        ['Invoice', invoiceNumber],
        ['Date', paidAt ? new Date(paidAt).toLocaleString() : new Date().toLocaleString()],
      ]),
      Array.isArray(items) && items.length
        ? h(
          Section,
          { style: { marginBottom: '18px' } },
          items.map((item, index) => h(
            Row,
            { key: `${item.label ?? index}` },
            h(Column, { style: { color: COLORS.muted, fontSize: '13px', padding: '3px 0' } }, item.label ?? item.description ?? `Line ${index + 1}`),
            h(Column, { style: { color: COLORS.ink, fontSize: '13px', padding: '3px 0', textAlign: 'right' } }, money(item.amountCents ?? item.amount, currency)),
          )),
        )
        : null,
      link ? h(Section, null, h(Button, buttonProps(link), 'View invoice')) : null,
    ],
  });
}

function PaymentFailed(props) {
  const { userName, organizationName, description, amountCents, currency, reason, link } = props;
  return page({
    preview: 'We could not take your payment',
    heading: 'Payment failed',
    accent: COLORS.bad,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `The payment of ${money(amountCents, currency)}${description ? ` for ${description.toLowerCase()}` : ''} did not go through.`),
      reason ? callout(reason, COLORS.bad) : null,
      link ? h(Section, null, h(Button, buttonProps(link), 'Update payment method')) : null,
      h(Text, { style: { color: COLORS.muted, fontSize: '13px', margin: '16px 0 0' } }, 'Nothing was charged. Access is restored as soon as the payment succeeds.'),
    ],
  });
}

function RegistrationConfirmed(props) {
  const { userName, examTitle, seatNumber, startsAt, link, organizationName, amountCents, currency } = props;
  return page({
    preview: `You are registered for ${examTitle}`,
    heading: 'Registration confirmed',
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, `You are registered for ${examTitle}.`),
      facts([
        ['Exam', examTitle],
        ['Seat', seatNumber ?? null],
        ['Opens', startsAt ? new Date(startsAt).toLocaleString() : null],
        amountCents ? ['Paid', money(amountCents, currency)] : null,
      ]),
      link ? h(Section, null, h(Button, buttonProps(link), 'Go to exam page')) : null,
    ],
  });
}

function SubscriptionWarning(props) {
  const { userName, organizationName, planName, seatsUsed, seatsPurchased, currentPeriodEnd, link, reason } = props;
  return page({
    preview: `${organizationName ?? 'Your organization'} plan needs attention`,
    heading: 'Subscription notice',
    accent: COLORS.warn,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph() }, reason ?? `The ${planName ?? 'current'} plan is close to its limit.`),
      facts([
        ['Plan', planName],
        ['Seats', seatsPurchased ? `${seatsUsed ?? 0} of ${seatsPurchased} used` : null],
        ['Renews', currentPeriodEnd ? new Date(currentPeriodEnd).toDateString() : null],
      ]),
      link ? h(Section, null, h(Button, buttonProps(link), 'Manage billing')) : null,
    ],
  });
}

function Announcement(props) {
  const { userName, title, body, actionUrl, organizationName } = props;
  return page({
    preview: title,
    heading: title,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(
        Text,
        { style: paragraph({ whiteSpace: 'pre-wrap' }) },
        String(body ?? '').replace(/<[^>]+>/g, ''),
      ),
      actionUrl ? h(Section, null, h(Button, buttonProps(actionUrl), 'Read more')) : null,
    ],
  });
}

function ProctorMessage(props) {
  const { userName, examTitle, body, fromName, kind = 'MESSAGE', link } = props;
  return page({
    preview: `Message from your proctor`,
    heading: kind === 'WARNING' ? 'A warning from your proctor' : 'A message from your proctor',
    accent: kind === 'TERMINATE' ? COLORS.bad : kind === 'WARNING' ? COLORS.warn : COLORS.brand,
    children: [
      greeting(userName),
      callout(String(body ?? ''), kind === 'WARNING' ? COLORS.warn : COLORS.brand),
      facts([['Exam', examTitle], ['From', fromName], ['Type', String(kind).toLowerCase()]]),
      link ? h(Section, null, h(Button, buttonProps(link), 'Return to exam')) : null,
    ],
  });
}

function ReportDelivery(props) {
  const { userName, reportTitle, description, periodLabel, organizationName, link, highlights } = props;
  return page({
    preview: reportTitle,
    heading: reportTitle,
    orgName: organizationName,
    children: [
      greeting(userName),
      description ? h(Text, { style: paragraph() }, description) : null,
      facts([['Period', periodLabel]]),
      Array.isArray(highlights) && highlights.length
        ? h(
          Section,
          { style: { marginBottom: '18px' } },
          highlights.map((item, index) => h(
            Text,
            { key: `${item}-${index}`, style: { color: COLORS.ink, fontSize: '14px', lineHeight: '22px', margin: 0 } },
            `•  ${item}`,
          )),
        )
        : null,
      link ? h(Section, null, h(Button, buttonProps(link), 'Open the report')) : null,
    ],
  });
}

function GenericEmail(props) {
  const { userName, title, body, link, linkText = 'Open', organizationName } = props;
  return page({
    preview: title,
    heading: title,
    orgName: organizationName,
    children: [
      greeting(userName),
      h(Text, { style: paragraph({ whiteSpace: 'pre-wrap' }) }, String(body ?? '')),
      link ? h(Section, null, h(Button, buttonProps(link), linkText)) : null,
    ],
  });
}

/** String names accepted by `sendMail({ template })`. */
const TEMPLATES = {
  Announcement,
  CertificateIssued,
  ExamAssigned,
  ExamReminder,
  GenericEmail,
  OrganizationInvite,
  PaymentFailed,
  PaymentReceipt,
  ProctorMessage,
  RegistrationConfirmed,
  ReportDelivery,
  ResultsReleased,
  SubscriptionWarning,
};

/** Resolve a template by name, falling back to the generic layout. */
function resolveTemplate(name) {
  if (typeof name === 'function') return name;
  return TEMPLATES[name] ?? GenericEmail;
}

module.exports = { COLORS, TEMPLATES, money, page, resolveTemplate };

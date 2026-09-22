const nodemailer = require('nodemailer');

// Configured entirely through .env — works with a company mail server,
// Gmail, Outlook, or any standard SMTP provider without any code change,
// only different values in .env:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE (true for port 465, false for 587/STARTTLS)
//   SMTP_USER, SMTP_PASS               — the account authenticating to the server
//   SMTP_FROM_NAME                     — display name fallback (see below)
//   SMTP_ALLOW_ARBITRARY_FROM          — see the note in sendMail()
//   APP_BASE_URL                       — the app's own URL, used to build links in emails
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // not configured — sendMail() below no-ops safely rather than crashing anything
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

// Sends one email. Never throws — a misconfigured or temporarily
// unreachable mail server should never break the actual action (an edit,
// an import, an approval) it's attached to; a failure here is logged and
// swallowed instead. Returns true/false so callers can decide whether to
// also surface something to the user (e.g. still show the in-app
// notification even if the email itself failed).
//
// `fromEmail`/`fromName`, when given, are the staff member who triggered
// this — used so an approval email can genuinely appear to come from the
// person who requested it, not a generic system address. Most company mail
// relays allow authenticating with one privileged account and then sending
// "as" any address in the same domain, which is what makes this possible —
// but not every mail server allows this (some reject it outright, others
// silently rewrite the From address back to the authenticated account). If
// yours doesn't, set SMTP_ALLOW_ARBITRARY_FROM=false in .env to fall back to
// sending from the authenticated SMTP_USER account with just the display
// name changed to the requester's — Reply-To is always set to the real
// requester's address regardless, so a reply reaches the right person
// either way.
async function sendMail({ to, subject, html, fromEmail, fromName }) {
  const t = getTransporter();
  if (!t) {
    console.error('Email not sent — SMTP is not configured (set SMTP_HOST etc. in .env):', subject);
    return false;
  }
  const allowArbitraryFrom = process.env.SMTP_ALLOW_ARBITRARY_FROM !== 'false';
  const from = (fromEmail && allowArbitraryFrom)
    ? `"${fromName || fromEmail}" <${fromEmail}>`
    : `"${fromName || process.env.SMTP_FROM_NAME || 'Salary Slip Register'}" <${process.env.SMTP_USER}>`;

  try {
    await t.sendMail({ from, replyTo: fromEmail || undefined, to, subject, html });
    return true;
  } catch (err) {
    console.error('Failed to send email:', err.message);
    return false;
  }
}

module.exports = { sendMail };

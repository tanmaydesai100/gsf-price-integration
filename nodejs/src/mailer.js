/**
 * Emails a quotation PDF to the customer, from the company's Microsoft 365
 * mailbox. Nothing is sent until one of these is configured in .env.
 *
 * Microsoft Graph (preferred - Microsoft 365 turns SMTP login off by default):
 *
 *   MS_TENANT_ID=...              # Entra app registration, Mail.Send (application)
 *   MS_CLIENT_ID=...
 *   MS_CLIENT_SECRET=...
 *   MAIL_FROM="Auto Assist Group <tanmay@autoassistgroup.com>"   # the mailbox it sends as
 *
 * SMTP (any mail server; on Microsoft 365 only if SMTP AUTH is enabled):
 *
 *   SMTP_HOST=smtp.office365.com
 *   SMTP_PORT=587                 # 465 uses TLS from the start
 *   SMTP_USER=tanmay@autoassistgroup.com
 *   SMTP_PASS=...
 *   MAIL_FROM=...                 # defaults to SMTP_USER
 *
 *   MAIL_BCC=                     # optional, either way: a copy of every quote sent
 *
 * When both are set, Graph is used.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nodemailer from 'nodemailer';

import { GsfError } from './errors.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The banner under the signature; a click opens the website. */
export const BANNER = {
  file: path.join(pkgRoot, 'assets', 'email-banner.png'),
  cid: 'aag-banner',
  link: 'https://autoassistgroup.com/',
};

export class MailNotConfiguredError extends GsfError {}
export class MailSendError extends GsfError {}

export function mailConfig(env = process.env) {
  const port = Number.parseInt(env.SMTP_PORT ?? '587', 10) || 587;
  const from = env.MAIL_FROM || env.SMTP_USER || null;
  const graph =
    env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET
      ? { tenantId: env.MS_TENANT_ID, clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET }
      : null;

  return {
    method: graph ? 'graph' : env.SMTP_HOST ? 'smtp' : null,
    graph,
    host: env.SMTP_HOST || null,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from,
    bcc: env.MAIL_BCC || null,
    env,
  };
}

export const mailReady = (cfg = mailConfig()) => Boolean(cfg.method && cfg.from);

/**
 * Send one quotation. `transport` (a nodemailer transport) and `fetchImpl`
 * are for tests; normally both come from the configuration.
 */
export async function sendQuotation({ quotation, pdf, to, transport = null, fetchImpl = fetch, cfg = mailConfig() }) {
  if (!transport && !mailReady(cfg)) {
    throw new MailNotConfiguredError(
      'Email is not set up yet - add MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MAIL_FROM (Microsoft Graph), ' +
        'or SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM, to .env.',
    );
  }

  const message = compose(quotation, pdf);

  if (!transport && cfg.method === 'graph') return sendWithGraph({ cfg, to, message, fetchImpl });

  const mailer =
    transport ??
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });

  return mailer.sendMail({
    from: cfg.from ?? 'Auto Assist Group <info@autoassistgroup.com>',
    to,
    bcc: cfg.bcc || undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: [
      { filename: message.filename, content: pdf, contentType: 'application/pdf' },
      { filename: 'auto-assist-group.png', content: message.banner, contentType: 'image/png', cid: BANNER.cid },
    ],
  });
}

/**
 * Subject, body and attachments - the same whichever way it is sent. The
 * wording and layout follow the quotation emails Auto Assist Group already
 * sends: greeting, vehicle, the booking line, 14-day validity, then the
 * banner, which links to the website.
 */
export function compose(quotation, pdf) {
  const name = String(quotation.customer?.name ?? '').trim().toUpperCase();
  const vehicle = [String(quotation.vehicle ?? '').trim().toUpperCase(), quotation.registration].filter(Boolean).join(' - ');
  const greeting = name ? `Dear ${name},` : 'Dear Customer,';

  const paragraphs = [
    'We have attached a quote for the work that needs to be carried out on the above vehicle.',
    'If this is something you would like to book in, please contact us on 01634 934 983.',
    'Quotations are only valid for 14 days. If you contact us after this time we will need to requote you.',
    'If you have any questions, please let us know.',
  ];

  const p = (content, extra = '') => `<p style="margin:0 0 16px;${extra}">${content}</p>`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000;max-width:640px;">
${p(escape(greeting))}
${p(`<b><u>Vehicle Details:</u> ${escape(vehicle)}</b>`)}
${paragraphs.map((t) => p(escape(t))).join('\n')}
${p('&nbsp;', 'margin:0;')}
${p('Kind Regards,')}
${p('Auto Assist Group.')}
<a href="${BANNER.link}" target="_blank" style="display:block;text-decoration:none;border:0;">
<img src="cid:${BANNER.cid}" alt="Auto Assist Group - A national service that's local. Visit autoassistgroup.com" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
</a>
</div>
</body></html>`;

  const text = [
    greeting,
    '',
    `Vehicle Details: ${vehicle}`,
    '',
    ...paragraphs.flatMap((t) => [t, '']),
    'Kind Regards,',
    '',
    'Auto Assist Group.',
    BANNER.link,
  ].join('\n');

  return {
    subject: 'Auto Assist Group - Quotation',
    html,
    text,
    filename: `SalesQuotation-${quotation.number}.pdf`,
    pdf,
    banner: bannerImage(),
  };
}

let bannerCache = null;
function bannerImage() {
  bannerCache ??= fs.readFileSync(BANNER.file);
  return bannerCache;
}

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ graph

/** "Auto Assist Group <tanmay@x.com>" -> { name, address }. */
export function parseAddress(value) {
  const text = String(value ?? '').trim();
  const m = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: text };
}

let cachedToken = null;

/** App-only token (client credentials), reused until a minute before it expires. */
async function graphToken(graph, fetchImpl) {
  if (cachedToken && cachedToken.key === graph.clientId && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(graph.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: graph.clientId,
      client_secret: graph.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new MailSendError(`Microsoft sign-in failed: ${body.error_description?.split('\n')[0] ?? body.error ?? res.status}`);
  }

  cachedToken = { key: graph.clientId, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function sendWithGraph({ cfg, to, message, fetchImpl }) {
  const from = parseAddress(cfg.from);
  const token = await graphToken(cfg.graph, fetchImpl);
  const recipients = (list) =>
    String(list ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((address) => ({ emailAddress: { address } }));

  const res = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from.address)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: 'HTML', content: message.html },
        toRecipients: recipients(to),
        ...(cfg.bcc ? { bccRecipients: recipients(cfg.bcc) } : {}),
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: message.filename,
            contentType: 'application/pdf',
            contentBytes: Buffer.from(message.pdf).toString('base64'),
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'auto-assist-group.png',
            contentType: 'image/png',
            contentBytes: message.banner.toString('base64'),
            isInline: true,
            contentId: BANNER.cid,
          },
        ],
      },
      // Keeps a copy in the mailbox's Sent Items, like sending from Outlook.
      saveToSentItems: true,
    }),
  });

  // Graph answers 202 Accepted with no body.
  if (res.status === 202 || res.ok) return { method: 'graph', accepted: [to] };

  const body = await res.json().catch(() => ({}));
  throw new MailSendError(`Microsoft Graph refused the email: ${body.error?.message ?? res.status}`);
}

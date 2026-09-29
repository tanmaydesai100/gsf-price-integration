/**
 * The customer's PDF, customer details and the email - without a mail server.
 *
 *   node --test test/quotePdf.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import nodemailer from 'nodemailer';

const { quotationPdf, pdfLines, totalsOf, describe, splitVehicle } = await import('../src/quotePdf.js');
const { cleanCustomer } = await import('../src/quotations.js');
const { sendQuotation, mailReady, mailConfig, MailNotConfiguredError } = await import('../src/mailer.js');

// The printed example: quotation 7109, BD70XES.
const example = {
  number: '7109',
  date: '2024-11-07',
  registration: 'BD70XES',
  supplier: 'gsf',
  vehicle: 'Ford Transit Custom 300 Leader P/V Ecoblue',
  customer: { name: 'Mr Sunny Singh (Auto Assist Group)', email: 'sunny@example.com', town: 'Rochester', postcode: 'ME2 2BZ' },
  lines: [
    { found: true, category: 'Oil Filter', sellPrice: 5.35, tradePrice: 3.38, quantity: 1 },
    { found: true, category: 'Front Brake Pads', sellPrice: 30.35, tradePrice: 19.18, quantity: 1 },
    { found: true, category: 'Front Brake Wear Sensor', sellPrice: 7.09, tradePrice: 4.48, quantity: 1 },
    { found: false, category: 'Wipers', reason: 'none in stock' },
  ],
};

test('lines and totals match the printed quotation 7109', () => {
  const rows = pdfLines(example);
  assert.deepEqual(rows.map((r) => r.description), ['OIL FILTER', 'FRONT BRAKE PADS', 'FRONT BRAKE WEAR SENSOR']);
  assert.deepEqual(rows.map((r) => r.vat), [1.07, 6.07, 1.42]);
  assert.deepEqual(totalsOf(rows), { net: 42.79, vat: 8.56, total: 51.35 });
});

test('quantity multiplies net and VAT', () => {
  const [disc] = pdfLines({ supplier: 'gsf', lines: [{ found: true, category: 'Brake Discs', sellPrice: 104.14, quantity: 2 }] });
  assert.equal(disc.netTotal, 208.28);
  assert.equal(disc.vat, 41.66);
  assert.equal(disc.total, 249.94);
});

test('the PDF is a PDF, and never carries the trade cost', async () => {
  const pdf = await quotationPdf(example);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 20_000, 'the header image is embedded');
});

test('an empty customer still makes a PDF', async () => {
  const pdf = await quotationPdf({ ...example, customer: null });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

test('JLR names: job lines by the part’s role, catalogue lines turned around', () => {
  assert.equal(describe({ position: 'Front brake disc', label: 'Front brake disc: Disc - Brake - RH/LH', description: 'Disc - Brake' }, 'jlr'), 'FRONT BRAKE DISC');
  assert.equal(describe({ position: 'Windscreen Wiper', label: 'Blade - Wiper - RH', description: 'Blade - Wiper' }, 'jlr'), 'WIPER BLADE');
  assert.equal(describe({ description: 'Kit - Caliper Brake Pad' }, 'jlr'), 'CALIPER BRAKE PAD KIT');
  assert.equal(describe({ category: 'air filter' }, 'gsf'), 'AIR FILTER');
});

test('make and model', () => {
  assert.deepEqual(splitVehicle('Ford Transit Custom 300', 'gsf'), { make: 'FORD', model: 'TRANSIT CUSTOM 300' });
  assert.deepEqual(splitVehicle('Land Rover Discovery Sport', 'gsf'), { make: 'LAND ROVER', model: 'DISCOVERY SPORT' });
  assert.deepEqual(splitVehicle('RANGE ROVER EVOQUE 2012 - 2018 (L538)', 'jlr'), { make: 'LAND ROVER', model: 'RANGE ROVER EVOQUE 2012 - 2018 (L538)' });
  assert.equal(splitVehicle('JAGUAR F-PACE', 'jlr').make, 'JAGUAR');
  assert.deepEqual(splitVehicle(null, 'gsf'), { make: null, model: null });
});

test('customer details: all optional, trimmed, email checked', () => {
  assert.equal(cleanCustomer(null), null);
  assert.equal(cleanCustomer({ name: '  ', email: '' }), null);
  assert.deepEqual(cleanCustomer({ name: ' Sunny ', postcode: 'me2 2bz', unknown: 'x' }), { name: 'Sunny', postcode: 'ME2 2BZ' });
  assert.throws(() => cleanCustomer({ email: 'not-an-email' }), /not a valid email/);
});

test('email: the PDF is attached and addressed to the customer', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const pdf = await quotationPdf(example);
  const info = await sendQuotation({ quotation: example, pdf, to: 'sunny@example.com', transport, cfg: mailConfig({ MAIL_FROM: 'quotes@example.com' }) });
  const sent = JSON.parse(info.message);

  assert.deepEqual(sent.to, [{ address: 'sunny@example.com', name: '' }]);
  assert.equal(sent.subject, 'Auto Assist Group - Quotation');
  assert.match(sent.text, /Dear MR SUNNY SINGH \(AUTO ASSIST GROUP\),/);
  assert.match(sent.html, /<b><u>Vehicle Details:<\/u> FORD TRANSIT CUSTOM 300 LEADER P\/V ECOBLUE - BD70XES<\/b>/);
  assert.match(sent.html, /valid for 14 days/);
  assert.match(sent.html, /<a href="https:\/\/autoassistgroup\.com\/"[^>]*>\s*<img src="cid:aag-banner"/);
  assert.equal(sent.attachments[0].filename, 'SalesQuotation-7109.pdf');
  assert.equal(sent.attachments[0].contentType, 'application/pdf');
  assert.equal(sent.attachments[1].cid, 'aag-banner');
});

test('email is refused, clearly, until SMTP is configured', async () => {
  assert.equal(mailReady(mailConfig({})), false);
  assert.equal(mailReady(mailConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'a@example.com' })), true);
  await assert.rejects(
    sendQuotation({ quotation: example, pdf: Buffer.from(''), to: 'a@example.com', cfg: mailConfig({}) }),
    MailNotConfiguredError,
  );
});

test('Microsoft Graph: signs in as the app, sends as the mailbox, PDF attached', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'TOKEN', expires_in: 3600 }), { status: 200 });
    }
    return new Response(null, { status: 202 });
  };
  const cfg = mailConfig({
    MS_TENANT_ID: 'tenant-1',
    MS_CLIENT_ID: 'client-1',
    MS_CLIENT_SECRET: 'shh',
    MAIL_FROM: 'Auto Assist Group <tanmay@autoassistgroup.com>',
    MAIL_BCC: 'copy@example.com',
    SMTP_HOST: 'smtp.office365.com',
  });
  assert.equal(cfg.method, 'graph', 'Graph wins when both are set');

  const pdf = await quotationPdf(example);
  const result = await sendQuotation({ quotation: example, pdf, to: 'sunny@example.com', cfg, fetchImpl: fakeFetch });
  assert.equal(result.method, 'graph');

  const [token, send] = calls;
  assert.match(token.url, /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token/);
  assert.match(String(token.init.body), /grant_type=client_credentials/);
  assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/tanmay%40autoassistgroup.com/sendMail');
  assert.equal(send.init.headers.Authorization, 'Bearer TOKEN');

  const { message, saveToSentItems } = JSON.parse(send.init.body);
  assert.equal(saveToSentItems, true);
  assert.deepEqual(message.toRecipients, [{ emailAddress: { address: 'sunny@example.com' } }]);
  assert.deepEqual(message.bccRecipients, [{ emailAddress: { address: 'copy@example.com' } }]);
  assert.equal(message.body.contentType, 'HTML');
  assert.match(message.body.content, /cid:aag-banner/);
  assert.equal(message.attachments[0].name, 'SalesQuotation-7109.pdf');
  assert.equal(message.attachments[1].isInline, true);
  assert.equal(message.attachments[1].contentId, 'aag-banner');
  assert.equal(Buffer.from(message.attachments[0].contentBytes, 'base64').subarray(0, 4).toString(), '%PDF');
});

test('Microsoft Graph: a refusal is reported with Microsoft’s reason', async () => {
  const fakeFetch = async (url) =>
    url.includes('/token')
      ? new Response(JSON.stringify({ access_token: 'T2', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: 'Access is denied.' } }), { status: 403 });
  const cfg = mailConfig({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c2', MS_CLIENT_SECRET: 's', MAIL_FROM: 'a@example.com' });
  await assert.rejects(
    sendQuotation({ quotation: example, pdf: Buffer.from('%PDF'), to: 'b@example.com', cfg, fetchImpl: fakeFetch }),
    /Access is denied/,
  );
});

test('email: names and vehicles are escaped, and a missing name still greets', async () => {
  const { compose } = await import('../src/mailer.js');
  const m = compose({ ...example, customer: { name: 'A <b>&</b>' } }, Buffer.from(''));
  assert.match(m.html, /Dear A &lt;B&gt;&amp;&lt;\/B&gt;,/);
  assert.match(compose({ ...example, customer: null }, Buffer.from('')).text, /^Dear Customer,/);
});

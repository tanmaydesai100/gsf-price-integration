/**
 * The customer's copy of a quotation, as a PDF, in the Auto Assist Group
 * layout: fixed header and footer, then the customer, the vehicle and the
 * parts - sell prices only, with VAT. Trade cost never appears here.
 *
 *   const pdf = await quotationPdf(quotation);   // Buffer
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import PDFDocument from 'pdfkit';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The part of the document that is the same on every quotation. */
export const COMPANY = {
  name: 'Auto Assist Group',
  address: '67 Cuxton Road, Strood, Kent, ME2 2BZ',
  vatNumber: '180 157 519',
  companyNumber: '08845192',
  // Logo, address, phone, email and web, exactly as on the printed quotes.
  header: path.join(pkgRoot, 'assets', 'quote-header.png'),
};

export const VAT_RATE = 0.2;

const PAGE = { width: 595.28, height: 841.89 };
const LEFT = 29;
const RIGHT = 566;
const GREY = '#d9d9d9';

// Right edges of the money columns, as on the printed quotes.
const COL = { qty: LEFT + 2, desc: 84, net: 376, netTotal: 437, vat: 499, total: RIGHT };

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `£${Number(n).toFixed(2)}`;

export function quotationPdf(quotation) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Quotation ${quotation.number}`, Author: COMPANY.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, quotation);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function draw(doc, q) {
  const vehicle = splitVehicle(q.vehicle, q.supplier);
  const rows = pdfLines(q);
  let page = 1;

  header(doc);
  customerBlock(doc, q.customer ?? {});
  quoteBox(doc, q, vehicle);

  // "BD70XES , FORD - TRANSIT CUSTOM 300 LEADER P/V ECOBLUE"
  let y = 238;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('black')
    .text(`${q.registration} , ${[vehicle.make, vehicle.model].filter(Boolean).join(' - ')}`, LEFT, y, { width: RIGHT - LEFT });
  y = doc.y + 4;
  rule(doc, y, 1.2);

  y = tableHead(doc, y + 5);
  for (const row of rows) {
    if (y > 730) {
      footer(doc, page++);
      doc.addPage({ size: 'A4', margin: 0 });
      header(doc);
      y = tableHead(doc, 125);
    }
    doc.font('Helvetica').fontSize(9);
    const height = doc.heightOfString(row.description, { width: COL.net - 60 - COL.desc });
    doc.text(row.quantity.toFixed(2), COL.qty, y);
    doc.text(row.description, COL.desc, y, { width: COL.net - 60 - COL.desc });
    right(doc, money(row.net), COL.net, y);
    right(doc, money(row.netTotal), COL.netTotal, y);
    right(doc, money(row.vat), COL.vat, y);
    right(doc, money(row.total), COL.total, y);
    y += Math.max(14, height + 3);
  }

  const totals = totalsOf(rows);
  y += 8;
  doc.font('Helvetica-Bold').fontSize(9.5);
  doc.text('Total', LEFT + 2, y);
  right(doc, money(totals.net), COL.netTotal, y);
  right(doc, money(totals.vat), COL.vat, y);
  right(doc, money(totals.total), COL.total, y);

  y += 22;
  doc.text('Quotation Total', LEFT + 2, y);
  right(doc, money(totals.net), COL.netTotal, y);
  right(doc, money(totals.vat), COL.vat, y);
  right(doc, money(totals.total), COL.total, y);
  rule(doc, y + 16, 1.2);

  footer(doc, page);
}

function header(doc) {
  const width = 320;
  doc.image(COMPANY.header, (PAGE.width - width) / 2, 22, { width });
}

/** Name and address inside corner brackets; only what was given. */
function customerBlock(doc, customer) {
  const top = 125;
  const bottom = 226;
  const x0 = LEFT + 4;
  const x1 = 260;
  const arm = 10;

  doc.lineWidth(1).strokeColor('black');
  doc.moveTo(x0, top + arm).lineTo(x0, top).lineTo(x0 + arm, top).stroke();
  doc.moveTo(x1 - arm, top).lineTo(x1, top).lineTo(x1, top + arm).stroke();
  doc.moveTo(x0, bottom - arm).lineTo(x0, bottom).lineTo(x0 + arm, bottom).stroke();
  doc.moveTo(x1 - arm, bottom).lineTo(x1, bottom).lineTo(x1, bottom - arm).stroke();

  const lines = [customer.name, customer.address1, customer.address2, customer.town, customer.county, customer.postcode]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map((v) => v.toUpperCase());

  doc.font('Helvetica').fontSize(9).fillColor('black');
  let y = top + 12;
  for (const line of lines.slice(0, 7)) {
    doc.text(line, x0 + 8, y, { width: x1 - x0 - 16, lineBreak: false, ellipsis: true });
    y += 10.5;
  }
}

function quoteBox(doc, q, vehicle) {
  const x = 322;
  const width = RIGHT - x;
  const labelX = x + 8;
  const valueX = x + 87;
  const valueWidth = RIGHT - valueX - 6;
  let y = 138;

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('black');
  doc.text('Quotation No.', labelX, y);
  doc.text(q.number, valueX, y);
  y += 20;

  const rows = [
    ['Date', longDate(q.date)],
    ['Account No.', q.customer?.accountNumber],
    ['Make', vehicle.make],
    ['Model', vehicle.model],
    ['Registration', q.registration],
  ].filter(([, value]) => value);

  doc.font('Helvetica').fontSize(9);
  for (const [label, value] of rows) {
    doc.text(label, labelX, y);
    // Wrap at spaces only - "P/V" must not split.
    for (const line of wrap(doc, String(value), valueWidth)) {
      doc.text(line, valueX, y, { lineBreak: false });
      y += 10.5;
    }
    y += 2;
  }

  doc.lineWidth(0.8).rect(x, 130, width, y - 130 + 2).stroke();
}

function tableHead(doc, y) {
  doc.rect(LEFT, y, RIGHT - LEFT, 13).fill(GREY);
  doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
  doc.text('Parts', LEFT + 2, y + 2.5);
  right(doc, 'Net', COL.net, y + 2.5);
  right(doc, 'Net Total', COL.netTotal, y + 2.5);
  right(doc, 'VAT', COL.vat, y + 2.5);
  right(doc, 'Total', COL.total, y + 2.5);
  return y + 17;
}

function footer(doc, page) {
  doc.font('Helvetica').fontSize(8).fillColor('black');
  doc.text(COMPANY.address, 0, 775, { width: PAGE.width, align: 'center' });
  doc.text(`VAT Reg No.: ${COMPANY.vatNumber}   Company Reg No.: ${COMPANY.companyNumber}`, 0, 787, {
    width: PAGE.width,
    align: 'center',
  });
  doc.fontSize(10).text(String(page), RIGHT - 20, 787, { width: 20, align: 'right' });
}

function wrap(doc, text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (current && doc.widthOfString(next) > width) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function right(doc, text, edge, y) {
  const w = doc.widthOfString(text);
  doc.text(text, edge - w, y, { lineBreak: false });
}

function rule(doc, y, width = 1) {
  doc.lineWidth(width).strokeColor('black').moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
}

// ------------------------------------------------------------------ content

/** The priced lines as the customer sees them: quantity, a plain name, net, VAT, total. */
export function pdfLines(q) {
  return (q.lines ?? [])
    .filter((l) => l.found && l.sellPrice != null)
    .map((l) => {
      const quantity = Math.max(1, Number.parseInt(l.quantity ?? 1, 10) || 1);
      const net = round2(l.sellPrice);
      const netTotal = round2(net * quantity);
      const vat = round2(netTotal * VAT_RATE);
      return { quantity, description: describe(l, q.supplier), net, netTotal, vat, total: round2(netTotal + vat) };
    });
}

export function totalsOf(rows) {
  const net = round2(rows.reduce((s, r) => s + r.netTotal, 0));
  const vat = round2(rows.reduce((s, r) => s + r.vat, 0));
  return { net, vat, total: round2(net + vat) };
}

/**
 * A name the customer understands. GSF lines are the category ("Oil
 * Filter"). A JLR job line is the part's role ("Front brake disc"); a JLR
 * catalogue line turns "Filter - Oil" around to "Oil Filter".
 */
export function describe(line, supplier) {
  if (supplier === 'jlr') {
    if (line.position && String(line.label ?? '').startsWith(`${line.position}: `)) return upper(line.position);
    const [noun, ...rest] = String(line.description ?? line.category).split(' - ');
    return upper(rest.length ? `${rest.join(' ')} ${noun}` : noun);
  }
  return upper(line.category);
}

const upper = (s) => String(s ?? '').trim().toUpperCase();

const MAKES = ['LAND ROVER', 'ALFA ROMEO', 'ASTON MARTIN', 'MERCEDES-BENZ', 'MERCEDES BENZ', 'ROLLS ROYCE', 'ROLLS-ROYCE'];

/**
 * "Volkswagen Passat" -> VOLKSWAGEN / PASSAT. JLR describes the catalogue
 * ("RANGE ROVER EVOQUE 2012 - 2018 (L538)"), so the make is Jaguar or Land
 * Rover and the whole description is the model.
 */
export function splitVehicle(description, supplier) {
  const text = upper(description);
  if (!text) return { make: null, model: null };

  if (supplier === 'jlr') return { make: text.startsWith('JAGUAR') ? 'JAGUAR' : 'LAND ROVER', model: text };

  const make = MAKES.find((m) => text.startsWith(`${m} `)) ?? text.split(' ')[0];
  return { make, model: text.slice(make.length).trim() || null };
}

function longDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso ?? '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

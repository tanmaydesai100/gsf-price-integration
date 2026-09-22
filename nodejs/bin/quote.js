#!/usr/bin/env node
/**
 * Quotations from the command line - create, list, show, and build the
 * read-only page that gets shared for review.
 *
 *   node --env-file=.env bin/quote.js new P44PYN --date=2026-09-22 \
 *        --services="Oil Filter,Air Filter,Wipers"
 *
 *   node --env-file=.env bin/quote.js list
 *   node --env-file=.env bin/quote.js show Q-2026-0001
 *   node bin/quote.js export                 # -> build/review.html (no network)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { GsfAuthError, GsfBlockedError, GsfError } from '../src/errors.js';
import {
  createQuotation,
  DEFAULT_BRAND_PRIORITY,
  exportForReview,
  quotations,
} from '../src/quotations.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
GSF quotations

  quote new <reg>               Build and store a quotation
      --date=2026-09-22         Defaults to today
      --services="A,B,C"        Required. Exact GSF category names
      --brands="MANN-FILTER,BOSCH"   Preference, in priority order

  quote list                    All quotations, newest first
  quote show <number>           One quotation in full
  quote export                  Write the read-only review page
      --out=build/review.html
`.trim();

const options = {
  date: { type: 'string' },
  services: { type: 'string' },
  brands: { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

const split = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function cmdNew(args, values) {
  const [reg] = args;
  if (!reg) {
    console.error('A registration is required.');
    return 1;
  }

  const services = split(values.services);
  if (services.length === 0) {
    console.error('Pass --services="Oil Filter,Wipers". Find exact names with: gsf.js categories <search>');
    return 1;
  }

  const brands = values.brands ? split(values.brands) : DEFAULT_BRAND_PRIORITY;
  const date = values.date || new Date().toISOString().slice(0, 10);

  console.log(`Pricing ${services.length} services for ${reg} (${brands.join(' → ')}) ...`);

  const q = await createQuotation({ registration: reg, date, services, brands });

  console.log(`\n${q.number}  ${q.registration}  ${q.vehicle ?? 'vehicle not identified'}`);
  printLines(q);
  return 0;
}

function printLines(q) {
  console.table(
    q.lines.map((l) => ({
      Service: l.category,
      Brand: l.found ? l.brand : '—',
      SKU: l.found ? l.sku : '—',
      Availability: l.found ? l.availability : 'not priced',
      Trade: l.found ? l.tradePrice : null,
      Review: l.needsReview ? 'yes' : '',
    })),
  );
  console.log(
    `Trade cost ex-VAT: £${q.totals.tradeCost.toFixed(2)}` +
      `   (${q.totals.quoted}/${q.totals.services} priced)` +
      (q.needsReview ? '   NEEDS REVIEW' : ''),
  );
}

async function cmdList() {
  const all = await quotations.all();
  if (all.length === 0) {
    console.log('No quotations yet.');
    return 0;
  }

  console.table(
    all.map((q) => ({
      Number: q.number,
      Date: q.date,
      Reg: q.registration,
      Vehicle: q.vehicle ?? '—',
      Lines: q.totals.services,
      Trade: q.totals.tradeCost,
      Review: q.needsReview ? 'yes' : '',
    })),
  );
  return 0;
}

async function cmdShow(args) {
  const [number] = args;
  const q = number ? await quotations.get(number) : null;
  if (!q) {
    console.error(`No quotation "${number}".`);
    return 1;
  }

  console.log(`${q.number}  ${q.registration}  ${q.vehicle ?? '—'}  ${q.date}`);
  printLines(q);
  return 0;
}

/**
 * Bake the quotations into a standalone copy of the UI.
 *
 * The page is the same file the local tool serves; the region between the
 * ARTIFACT markers is what gets published, with the data injected ahead of it.
 * Nothing here touches GSF, so the output carries no session and no account.
 */
async function cmdExport(values) {
  const data = await exportForReview();
  if (data.quotations.length === 0) {
    console.error('Nothing to export - create some quotations first.');
    return 1;
  }

  const source = await fs.readFile(path.join(pkgRoot, 'web', 'index.html'), 'utf8');
  const begin = source.indexOf('<!-- ARTIFACT:BEGIN');
  const end = source.indexOf('<!-- ARTIFACT:END');
  if (begin === -1 || end === -1) {
    throw new GsfError('web/index.html is missing its ARTIFACT markers.');
  }

  const body = source.slice(source.indexOf('-->', begin) + 3, end);

  // JSON inside a <script> must not be able to close it early.
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');

  const out = values.out || path.join('build', 'review.html');
  const target = path.isAbsolute(out) ? out : path.join(pkgRoot, out);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `<script>window.__REVIEW__ = ${payload};</script>\n${body.trim()}\n`);

  console.log(`Wrote ${target}`);
  console.log(`${data.quotations.length} quotations, read-only, no credentials.`);
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'new':
      return cmdNew(rest, values);
    case 'list':
      return cmdList();
    case 'show':
      return cmdShow(rest);
    case 'export':
      return cmdExport(values);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof GsfBlockedError) {
    console.error(`\nBLOCKED: ${error.message}`);
  } else if (error instanceof GsfAuthError) {
    console.error(`\nAUTH FAILED: ${error.message}`);
  } else if (error instanceof GsfError) {
    console.error(`\nGSF ERROR: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

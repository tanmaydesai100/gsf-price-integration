/**
 * Quotation module (V2).
 *
 * V1 answered "what does ONE part cost for ONE vehicle". A quotation is a set
 * of those, priced together, kept, and reopenable.
 *
 *   const q = await createQuotation({ registration: 'P44PYN', date: '2026-09-22',
 *                                     services: ['Oil Filter', 'Wipers'] });
 *
 * THE RULE THAT MATTERS: a quotation is a SNAPSHOT, not a set of references.
 * GSF prices and stock move daily. Every line stores the brand, SKU, price and
 * availability as captured at the moment of quoting, plus the alternatives that
 * were on offer. Reopening a quote shows what we quoted, never what it costs
 * today - and when someone says "wrong part", the alternatives are still there
 * to explain what else was available.
 *
 * Storage is one JSON file per quotation. That is deliberate at this scale: no
 * native dependency, no server, trivially exportable for review. The store is
 * behind a small interface so it can become SQLite or Postgres without the
 * engine changing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cache } from './cache.js';
import { config } from './config.js';
import { GsfError } from './errors.js';
import { GsfPriceService } from './priceService.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const storeDir = () =>
  process.env.GSF_QUOTATIONS_DIR || path.join(pkgRoot, 'data', 'quotations');

/** Default brand preference, in priority order. Override per quotation. */
export const DEFAULT_BRAND_PRIORITY = ['MANN-FILTER', 'BOSCH'];

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------- store

export const quotations = {
  async all() {
    let names;
    try {
      names = await fs.readdir(storeDir());
    } catch {
      return [];
    }

    const loaded = await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => {
          try {
            return JSON.parse(await fs.readFile(path.join(storeDir(), n), 'utf8'));
          } catch {
            return null; // a half-written or hand-edited file must not break the list
          }
        }),
    );

    return loaded.filter(Boolean).sort(byDateDescending);
  },

  async get(number) {
    try {
      return JSON.parse(await fs.readFile(path.join(storeDir(), `${number}.json`), 'utf8'));
    } catch {
      return null;
    }
  },

  async put(quotation) {
    await fs.mkdir(storeDir(), { recursive: true });
    const target = path.join(storeDir(), `${quotation.number}.json`);
    const tmp = `${target}.tmp`;
    // Write-then-rename: a crash mid-write cannot leave a truncated file that
    // still parses as valid JSON.
    await fs.writeFile(tmp, `${JSON.stringify(quotation, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, target);
    return quotation;
  },
};

/** Newest first, by the date the user entered; created-at breaks ties. */
function byDateDescending(a, b) {
  return (
    String(b.date).localeCompare(String(a.date)) ||
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

// ------------------------------------------------------------------ number

/**
 * Q-2026-0001. Sortable, unambiguous, and short enough to quote in an email.
 *
 * Behind the same lock the login uses, so two quotes created at once cannot
 * claim the same number.
 */
async function nextNumber(year) {
  const release = await cache.lock('gsf:quotation-number', 30, 15);
  try {
    const prefix = `Q-${year}-`;
    const existing = (await quotations.all())
      .map((q) => q.number)
      .filter((n) => String(n).startsWith(prefix))
      .map((n) => Number.parseInt(String(n).slice(prefix.length), 10))
      .filter(Number.isFinite);

    const next = (existing.length > 0 ? Math.max(...existing) : 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  } finally {
    await release?.();
  }
}

// ------------------------------------------------------------------ create

/**
 * Price every requested service against one vehicle and store the result.
 *
 * A service that cannot be quoted does NOT fail the quotation - it lands as a
 * line with `found: false` and a reason. A quote that silently dropped the
 * part you asked about would be worse than one that says it could not price it.
 */
export async function createQuotation({
  registration,
  date,
  services,
  brands = DEFAULT_BRAND_PRIORITY,
  fitment = null,
  prefer = null,
  service = null,
} = {}) {
  if (!registration || !String(registration).trim()) {
    throw new GsfError('A registration is required.');
  }
  if (!isDate(date)) {
    throw new GsfError('A date is required, as YYYY-MM-DD.');
  }
  if (!Array.isArray(services) || services.length === 0) {
    throw new GsfError('Pick at least one service.');
  }

  const prices = service ?? new GsfPriceService();
  const lines = [];

  // Sequential, not parallel: these go to a supplier behind a WAF, and a burst
  // of concurrent requests per quotation is exactly the shape that gets an
  // account blocked. A quote is a handful of parts; the wait is acceptable.
  for (const category of services) {
    lines.push(await priceLine(prices, registration, category, brands, fitment, prefer));
  }

  const quoted = lines.filter((l) => l.found);
  const vehicle = lines.find((l) => l.vehicle)?.vehicle ?? null;

  const quotation = {
    number: await nextNumber(String(date).slice(0, 4)),
    registration: String(registration).replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    date,
    createdAt: new Date().toISOString(),

    vehicle,
    vin: lines.find((l) => l.vin)?.vin ?? null,

    brandPriority: [brands].flat().filter(Boolean),
    lines,

    totals: {
      services: lines.length,
      quoted: quoted.length,
      unpriced: lines.length - quoted.length,
      // Our buying cost from GSF, ex-VAT. NOT a sell price. See README.
      tradeCost: round2(quoted.reduce((sum, l) => sum + (l.tradePrice ?? 0), 0)),
      rrp: round2(quoted.reduce((sum, l) => sum + (l.rrp ?? 0), 0)),
    },

    needsReview: lines.some((l) => l.needsReview),
  };

  return quotations.put(quotation);
}

async function priceLine(prices, registration, category, brands, fitment, prefer) {
  try {
    const r = await prices.getPartPrice(registration, category, brands, fitment, prefer);

    if (!r.found) {
      return {
        category,
        found: false,
        reason: r.reason ?? 'Nothing quotable for this vehicle.',
        considered: r.considered ?? 0,
        needsReview: true,
        reviewReason: r.reviewReason ?? null,
      };
    }

    return {
      category,
      found: true,

      brand: r.brand,
      sku: r.sku,
      description: r.description,

      tradePrice: r.tradePrice,
      rrp: r.rrp,
      vatRate: r.vatRate,

      availability: r.availability,
      stock: r.stock,
      fitment: r.fitment,
      fitmentGroup: r.fitmentGroup,

      brandSelected: r.brandSelected ?? null,
      fallbackUsed: r.fallbackUsed,

      needsReview: r.needsReview,
      reviewReason: r.reviewReason,
      unknownAvailability: r.unknownAvailability ?? null,

      // Kept so "why this part?" is answerable later, against the stock that
      // existed at quote time rather than today's.
      alternatives: r.alternatives ?? [],

      vehicle: r.vehicle,
      vin: r.vin,
    };
  } catch (error) {
    // An unknown category, or GSF failing on one part, must not lose the rest
    // of the quotation.
    return {
      category,
      found: false,
      reason: error.message,
      error: error.constructor?.name ?? 'Error',
      needsReview: true,
      reviewReason: 'This line could not be priced - check it manually.',
    };
  }
}

// ------------------------------------------------------------------ export

/**
 * Everything a read-only reviewer needs, and nothing else. This is what gets
 * baked into the page shared outside this machine, so it carries no cookies,
 * no credentials and no account number.
 */
export async function exportForReview() {
  return {
    generatedAt: new Date().toISOString(),
    source: config.baseUrl,
    quotations: await quotations.all(),
  };
}

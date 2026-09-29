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

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());

const CUSTOMER_FIELDS = ['name', 'email', 'phone', 'address1', 'address2', 'town', 'county', 'postcode', 'accountNumber'];

/**
 * Customer details for the quotation PDF. Every field is optional; an email,
 * when given, must look like one, because the PDF is sent to it. Returns
 * null when nothing was given.
 */
export function cleanCustomer(input) {
  if (input == null) return null;
  if (typeof input !== 'object') throw new GsfError('Customer details must be an object.');

  const out = {};
  for (const field of CUSTOMER_FIELDS) {
    const value = String(input[field] ?? '').trim().slice(0, 200);
    if (value) out[field] = value;
  }
  if (out.email && !isEmail(out.email)) throw new GsfError(`"${out.email}" is not a valid email address.`);
  if (out.postcode) out.postcode = out.postcode.toUpperCase();
  return Object.keys(out).length > 0 ? out : null;
}
const round2 = (n) => Math.round(n * 100) / 100;

/** Trade cost plus the markup, rounded once, per unit. */
export const sellPrice = (trade, percent) =>
  trade == null ? null : round2(trade * (1 + percent / 100));

const quantityOf = (line) => Math.max(1, Number.parseInt(line?.quantity ?? 1, 10) || 1);

/**
 * Totals are computed from the lines every time rather than stored and
 * adjusted, so editing a quotation cannot leave the total disagreeing with
 * what is on it.
 */
function totalsFor(lines, markup) {
  const quoted = lines.filter((l) => l.found);

  return {
    services: lines.length,
    quoted: quoted.length,
    unpriced: lines.length - quoted.length,
    items: quoted.reduce((sum, l) => sum + quantityOf(l), 0),

    // What GSF charges us, ex-VAT. Not a sell price.
    tradeCost: round2(quoted.reduce((sum, l) => sum + (l.tradePrice ?? 0) * quantityOf(l), 0)),
    // What the customer is quoted, ex-VAT.
    sell: round2(quoted.reduce((sum, l) => sum + (l.sellPrice ?? 0) * quantityOf(l), 0)),
    rrp: round2(quoted.reduce((sum, l) => sum + (l.rrp ?? 0) * quantityOf(l), 0)),
    markupPercent: markup,
  };
}

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

    return loaded.filter(Boolean).map(normalise).sort(byDateDescending);
  },

  async get(number) {
    try {
      return normalise(
        JSON.parse(await fs.readFile(path.join(storeDir(), `${number}.json`), 'utf8')),
      );
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

/**
 * Quotations written before quantities and markup existed have neither, and
 * rewriting stored files to add them would edit quotes that have already been
 * given out. They are filled in on the way out instead: quantity 1, and a sell
 * price derived from the trade cost that was captured at the time.
 *
 * Totals are always recomputed from the lines, so a stored total can never
 * drift from what the quotation actually contains.
 */
function normalise(quotation) {
  if (!quotation || !Array.isArray(quotation.lines)) return quotation;

  const markupPercent = quotation.markupPercent ?? config.markupPercent;

  const lines = quotation.lines.map((line) => ({
    ...line,
    quantity: Math.max(1, Number.parseInt(line.quantity ?? 1, 10) || 1),
    sellPrice: line.sellPrice ?? (line.found ? sellPrice(line.tradePrice, markupPercent) : null),
  }));

  return {
    ...quotation,
    // Every quotation before JLR was a GSF one.
    supplier: quotation.supplier ?? 'gsf',
    markupPercent,
    lines,
    totals: totalsFor(lines, markupPercent),
    needsReview: lines.some((l) => l.needsReview),
  };
}

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
  // 'gsf' or 'jlr'. Stored on the quotation so an edit re-prices new lines
  // against the same supplier. `service` must be that supplier's price service.
  supplier = 'gsf',
  markupPercent = config.markupPercent,
  customer = null,
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

  // A service is either a bare category name - price the whole category and
  // let the brand rule decide - or { category, group }, one specific fitment
  // the user picked. The picker sends the second; the CLI can send either.
  const who = cleanCustomer(customer);

  const wanted = services.map((entry) =>
    typeof entry === 'string' ? { category: entry, group: null } : entry,
  );

  for (const entry of wanted) {
    if (!entry?.category) throw new GsfError('Every service needs a category.');
  }

  const prices = service ?? new GsfPriceService();
  const lines = [];

  // Sequential, not parallel: these go to a supplier behind a WAF, and a burst
  // of concurrent requests per quotation is exactly the shape that gets an
  // account blocked. A quote is a handful of parts; the wait is acceptable.
  for (const entry of wanted) {
    lines.push(await priceLine(prices, registration, entry, brands, fitment, prefer));
  }

  for (const line of lines) {
    // JLR says how many a vehicle takes (four spark plugs); GSF does not.
    line.quantity = quantityOf({ quantity: line.unitsPerVehicle });
    line.sellPrice = line.found ? sellPrice(line.tradePrice, markupPercent) : null;
  }

  const vehicle = lines.find((l) => l.vehicle)?.vehicle ?? null;

  const quotation = {
    number: await nextNumber(String(date).slice(0, 4)),
    registration: String(registration).replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    date,
    createdAt: new Date().toISOString(),

    vehicle,
    vin: lines.find((l) => l.vin)?.vin ?? null,

    // Optional; only the PDF and the email use it.
    customer: who,

    supplier,
    // Every JLR part is genuine, so a brand order means nothing there.
    brandPriority: supplier === 'gsf' ? [brands].flat().filter(Boolean) : [],
    markupPercent,
    lines,

    totals: totalsFor(lines, markupPercent),

    needsReview: lines.some((l) => l.needsReview),
  };

  return quotations.put(quotation);
}

async function priceLine(prices, registration, entry, brands, fitment, prefer) {
  const { category, group } = entry;

  try {
    // A chosen fitment is priced from the option list, so the line records the
    // exact position and variant the user picked rather than re-deciding.
    if (group) {
      const all = await prices.listOptions(registration, category, brands, prefer);
      const found = all.options.find((o) => o.group === group);

      if (!found) {
        return {
          category,
          group,
          found: false,
          reason: 'That fitment is no longer priced or in stock.',
          needsReview: true,
          reviewReason: 'The option chosen is gone - pick another fitment.',
        };
      }

      return {
        category,
        found: true,

        position: found.position,
        group: found.group,
        label: found.label,

        brand: found.brand,
        sku: found.sku,
        description: found.description,

        tradePrice: found.tradePrice,
        rrp: found.rrp,

        availability: found.availability,
        brandSelected: found.brandSelected,
        fallbackUsed: !found.brandMatched && [brands].flat().filter(Boolean).length > 0,

        // The fitment was chosen deliberately, so there is nothing left to
        // review - that was the whole point of the picker. An option can
        // still carry its own flag (a JLR price in another currency).
        needsReview: Boolean(found.needsReview),
        reviewReason: found.needsReview ? found.reviewReason ?? null : null,

        unitsPerVehicle: found.unitsPerVehicle ?? null,
        alternatives: found.alternatives ?? [],

        // The quotation takes its vehicle from the lines, so this path has to
        // carry it too - listOptions returns it alongside the options.
        vehicle: all.vehicle,
        vin: all.vin,
      };
    }

    const r = await prices.getPartPrice(registration, category, brands, fitment, prefer);

    if (!r.found) {
      return {
        category,
        group: group ?? null,
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

      position: r.fitment ?? null,
      group: r.fitmentGroup ?? null,
      label: null,

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
      unitsPerVehicle: r.unitsPerVehicle ?? null,

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
      group: group ?? null,
      found: false,
      reason: error.message,
      error: error.constructor?.name ?? 'Error',
      needsReview: true,
      reviewReason: 'This line could not be priced - check it manually.',
    };
  }
}

// ------------------------------------------------------------------ update

/**
 * Edit a stored quotation: change quantities, drop lines, add new ones.
 *
 * `lines` is the whole desired set, as { category, group, quantity }. Anything
 * missing from it is removed.
 *
 * A line already on the quotation KEEPS ITS STORED PRICE. Only genuinely new
 * lines are priced, and only they see today's stock. Re-pricing the whole
 * quotation on every edit would silently move the value of a quote already
 * given to a customer, which is the one thing a snapshot exists to prevent.
 */
export async function updateQuotation(number, { lines: wanted, service = null } = {}) {
  const existing = await quotations.get(number);
  if (!existing) throw new GsfError(`No quotation "${number}".`);

  if (!Array.isArray(wanted)) throw new GsfError('lines must be an array.');
  if (wanted.length === 0) throw new GsfError('A quotation needs at least one line.');

  const markupPercent = existing.markupPercent ?? config.markupPercent;
  const keyOf = (line) => `${line.category}\u0000${line.group ?? ''}`;
  const byKey = new Map(existing.lines.map((line) => [keyOf(line), line]));

  const prices = service ?? new GsfPriceService();
  const brands = existing.brandPriority?.length ? existing.brandPriority : DEFAULT_BRAND_PRIORITY;

  const next = [];
  for (const entry of wanted) {
    if (!entry?.category) throw new GsfError('Every line needs a category.');

    const quantity = Math.max(1, Number.parseInt(entry.quantity ?? 1, 10) || 1);
    const kept = byKey.get(keyOf(entry));

    if (kept) {
      next.push({
        ...kept,
        quantity,
        sellPrice: kept.sellPrice ?? (kept.found ? sellPrice(kept.tradePrice, markupPercent) : null),
      });
      continue;
    }

    const priced = await priceLine(prices, existing.registration, entry, brands, null, null);
    priced.quantity = quantity;
    priced.sellPrice = priced.found ? sellPrice(priced.tradePrice, markupPercent) : null;
    next.push(priced);
  }

  return quotations.put({
    ...existing,
    lines: next,
    totals: totalsFor(next, markupPercent),
    needsReview: next.some((l) => l.needsReview),
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- customer

/** Replace a quotation's customer details (the prices are not touched). */
export async function updateCustomer(number, customer) {
  const existing = await quotations.get(number);
  if (!existing) throw new GsfError(`Quotation ${number} not found.`);
  return quotations.put({ ...existing, customer: cleanCustomer(customer), updatedAt: new Date().toISOString() });
}

/** Record that the PDF was emailed, and to whom. */
export async function markEmailed(number, to) {
  const existing = await quotations.get(number);
  if (!existing) throw new GsfError(`Quotation ${number} not found.`);
  const emails = [...(existing.emails ?? []), { to, at: new Date().toISOString() }];
  return quotations.put({ ...existing, emails });
}

// ------------------------------------------------------------------ export

/**
 * Everything a read-only reviewer needs, and nothing else. This is what gets
 * baked into the page shared outside this machine, so it carries no cookies,
 * no credentials and no account number.
 *
 * It also carries NO COST. What GSF charges us is the commercial term behind
 * the margin, and a shared page is the one artefact that can end up in front
 * of a customer - stripping the field is the only way to be sure, since
 * hiding it in the UI still leaves it readable in the page source.
 */
export async function exportForReview({ includeCost = false } = {}) {
  const all = await quotations.all();

  return {
    generatedAt: new Date().toISOString(),
    source: config.baseUrl,
    quotations: includeCost ? all : all.map(withoutCost),
  };
}

function withoutCost(quotation) {
  const { tradeCost, rrp, markupPercent, ...totals } = quotation.totals ?? {};
  // The review build is shared, so no customer's name, address or email.
  const { markupPercent: rate, customer, emails, ...rest } = quotation;

  return {
    ...rest,
    totals,
    lines: (quotation.lines ?? []).map((line) => {
      const { tradePrice, rrp: lineRrp, alternatives, ...kept } = line;
      return {
        ...kept,
        // Brands stay - Chris needs them to judge the part - but not prices.
        alternatives: (alternatives ?? []).map(({ sku, brand }) => ({ sku, brand })),
      };
    }),
  };
}

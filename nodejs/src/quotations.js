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
import { margins } from './margins.js';
import { GsfPriceService } from './priceService.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const storeDir = () =>
  process.env.GSF_QUOTATIONS_DIR || path.join(pkgRoot, 'data', 'quotations');

/** Default brand preference, in priority order. Override per quotation. */
export const DEFAULT_BRAND_PRIORITY = ['MANN-FILTER', 'BOSCH'];

/**
 * How a quotation picks a part: the dearest one that can actually be supplied,
 * ignoring brand and fitment, with a note on the line wherever there was more
 * than one to choose from.
 *
 * Set here rather than read from config, because it is the commercial rule for
 * a quotation - not an operator preference that GSF_PREFER should be able to
 * change out from under it.
 */
export const QUOTATION_STRATEGY = 'highest';

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const round2 = (n) => Math.round(n * 100) / 100;

/** Trade cost plus the markup, rounded once, per unit. */
export const sellPrice = (trade, percent) =>
  trade == null ? null : round2(trade * (1 + percent / 100));

const quantityOf = (line) => Math.max(1, Number.parseInt(line?.quantity ?? 1, 10) || 1);

/**
 * Whether GSF can supply the quantity being quoted.
 *
 * Passing the availability gate only means at least one exists. Quoting three
 * of a part with one unit in the whole company is the failure this catches -
 * and the dearest part, which is what we now quote, is routinely the thinnest
 * stocked.
 */
function stockShortfall(line) {
  const available = line?.stock?.total;
  if (!line?.found || available == null) return null;

  const wanted = quantityOf(line);
  return wanted > available ? { wanted, available } : null;
}

/**
 * A price typed by hand on a quotation.
 *
 * The margin file decides what a part is normally quoted at; this is the
 * override for the job in front of you - matching a competitor, a goodwill
 * discount, a price already promised on the phone.
 *
 * `listPrice` keeps what the margin would have produced, so the line can say
 * it was changed and can be put back.
 *
 *   number  set the price
 *   null    put it back to the calculated one
 *   absent  leave it alone
 */
function applyPriceOverride(line, override) {
  if (override === undefined) return line;

  if (override === null) {
    if (line.listPrice == null) return line;
    return { ...line, sellPrice: line.listPrice, listPrice: null, priceEdited: false };
  }

  const value = Number.parseFloat(override);
  if (!Number.isFinite(value) || value < 0) {
    throw new GsfError('A price must be a number, and not negative.');
  }

  return {
    ...line,
    listPrice: line.listPrice ?? line.sellPrice,
    sellPrice: round2(value),
    priceEdited: true,
  };
}

/**
 * Totals are computed from the lines every time rather than stored and
 * adjusted, so editing a quotation cannot leave the total disagreeing with
 * what is on it.
 */
function totalsFor(lines) {
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

  const lines = quotation.lines.map((line) => {
    // A line's own rate first; then the single rate older quotations stored
    // for the whole document; then the configured default.
    const percent = line.marginPercent ?? quotation.markupPercent ?? config.markupPercent;

    return {
      ...line,
      quantity: Math.max(1, Number.parseInt(line.quantity ?? 1, 10) || 1),
      marginPercent: percent,
      // A hand-set price wins over the margin, always.
      sellPrice: line.sellPrice ?? (line.found ? sellPrice(line.tradePrice, percent) : null),
      priceEdited: Boolean(line.priceEdited),
      stockShortfall: stockShortfall({ ...line, quantity: line.quantity ?? 1 }),
    };
  });

  return {
    ...quotation,
    lines,
    totals: totalsFor(lines),
    needsReview: lines.some((l) => l.needsReview || l.stockShortfall),
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
  prefer = QUOTATION_STRATEGY,
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

  // A service is either a bare category name - price the whole category and
  // let the brand rule decide - or { category, group }, one specific fitment
  // the user picked. The picker sends the second; the CLI can send either.
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

  // The rate comes from data/margins.json per category, and is STORED ON THE
  // LINE. Editing the file later cannot move a quotation already given out.
  for (const line of lines) {
    const percent = await margins.forCategory(line.category);
    line.quantity = 1;
    line.marginPercent = percent;
    line.sellPrice = line.found ? sellPrice(line.tradePrice, percent) : null;
    line.stockShortfall = stockShortfall(line);
  }

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

    totals: totalsFor(lines),

    needsReview: lines.some((l) => l.needsReview || l.stockShortfall),
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
        // review - that was the whole point of the picker.
        needsReview: false,
        reviewReason: null,

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

      brandSelected: r.brandSelected ?? null,
      fallbackUsed: r.fallbackUsed,

      // How many parts were on offer - the parts controller wants the count,
      // not just that there was more than one.
      choices: r.choices ?? null,

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
      const line = applyPriceOverride({ ...kept, quantity }, entry.sellPrice);
      line.stockShortfall = stockShortfall(line);
      next.push(line);
      continue;
    }

    const priced = await priceLine(prices, existing.registration, entry, brands, null, QUOTATION_STRATEGY);
    const percent = await margins.forCategory(priced.category);

    priced.quantity = quantity;
    priced.marginPercent = percent;
    priced.sellPrice = priced.found ? sellPrice(priced.tradePrice, percent) : null;
    const adjusted = applyPriceOverride(priced, entry.sellPrice);
    adjusted.stockShortfall = stockShortfall(adjusted);
    next.push(adjusted);
  }

  return quotations.put({
    ...existing,
    lines: next,
    totals: totalsFor(next),
    needsReview: next.some((l) => l.needsReview || l.stockShortfall),
    updatedAt: new Date().toISOString(),
  });
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
  const { tradeCost, rrp, ...totals } = quotation.totals ?? {};
  const { markupPercent: rate, ...rest } = quotation;

  return {
    ...rest,
    totals,
    lines: (quotation.lines ?? []).map((line) => {
      const { tradePrice, rrp: lineRrp, marginPercent, listPrice, alternatives, ...kept } = line;
      return {
        ...kept,
        // Brands stay - Chris needs them to judge the part - but not prices.
        alternatives: (alternatives ?? []).map(({ sku, brand }) => ({ sku, brand })),
      };
    }),
  };
}

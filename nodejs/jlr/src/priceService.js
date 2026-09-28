/**
 * JLR counterpart to src/priceService.js. Same two public calls, same result
 * shapes, so the quotation module and the picker can use either supplier:
 *
 *   await prices.listOptions('WL61RZO', 'Oil Filter');   // picker
 *   await prices.getPartPrice('WL61RZO', 'Oil Filter');  // bare service line
 *
 * What differs from GSF, and why the selection is simpler:
 *
 *   brand         every part is JLR genuine - there is no brand to prefer
 *   availability  the EPC shows no stock, so there is nothing to rank on
 *   fitment       one catalogue page lists every variant for the model; JLR
 *                 filters it to the VIN when `filter: true`, and anything it
 *                 still marks not-applicable is dropped here
 *
 * Read-only throughout: a registration lookup, a cached tree, one parts call
 * per matching page.
 */

import { cache } from './cache.js';
import { JlrCatalogue, normaliseRegistration } from './catalogue.js';
import { JlrClient } from './client.js';
import { config } from './config.js';
import { describes, JlrHierarchy } from './hierarchy.js';
import { JlrJobs } from './jobs.js';

export const JLR_BRAND = 'JLR Genuine';

export class JlrPriceService {
  constructor(catalogue = new JlrCatalogue(new JlrClient()), hierarchy = null) {
    this.catalogue = catalogue;
    this.hierarchy = hierarchy ?? new JlrHierarchy(catalogue);
  }

  /** Registration or VIN -> { registration, vin, catalogueId, description }. */
  async vehicle(input) {
    const value = normaliseRegistration(input);
    return cache.remember(`jlr:vehicle:${value}`, config.cache.vehicleTtl, () =>
      this.catalogue.decodeVehicle(value),
    );
  }

  /** Pages in this vehicle's catalogue matching a search. For the picker. */
  async searchPages(input, query, limit = 40) {
    const vehicle = await this.vehicle(input);
    return { vehicle, pages: await this.hierarchy.search(vehicle, query, limit) };
  }

  /** The fixed job list (jlr/data/jobs.json), priced by callout base. */
  get jobs() {
    this._jobs ??= new JlrJobs(this);
    return this._jobs;
  }

  /** Every option for a service on this vehicle, each priced. */
  async listOptions(input, category) {
    // A job ("Front brake pads & discs") is priced from its base numbers. Its
    // options are the parts it needs, plus any alternatives staff can swap in.
    const job = this.jobs.find(category);
    if (job) return jobOptions(await this.jobs.price(input, job.key), category);

    const vehicle = await this.vehicle(input);
    const { exact, pages } = await this.hierarchy.resolve(vehicle, category);

    // An exact page label means the user chose that page: every part on it is
    // an option. A service name only shortlisted pages, so keep just the parts
    // whose own description answers it - "Filter - Oil", not the oil cooler
    // on the same page. Nothing answering it means not found, never "show
    // everything on a page that happened to mention a word".
    const results = [];
    // Sequential, like GSF: a handful of calls, not a burst.
    for (const p of pages) {
      const { parts } = await this.pageParts(vehicle, p.id);
      results.push({ page: p, parts: exact ? parts : parts.filter((part) => describes(part.description, category, p.label)) });
    }

    return {
      supplier: 'jlr',
      registration: vehicle.registration,
      vehicle: vehicle.description,
      vin: vehicle.vin,
      category,
      pages: pages.map((p) => p.label),
      ...options(results),
    };
  }

  /**
   * One pick for a bare service. With more than one candidate the catalogue
   * cannot say which the customer needs, so the first is taken and the line
   * is flagged for review, as GSF does with several fitment groups.
   */
  async getPartPrice(input, category) {
    const found = await this.listOptions(input, category);
    return select(found);
  }

  /** Every part on the matching pages, unfiltered. For the CLI. */
  async listParts(input, category) {
    const vehicle = await this.vehicle(input);
    const { pages } = await this.hierarchy.resolve(vehicle, category);
    const rows = [];
    for (const p of pages) {
      for (const part of (await this.pageParts(vehicle, p.id)).parts) rows.push({ page: p.label, ...part });
    }
    return rows;
  }

  async pageParts(vehicle, catalogueId) {
    return cache.remember(`jlr:parts:${vehicle.vin}:${catalogueId}`, config.cache.partsTtl, () =>
      this.catalogue.parts({ catalogueId, vin: vehicle.vin }),
    );
  }
}

// ---------------------------------------------------------------- options

/** Parts JLR will price for this vehicle: priced, and not marked inapplicable. */
export function quotable(parts) {
  return parts.filter((p) => p.partNumber && p.applicable !== false && p.unitPrice != null && p.unitPrice > 0);
}

/**
 * [{ page, parts }] -> { positions, options } in the GSF option shape.
 *
 * group is the JLR part number: it identifies exactly what was picked, and it
 * is stable, so a quotation line can be re-found later by it.
 */
export function options(results) {
  const byPart = new Map();

  for (const { page, parts } of results) {
    for (const part of quotable(parts)) {
      // The same part number can appear on two pages or two callouts. It is
      // one thing to buy, so it is one option.
      if (byPart.has(part.partNumber)) continue;
      byPart.set(part.partNumber, { page, part });
    }
  }

  const list = [...byPart.values()].map(({ page, part }) => {
    const detail = [...part.features, ...part.comments].map(text).filter(Boolean);
    const foreign = part.currency && part.currency !== 'GBP';

    return {
      position: pageTitle(page.name),
      group: part.partNumber,
      label: [part.description || page.name, ...detail].join(' - '),
      page: page.label,
      callout: part.callout,

      brand: JLR_BRAND,
      sku: part.partNumber,
      description: part.description,

      tradePrice: part.unitPrice,
      rrp: null,
      currency: part.currency,
      availability: null,

      // How many the vehicle takes, per the catalogue - four spark plugs, one
      // oil filter. Used as the starting quantity on a quotation line.
      unitsPerVehicle: part.quantity,

      candidates: 1,
      brandMatched: true,
      brandSelected: JLR_BRAND,
      alternatives: [],

      needsReview: Boolean(foreign),
      reviewReason: foreign ? `Priced in ${part.currency}, not GBP.` : null,
    };
  });

  list.sort(
    (a, b) =>
      String(a.position).localeCompare(String(b.position)) ||
      calloutOrder(a.callout) - calloutOrder(b.callout) ||
      a.tradePrice - b.tradePrice,
  );

  return { positions: [...new Set(list.map((o) => o.position))], options: list };
}

/**
 * A priced job -> listOptions shape. One option per part, group = JLR part
 * number, so a quotation line stores exactly which part and can be re-priced
 * later by it. Alternatives are options too, marked so the picker leaves
 * them unticked.
 */
export function jobOptions(priced, category) {
  const list = priced.lines.flatMap((l) =>
    [...l.parts.map((p) => [p, false]), ...l.alternatives.map((p) => [p, true])].map(([p, alternative]) => ({
      position: l.name,
      group: p.partNumber,
      label: [`${l.name}: ${p.description}`, p.notes].filter(Boolean).join(' - '),
      page: p.page,
      callout: p.callout,
      base: l.base,

      brand: JLR_BRAND,
      sku: p.partNumber,
      description: p.description,

      tradePrice: p.unitPrice,
      rrp: null,
      currency: 'GBP',
      availability: null,
      unitsPerVehicle: p.quantity,

      candidates: 1,
      brandMatched: true,
      brandSelected: JLR_BRAND,
      alternatives: [],

      alternative,
      rule: l.rule,
      needsReview: l.status === 'review' && !alternative,
      reviewReason: l.status === 'review' && !alternative ? l.reason : null,
    })),
  );

  return {
    supplier: 'jlr',
    registration: priced.registration,
    vehicle: priced.vehicle,
    vin: priced.vin,
    category,
    job: priced.job,
    pages: [...new Set(priced.lines.flatMap((l) => l.pages))],
    positions: [...new Set(list.map((o) => o.position))],
    options: list,
    // Parts the job needs that this vehicle has no page or part for.
    unpriced: priced.lines
      .filter((l) => l.parts.length === 0)
      .map((l) => ({ name: l.name, base: l.base, status: l.status, reason: l.reason })),
  };
}

/** A listOptions result -> one pick, in the GSF getPartPrice shape. */
export function select(found) {
  const [chosen, ...rest] = found.options;

  if (!chosen) {
    return {
      found: false,
      supplier: 'jlr',
      registration: found.registration,
      vehicle: found.vehicle,
      vin: found.vin,
      category: found.category,
      reason:
        found.pages.length === 0
          ? 'No JLR catalogue page matches this service for this vehicle.'
          : `No priced, applicable JLR part matching "${found.category}" on the ${found.pages.length} likely catalogue pages.`,
      considered: found.pages.length,
      needsReview: true,
      reviewReason: 'Nothing quotable was returned - check the JLR catalogue manually.',
    };
  }

  const several = rest.length > 0;

  return {
    found: true,
    supplier: 'jlr',
    registration: found.registration,
    vehicle: found.vehicle,
    vin: found.vin,
    category: found.category,

    brand: chosen.brand,
    sku: chosen.sku,
    description: chosen.label,

    tradePrice: chosen.tradePrice,
    rrp: null,
    vatRate: null,

    inStock: null,
    availability: null,
    stock: null,

    fitment: chosen.position,
    fitmentGroup: chosen.group,
    unitsPerVehicle: chosen.unitsPerVehicle,

    brandSelected: chosen.brand,
    fallbackUsed: false,
    unknownAvailability: null,

    needsReview: several || chosen.needsReview,
    reviewReason: several
      ? `${found.options.length} JLR parts match "${found.category}" - pick the right one in the picker.`
      : chosen.reviewReason,

    alternatives: rest.map((o) => ({ sku: o.sku, brand: o.label, tradePrice: o.tradePrice, availability: null })),
  };
}

/** "05A Front Brake Discs And Calipers (Halewood (UK))" -> without the "05A" section code. */
function pageTitle(name) {
  return String(name ?? '').replace(/^[0-9]{2,4}[A-Z]?\s+/, '');
}

/** Feature and comment entries are strings, or objects with a description. */
function text(entry) {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.description ?? entry?.desc ?? entry?.featureDesc ?? entry?.comment ?? '').trim();
}

/** Callouts are diagram numbers ("3", "12A"); order them as numbers. */
function calloutOrder(callout) {
  const n = Number.parseInt(String(callout ?? ''), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

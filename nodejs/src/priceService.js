/**
 * The public face of the integration.
 * Mirrors laravel/app/Services/Gsf/GsfPriceService.php.
 *
 *   await new GsfPriceService().getPartPrice('P44PYN', 'Wipers', 'BOSCH');
 *
 * Read-only throughout: one optional vehicle lookup and one parts GET.
 */

import { cache } from './cache.js';
import { GsfCategoryMap } from './categories.js';
import { GsfClient } from './client.js';
import { config } from './config.js';
import { GsfError } from './errors.js';

/**
 * Sooner is better.
 *
 * GSF's availability vocabulary is larger than their docs suggest and it
 * changes: GroupTomorrow and HubAfternoon were both discovered in live data
 * after the fact, and both were being buried. An unlisted value therefore
 * sorts MID-TABLE rather than last - in both real cases the unknown value was
 * faster than Group72Hours, so burying it picked the wrong part - and the
 * result carries `unknownAvailability` so a new value is visible instead of
 * silently mis-ranked.
 */
const AVAILABILITY_RANK = {
  Immediate: 0, // on the shelf at our branch
  HubAfternoon: 1, // later today from a regional hub
  HubTomorrow: 2, // next day from a regional hub
  GroupTomorrow: 3, // next day from the wider group
  Group72Hours: 5, // ~3 days from the wider group
};

/** Between GroupTomorrow and Group72Hours. See the note above. */
const UNKNOWN_AVAILABILITY_RANK = 4;

/**
 * Units GSF can actually supply, across every location.
 *
 * NOT from `isOutOfStock`: that field is false even on parts whose
 * `availability` reads "OutOfStock", so it cannot be trusted. The availability
 * string is the authoritative signal and is stricter than the raw counts - GSF
 * blocks some parts that still show hub stock - so it stays the gate, and this
 * is only used to check a quantity can be met.
 */
export function stockTotal(part) {
  return (
    (part.localStock ?? 0) +
    (part.hubStock ?? 0) +
    (part.rdcStock ?? 0) +
    (part.companyStock ?? 0) +
    (part.imprestStock ?? 0)
  );
}

const normaliseReg = (reg) => String(reg).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export class GsfPriceService {
  constructor(client = new GsfClient(), categories = null) {
    this.client = client;
    this.categories = categories ?? new GsfCategoryMap(client);
  }

  /**
   * @param {string}  reg       e.g. "P44PYN"
   * @param {string}  category  e.g. "Wipers"
   * @param {?string} brand     e.g. "BOSCH" - preference, not a filter
   * @param {?string} fitment   catalogue fitment label, or null for all.
   *                            The vocabulary varies by category: Front/Rear
   *                            for wipers, "Front Axle"/"Rear Axle" for
   *                            brakes, "N/A" for filters. Null is safest.
   * @param {?string} prefer    "availability" (default) or "price"
   */
  async getPartPrice(reg, category, brand = null, fitment = null, prefer = null) {
    const registration = normaliseReg(reg);
    const componentId = await this.categories.componentId(category);
    const payload = await this.#fetch(registration, category, componentId);

    return select(payload, brand, fitment, prefer ?? config.prefer);
  }

  /**
   * Every fitment this vehicle offers in one category, each with its best
   * part. This is what the picker shows before a line joins a quotation.
   */
  async listOptions(reg, category, brand = null, prefer = null) {
    const registration = normaliseReg(reg);
    const componentId = await this.categories.componentId(category);
    const payload = await this.#fetch(registration, category, componentId);

    return { category, ...options(payload, brand, prefer ?? config.prefer) };
  }

  /** Every candidate for the vehicle - useful for an admin/debug screen. */
  async listParts(reg, category, fitment = null) {
    const registration = normaliseReg(reg);
    const componentId = await this.categories.componentId(category);
    const payload = await this.#fetch(registration, category, componentId);

    let parts = payload?.partData?.parts ?? [];
    if (fitment) parts = parts.filter((p) => p.fitment === fitment);

    return parts.map((p) => ({
      sku: p.sku ?? null,
      brand: p.brand ?? null,
      description: p.description ?? null,
      fitment: p.fitment ?? null,
      fitmentGroup: p.groupedPartNumber ?? null,
      tradePrice: p.customerPrice ?? null,
      rrp: p.retailPrice ?? null,
      availability: p.availability ?? null,
      quality: p.quality ?? null,
    }));
  }

  // --------------------------------------------------------------- fetching

  async #fetch(reg, category, componentId) {
    const ttl = config.cache.partsTtl;
    const key = `gsf:parts:${reg}:${componentId}`;

    const call = async () => {
      // 1. Resolve the registration.
      //
      //    An unknown registration does NOT come back as an error: GSF answers
      //    HTTP 200 with a body of literally `null`. Carrying on regardless
      //    then makes /parts/api/parts return a 500, which reads like their
      //    server is broken when the real problem is the registration. So the
      //    body is checked, not just the status.
      //
      //    A transport failure stays non-fatal - the vrm request header alone
      //    has been enough for vehicles already in the account's history.
      // undefined means the call never completed; null means GSF answered
      // and said it does not know this registration. They need different
      // handling, so they must stay distinguishable.
      let identified;
      try {
        identified = (await this.client.postJson('/vrm/api', { vrm: reg })).json();
      } catch (error) {
        console.error(`gsf: /vrm/api failed (continuing): ${error.message}`);
      }

      if (identified !== undefined && identified?.statusCode !== 'Ok') {
        throw new GsfError(
          `GSF does not recognise the registration "${reg}". Check the registration, ` +
            'or look the vehicle up on TradeHub directly to confirm it is in their data.',
        );
      }

      // 2. Parts, pricing and stock.
      const response = await this.client.get(
        '/parts/api/parts',
        {
          partType: category, // display label; must be present
          componentId, // the actual selector
        },
        {
          customerAccount: await this.client.accountNo(),
          vrm: reg,
          'Cache-Control': 'no-store',
        },
      );

      return response.json();
    };

    // NOTE: this payload contains STOCK LEVELS. Whatever you cache is stock as
    // of that moment. GSF_PARTS_TTL=0 disables caching entirely.
    return ttl > 0 ? cache.remember(key, ttl, call) : call();
  }
}

// -------------------------------------------------------------- selection

export function select(payload, brand, fitment, prefer) {
  const parts = payload?.partData?.parts ?? [];
  const rows = fitment ? parts.filter((p) => p.fitment === fitment) : parts;

  // A null customerPrice means GSF will not sell it to us at all.
  const inStock = quotable(rows);

  const vehicle = payload?.vehicle ?? {};

  if (inStock.length === 0) {
    return {
      found: false,
      registration: vehicle.vrm ?? null,
      category: payload?.partTypeDecoded ?? null,
      reason: 'No priced, in-stock part for this vehicle and fitment.',
      considered: rows.length,
      needsReview: true,
      reviewReason: 'Nothing quotable was returned - check manually before pricing.',
    };
  }

  // Distinct fitment groups = distinct physical SIZES. More than one and the
  // catalogue cannot tell us which fits: that is a human decision.
  const groups = [...new Set(inStock.map((p) => p.groupedPartNumber ?? ''))];

  // Under 'highest' we do not separate positions or sizes at all, so the thing
  // worth saying is simply that a choice existed - the parts controller checks
  // which one the vehicle actually needs.
  const needsReview = prefer === 'highest' ? inStock.length > 1 : groups.length > 1;

  inStock.sort(sorter(prefer));

  // `brand` is a preference in PRIORITY ORDER: try MANN-FILTER, then BOSCH,
  // then fall back to whatever is soonest. The first brand with anything
  // quotable wins outright - we do not compare across brands on price.
  //
  // 'highest' ignores brand entirely: the point is to quote the dearest part
  // that fits, whoever makes it.
  const wanted = prefer === 'highest' || brand == null ? [] : [brand].flat().filter(Boolean);
  let preferred = [];
  let matchedBrand = null;

  for (const candidate of wanted) {
    const hits = inStock.filter(
      (p) => String(p.brand ?? '').toUpperCase() === String(candidate).toUpperCase(),
    );
    if (hits.length > 0) {
      preferred = hits;
      matchedBrand = candidate;
      break;
    }
  }

  const chosen = preferred[0] ?? inStock[0];

  // Surface any availability value we do not rank, so a new one shows up as a
  // flag on the quote instead of quietly changing which part gets picked.
  const unknownAvailability = [
    ...new Set(
      inStock.map((p) => p.availability).filter((a) => a && !(a in AVAILABILITY_RANK)),
    ),
  ];

  const alternatives = inStock
    .filter((p) =>
      prefer === 'highest'
        ? p.sku !== chosen.sku
        : (p.groupedPartNumber ?? '') === (chosen.groupedPartNumber ?? '') && p.sku !== chosen.sku,
    )
    .map((p) => ({
      sku: p.sku,
      brand: p.brand ?? null,
      tradePrice: p.customerPrice,
      availability: p.availability ?? null,
    }));

  return {
    found: true,
    registration: vehicle.vrm ?? null,
    vin: vehicle.vin ?? null,
    vehicle: `${vehicle.make ?? ''} ${vehicle.model ?? ''}`.trim() || null,
    category: payload?.partTypeDecoded ?? null,
    componentId: chosen.componentId ?? null,

    brand: chosen.brand ?? null,
    sku: chosen.sku ?? null,
    description: chosen.description ?? null,

    tradePrice: chosen.customerPrice ?? null, // our cost, EX-VAT
    rrp: chosen.retailPrice ?? null,
    vatRate: chosen.taxRate ?? null,

    inStock: true,
    availability: chosen.availability ?? null,
    stock: {
      local: chosen.localStock ?? null,
      hub: chosen.hubStock ?? null,
      rdc: chosen.rdcStock ?? null,
      company: chosen.companyStock ?? null,
      total: stockTotal(chosen),
    },

    fitment: chosen.fitment ?? null,
    fitmentGroup: chosen.groupedPartNumber ?? null,

    strategy: prefer,
    brandRequested: wanted.length > 0 ? wanted : null,
    brandMatched: preferred.length > 0,
    brandSelected: matchedBrand, // which entry of the priority list won
    fallbackUsed: wanted.length > 0 && preferred.length === 0,
    unknownAvailability: unknownAvailability.length > 0 ? unknownAvailability : null,

    choices: inStock.length,

    needsReview,
    reviewReason: !needsReview
      ? null
      : prefer === 'highest'
        ? `There is a choice of more than one part that fits this model - ${inStock.length} ` +
          `options across ${groups.length} ${groups.length === 1 ? 'fitment' : 'fitments'}. ` +
          'The dearest has been quoted; please confirm which one this vehicle needs.'
        : `${groups.length} distinct ${String(fitment || 'compatible').toLowerCase()} fitment groups ` +
          'returned - the correct size cannot be determined from the catalogue data.',

    alternatives,
  };
}

// ---------------------------------------------------------------- options

/**
 * Every distinct fitment a vehicle offers in one category, each with its best
 * part - rather than one pick and a "could not decide" flag.
 *
 * There are three dimensions in a parts payload, and the old needsReview flag
 * mashed them together:
 *
 *   position   Front / Rear, Front Axle / Rear Axle, "Inner Front LH/RH"
 *              - a real choice, carried by `fitment`
 *   variant    within one position, `groupedPartNumber` separates genuine
 *              specification differences, NOT just sizes: on P44PYN the front
 *              wiper splits into plain flat blade, heated spray and water
 *              spray, which depend on the car's washer equipment
 *   brand      decided by the priority list, inside one variant
 *
 * GSF cannot resolve the variant for us - isBestMatch is false on every part
 * and bestMatchScore is null - so we surface the variants and a human picks.
 *
 * @returns {Array} one entry per position x variant, best-first within position
 */
export function options(payload, brand, prefer) {
  const parts = payload?.partData?.parts ?? [];
  const inStock = quotable(parts);
  const vehicle = payload?.vehicle ?? {};

  const groups = new Map();
  for (const part of inStock) {
    // Position and variant together identify one real choice. Missing values
    // still form a group of their own rather than being dropped.
    const key = `${part.fitment ?? ''}\u0000${part.groupedPartNumber ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }

  const sort = sorter(prefer ?? config.prefer);

  const picked = [...groups.values()].map((members) => {
    members.sort(sort);
    return { members, ...pickFrom(members, brand) };
  });

  const shared = sharedProductName(picked.map((p) => p.chosen));

  const list = picked.map(({ members, chosen, matchedBrand, preferred }) => {
    return {
      position: chosen.fitment ?? null,
      group: chosen.groupedPartNumber ?? null,
      label: optionLabel(chosen, shared),
      description: chosen.description ?? null,

      brand: chosen.brand ?? null,
      sku: chosen.sku ?? null,
      tradePrice: chosen.customerPrice ?? null,
      rrp: chosen.retailPrice ?? null,
      availability: chosen.availability ?? null,

      brandSelected: matchedBrand,
      brandMatched: preferred.length > 0,

      candidates: members.length,
      alternatives: members
        .filter((p) => p.sku !== chosen.sku)
        .map((p) => ({
          sku: p.sku,
          brand: p.brand ?? null,
          tradePrice: p.customerPrice,
          availability: p.availability ?? null,
        })),
    };
  });

  // Group the positions together, and inside a position put the best option
  // first, so the obvious choice is at the top of each heading.
  list.sort(
    (a, b) =>
      String(a.position ?? '').localeCompare(String(b.position ?? '')) ||
      sort(
        { availability: a.availability, customerPrice: a.tradePrice },
        { availability: b.availability, customerPrice: b.tradePrice },
      ),
  );

  return {
    registration: vehicle.vrm ?? null,
    vehicle: `${vehicle.make ?? ''} ${vehicle.model ?? ''}`.trim() || null,
    vin: vehicle.vin ?? null,
    category: payload?.partTypeDecoded ?? null,
    positions: [...new Set(list.map((o) => o.position))],
    options: list,
  };
}

/**
 * The position alone does not identify an option - all five front wiper
 * variants on P44PYN read "Front". The description is the only field that
 * separates them, so the label is the position plus whatever the description
 * adds beyond it.
 *
 *   "Wiper Blade - Front; 550mm (22in) / 530mm (21in) - Pair", fitment Front
 *   -> "Front - 550mm (22in) / 530mm (21in) - Pair"
 *
 * partType and genArtDescription are null on every part GSF returns, so the
 * product name has to come from the description itself.
 */
function optionLabel(part, sharedName) {
  const position = meaningfulPosition(part.fitment);
  let segments = String(part.description ?? '')
    .split(/\s+-\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);

  // Drop the product name the whole category shares - it is already the row.
  if (sharedName && segments.length > 1 && segments[0].toLowerCase() === sharedName.toLowerCase()) {
    segments = segments.slice(1);
  }

  // Drop the position wherever the description repeats it, as its own segment
  // ("- Front -") or leading a semicolon list ("Front; 550mm").
  if (position) {
    const wanted = position.toLowerCase();
    segments = segments
      .map((segment) =>
        segment
          .split(/\s*;\s*/)
          .filter((piece) => piece.trim().toLowerCase() !== wanted)
          .join('; ')
          .trim(),
      )
      .filter((segment) => segment && segment.toLowerCase() !== wanted);
  }

  const rest = segments.join(' - ').trim();

  if (!position) return rest || 'Unspecified fitment';
  return rest ? `${position} - ${rest}` : position;
}

/**
 * The leading description segment most options share, e.g. "Wiper Blade".
 *
 * Not unanimity: one VALEO wiper is listed as "FRONT WIPER BLADES" while the
 * other five start "Wiper Blade", and requiring every option to agree left the
 * product name on all six. Half the set is enough to call it the shared name,
 * and options that do not carry it simply keep their own wording.
 */
function sharedProductName(parts) {
  const counts = new Map();

  for (const part of parts) {
    const name = String(part.description ?? '').split(/\s+-\s+/)[0]?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    counts.set(key, { name, count: (counts.get(key)?.count ?? 0) + 1 });
  }

  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }

  return best && best.count * 2 >= parts.length ? best.name : null;
}

/**
 * "N/A" and "" are how GSF says a part has no position - a filter fits one
 * way round. Treating them as a label would put "N/A -" in front of every
 * filter, so they become no position at all.
 */
function meaningfulPosition(fitment) {
  const value = String(fitment ?? '').trim();
  return !value || value.toUpperCase() === 'N/A' ? '' : value;
}

/** Priced, and GSF will actually sell it. Shared by select() and options(). */
function quotable(parts) {
  return parts.filter(
    (p) =>
      p.customerPrice !== null && p.customerPrice !== undefined && p.availability !== 'OutOfStock',
  );
}

/**
 * Apply the brand priority list to an already-sorted set. The first brand with
 * anything quotable wins outright - we do not compare across brands on price.
 */
function pickFrom(sorted, brand) {
  const wanted = brand == null ? [] : [brand].flat().filter(Boolean);

  for (const candidate of wanted) {
    const hits = sorted.filter(
      (p) => String(p.brand ?? '').toUpperCase() === String(candidate).toUpperCase(),
    );
    if (hits.length > 0) return { chosen: hits[0], preferred: hits, matchedBrand: candidate };
  }

  return { chosen: sorted[0], preferred: [], matchedBrand: null };
}

function sorter(prefer) {
  const rank = (p) => AVAILABILITY_RANK[p.availability] ?? UNKNOWN_AVAILABILITY_RANK;

  // 'highest' quotes the dearest part that can actually be supplied, and lets
  // the parts controller decide. Availability only breaks a tie on price.
  if (prefer === 'highest') {
    return (a, b) => b.customerPrice - a.customerPrice || rank(a) - rank(b);
  }

  if (prefer === 'price') {
    return (a, b) => a.customerPrice - b.customerPrice || rank(a) - rank(b);
  }
  return (a, b) => rank(a) - rank(b) || a.customerPrice - b.customerPrice;
}

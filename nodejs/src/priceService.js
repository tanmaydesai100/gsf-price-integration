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

/** Sooner is better. Anything not listed sorts last. */
const AVAILABILITY_RANK = {
  Immediate: 0, // on the shelf at our branch
  HubTomorrow: 1, // next day from a regional hub
  Group72Hours: 2, // ~3 days from the wider group
};

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
   * @param {?string} fitment   "Front", "Rear", or null for both
   * @param {?string} prefer    "availability" (default) or "price"
   */
  async getPartPrice(reg, category, brand = null, fitment = 'Front', prefer = null) {
    const registration = normaliseReg(reg);
    const componentId = await this.categories.componentId(category);
    const payload = await this.#fetch(registration, category, componentId);

    return select(payload, brand, fitment, prefer ?? config.prefer);
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
      // 1. Resolve the registration. In testing the vrm header alone was
      //    enough for vehicles already in the account's history, but that was
      //    never proven for a brand-new reg - so we always do this.
      //    Read-only lookup; failures here are not fatal.
      try {
        await this.client.postJson('/vrm/api', { vrm: reg });
      } catch (error) {
        console.error(`gsf: /vrm/api failed (continuing): ${error.message}`);
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
  const priced = rows.filter((p) => p.customerPrice !== null && p.customerPrice !== undefined);
  const inStock = priced.filter((p) => p.availability !== 'OutOfStock');

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
  const needsReview = groups.length > 1;

  inStock.sort(sorter(prefer));

  const preferred = brand
    ? inStock.filter((p) => String(p.brand ?? '').toUpperCase() === brand.toUpperCase())
    : [];

  const chosen = preferred[0] ?? inStock[0];

  const alternatives = inStock
    .filter(
      (p) => (p.groupedPartNumber ?? '') === (chosen.groupedPartNumber ?? '') && p.sku !== chosen.sku,
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
      company: chosen.companyStock ?? null,
    },

    fitment: chosen.fitment ?? null,
    fitmentGroup: chosen.groupedPartNumber ?? null,

    strategy: prefer,
    brandRequested: brand,
    brandMatched: preferred.length > 0,
    fallbackUsed: Boolean(brand) && preferred.length === 0,

    needsReview,
    reviewReason: needsReview
      ? `${groups.length} distinct ${String(fitment || 'compatible').toLowerCase()} fitment groups ` +
        'returned - the correct size cannot be determined from the catalogue data.'
      : null,

    alternatives,
  };
}

function sorter(prefer) {
  const rank = (p) => AVAILABILITY_RANK[p.availability] ?? 9;

  if (prefer === 'price') {
    return (a, b) => a.customerPrice - b.customerPrice || rank(a) - rank(b);
  }
  return (a, b) => rank(a) - rank(b) || a.customerPrice - b.customerPrice;
}

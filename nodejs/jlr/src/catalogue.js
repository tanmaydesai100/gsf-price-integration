/**
 * The raw JLR EPC catalogue calls, and nothing else. Selection and caching
 * live in priceService.js and hierarchy.js.
 *
 * Every body below is the one the EPC front end sends (read from its
 * bundles) and was confirmed against the live API on 2026-09-24:
 *
 *   vinDecode              { regNum | vin, langCode } -> vin, catID (model)
 *   nextLevelHierarchies   { vin, catHieId, ... }     -> catalogueHierarchies[]
 *   catEntries             { vin, catHieId, retailerCode, ... } -> parts + prices
 *
 * Each also carries the user details: userId, userType, userRole, retailerId.
 * The tree has no separate "major sections" call - it starts at the model's
 * catID from vinDecode and goes model -> major (type 2) -> minor (type 3) ->
 * page (type 4).
 */

import { config } from './config.js';
import { JlrError, JlrUpstreamError } from './errors.js';

const API = '/mobify/proxy/apigee/iepc/catalogue/api/v1';

export const PATHS = {
  vinDecode: `${API}/vehicleConfig/vinDecode`,
  // The EPC's own search box. SECTION finds pages by name, already filtered to
  // the VIN - one call instead of walking the tree. Confirmed 2026-09-28.
  search: '/mobify/proxy/apigee/iepc/search/api/v1/searchCatalogues',
  nextLevel: `${API}/nextLevelHierarchies`,
  parts: config.cataloguePath || `${API}/catEntries`,
};

/** catHieType of a page - the level that carries parts. */
export const PAGE_TYPE = 4;

/** 17 characters, no I/O/Q - the ISO 3779 VIN alphabet. */
export const isVin = (value) => /^[A-HJ-NPR-Z0-9]{17}$/.test(String(value ?? '').toUpperCase());

export const normaliseRegistration = (value) =>
  String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Who is asking. The EPC sends this with every catalogue call. */
function userDetails() {
  if (!config.retailerCode || !config.email) {
    throw new JlrError('JLR_RETAILER_CODE and JLR_EPC_EMAIL must be configured.');
  }

  return {
    userId: config.email,
    userType: config.userType,
    userRole: config.userRole,
    retailerId: config.retailerId || config.retailerCode,
  };
}

const where = () => ({
  featureCodes: [], // with a VIN, JLR works the features out itself
  filter: true, // only what applies to this VIN
  langCode: config.langCode,
  marketCode: config.marketCode,
  parentApplicable: true,
});

export const bodies = {
  vinDecode: ({ registration, vin }) => ({
    ...(vin ? { vin } : { regNum: registration }),
    langCode: config.langCode,
    ...userDetails(),
  }),

  nextLevel: ({ vin, catalogueId }) => ({
    vin,
    catHieId: Number(catalogueId),
    ...where(),
    ...userDetails(),
  }),

  search: ({ vin, catalogueId, text, type = 'SECTION' }) => ({
    catId: Number(catalogueId),
    catHieId: null,
    vin,
    featureCodes: [],
    filter: true,
    dealerCode: config.retailerCode,
    langCode: config.langCode,
    market: config.marketCode,
    searchString: text,
    searchType: type,
    recordFrom: 0,
    numberOfRecords: 5100,
    userCountryCode: config.marketCode,
  }),

  parts: ({ vin, catalogueId }) => ({
    catHieId: Number(catalogueId),
    vin,
    ...where(),
    retailerCode: config.retailerCode,
    ...userDetails(),
  }),
};

export class JlrCatalogue {
  constructor(client) {
    this.client = client;
  }

  /**
   * A registration or a VIN in; the vehicle out, including `catalogueId` -
   * the model's catalogue, where the tree starts.
   */
  async decodeVehicle(input) {
    const value = normaliseRegistration(input);
    if (!value) throw new JlrError('A registration or VIN is required.');

    const body = isVin(value) ? bodies.vinDecode({ vin: value }) : bodies.vinDecode({ registration: value });
    const payload = await this.client.postJson(PATHS.vinDecode, body);
    const vehicle = readVehicle(payload);

    if (!vehicle.vin || !vehicle.catalogueId) {
      throw new JlrUpstreamError(
        `JLR did not recognise ${isVin(value) ? 'VIN' : 'registration'} ${value}` +
          `${payload?.errorMsg ? ` (${payload.errorMsg})` : ''}.`,
        { path: PATHS.vinDecode },
      );
    }

    return { ...vehicle, registration: vehicle.registration ?? (isVin(value) ? null : value) };
  }

  /** The children of one tree node. A page has none. */
  async nextLevel(vehicle, catalogueId) {
    const payload = await this.client.postJson(
      PATHS.nextLevel,
      bodies.nextLevel({ vin: vehicle.vin, catalogueId }),
    );
    return readNodes(payload);
  }

  /** Parts and prices on one catalogue page. */
  async parts({ catalogueId, vin } = {}) {
    if (!catalogueId) throw new JlrError('A JLR catalogue page ID is required.');
    if (!vin) throw new JlrError('A JLR VIN is required.');

    const payload = await this.client.postJson(PATHS.parts, bodies.parts({ catalogueId, vin }));
    if (payload?.success === false) {
      throw new JlrUpstreamError(`JLR returned no parts for page ${catalogueId}: ${payload.errorMsg ?? 'no reason given'}.`, {
        path: PATHS.parts,
      });
    }

    return {
      catalogueId: payload?.responseObject?.catHieId ?? Number(catalogueId),
      category: payload?.responseObject?.catHieDesc ?? null,
      parts: (payload?.responseObject?.catalogueEntries ?? []).map(normalisePart),
    };
  }

  /**
   * Pages whose name contains a phrase, for this VIN: the EPC's "section"
   * search. Whole phrase, not words: "Oil Cooler" finds "Oil Cooler And
   * Filter", "Oil Filter" does not.
   */
  async findSections(vehicle, text) {
    if (!vehicle.catalogueId) throw new JlrError(`No JLR catalogue ID for ${vehicle.vin}.`);
    const payload = await this.client.postJson(
      PATHS.search,
      bodies.search({ vin: vehicle.vin, catalogueId: vehicle.catalogueId, text }),
    );
    return readSections(payload);
  }

  /** Any catalogue call, verbatim. For the CLI. */
  async raw(path, body) {
    return this.client.postJson(path, body);
  }
}

// ---------------------------------------------------------------- readers

export function normalisePart(part) {
  const description = [part.catEntryDesc].flat().filter(Boolean).join(', ');

  return {
    partNumber: part.apn ?? null,
    callout: part.callOutCode ?? null,
    description: description || null,
    comments: part.catEntryCmts ?? [],
    features: part.catEntryFeatures ?? [],
    quantity: Number(part.quantity) || 1,
    unitPrice: part.unitPrice == null || part.unitPrice === '' ? null : Number(part.unitPrice),
    currency: part.currency ?? null,
    // true / false when JLR says so; null when the field is absent.
    applicable: typeof part.applicableInd === 'boolean' ? part.applicableInd : null,
    osi: part.osiInd ?? null,
    fromVin: part.cpFromVIN ?? [],
    toVin: part.cpToVIN ?? [],
    entryId: part.catEntryId ?? [],
  };
}

/**
 * The fields we use from a vinDecode response. responseObject is a list of
 * matching vehicles; a plate or VIN gives one.
 */
export function readVehicle(payload) {
  const found = payload?.responseObject;
  const v = (Array.isArray(found) ? found[0] : found) ?? {};
  return {
    registration: v.regNum ?? null,
    vin: v.vin ?? null,
    catalogueId: v.catHieID ?? v.catID ?? null,
    description: v.catDescription ?? null,
    buildDate: v.buildDate ?? null,
  };
}

/** Pages from a SECTION search, shaped like tree pages. Not-applicable ones are dropped. */
export function readSections(payload) {
  return (payload?.sectionDTO ?? [])
    .filter((p) => p.catHieId != null && p.applicableInd !== false)
    .map((p) => {
      const name = [p.sectionNumber, String(p.catHieDesc ?? '').trim()].filter(Boolean).join(' ');
      return { id: p.catHieId, name, path: [name], label: name };
    });
}

/**
 * Tree nodes from a nextLevelHierarchies response. JLR answers a page with
 * success:false ("Next level hierarchy is not available"), which reads as
 * no children.
 */
export function readNodes(payload) {
  if (payload?.success === false) return [];

  return (payload?.responseObject?.catalogueHierarchies ?? [])
    .filter((node) => node.catHieId != null)
    .map((node) => ({
      id: node.catHieId,
      name: String(node.catHieDesc ?? '').trim() || String(node.catHieId),
      leaf: node.catHieType === PAGE_TYPE,
      applicable: typeof node.applicableInd === 'boolean' ? node.applicableInd : null,
    }));
}

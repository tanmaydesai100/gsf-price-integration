import { config } from './config.js';

const PARTS_PATH =
  '/mobify/proxy/apigee/iepc/catalogue/api/v1/catEntries';
const VIN_PATH =
  '/mobify/proxy/apigee/iepc/catalogue/api/v1/vehicleConfig/vinDecode';
const MAJOR_SECTIONS_PATH =
  '/mobify/proxy/apigee/iepc/catalogue/api/v1/majorSections';
const HIERARCHY_PATH =
  '/mobify/proxy/apigee/iepc/catalogue/api/v1/nextLevelHierarchies';

/**
 * Fetches the parts and prices for one already-resolved JLR catalogue page.
 * Authentication/session creation is intentionally outside this class.
 */
export class JlrCatalogue {
  constructor(client) {
    this.client = client;
  }

  async resolveRegistration(registration) {
    const value = String(registration ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!value) throw new Error('A JLR registration number is required.');

    const payload = await this.decodeVehicle({ vrm: value, registration: value });
    const vehicle = payload?.responseObject ?? payload?.vehicle ?? payload;
    const vin = vehicle?.vin ?? vehicle?.VIN ?? vehicle?.vehicleIdentificationNumber;

    if (!vin) {
      throw new Error(
        `JLR did not return a VIN for registration ${value}. Check the registration and JLR session.`,
      );
    }

    return { registration: value, vin, vehicle };
  }

  /** The request body is kept caller-defined because JLR varies it by login role. */
  async decodeVehicle(body) {
    return this.client.postJson(VIN_PATH, body);
  }

  async majorSections(body) {
    return this.client.postJson(MAJOR_SECTIONS_PATH, body);
  }

  async nextLevel(body) {
    return this.client.postJson(HIERARCHY_PATH, body);
  }

  async parts({ catalogueId, vin, featureCodes = [] } = {}) {
    if (!catalogueId) throw new Error('A JLR catalogue page ID is required.');
    if (!vin) throw new Error('A JLR VIN is required.');
    if (!config.retailerCode || !config.retailerId || !config.email) {
      throw new Error(
        'JLR_RETAILER_CODE, JLR_RETAILER_ID, and JLR_EPC_EMAIL must be configured.',
      );
    }

    const payload = await this.client.postJson(config.cataloguePath || PARTS_PATH, {
      catHieId: Number(catalogueId),
      vin,
      featureCodes,
      filter: true,
      langCode: config.langCode,
      marketCode: config.marketCode,
      parentApplicable: true,
      retailerCode: config.retailerCode,
      userId: config.email,
      userType: config.userType,
      userRole: config.userRole,
      retailerId: config.retailerId,
    });

    return {
      catalogueId: payload?.responseObject?.catHieId ?? Number(catalogueId),
      category: payload?.responseObject?.catHieDesc ?? null,
      parts: (payload?.responseObject?.catalogueEntries ?? []).map(normalisePart),
    };
  }
}

function normalisePart(part) {
  return {
    partNumber: part.apn ?? null,
    callout: part.callOutCode ?? null,
    description: part.catEntryDesc?.join(', ') || null,
    comments: part.catEntryCmts ?? [],
    features: part.catEntryFeatures ?? [],
    quantity: Number(part.quantity) || 1,
    unitPrice: part.unitPrice ?? null,
    currency: part.currency ?? null,
    applicable: part.applicableInd === true,
    osi: part.osiInd ?? null,
    fromVin: part.cpFromVIN ?? [],
    toVin: part.cpToVIN ?? [],
    entryId: part.catEntryId ?? [],
  };
}
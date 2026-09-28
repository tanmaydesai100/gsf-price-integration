/**
 * Every value comes from the environment. See jlr/.env.example.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The jlr/ directory. Runtime state defaults to living inside it. */
export const jlrRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const num = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  baseUrl: (process.env.JLR_EPC_BASE_URL || 'https://www.jlrepc.com').replace(/\/+$/, ''),
  email: process.env.JLR_EPC_EMAIL || null,
  password: process.env.JLR_EPC_PASSWORD || null,
  cataloguePath:
    process.env.JLR_CATALOGUE_PATH ||
    '/mobify/proxy/apigee/iepc/catalogue/api/v1/catEntries',
  retailerCode: process.env.JLR_RETAILER_CODE || null,
  // The EPC sends the same partner code as both. Set JLR_RETAILER_CODE only.
  retailerId: process.env.JLR_RETAILER_ID || process.env.JLR_RETAILER_CODE || null,
  userType: process.env.JLR_USER_TYPE || 'independent',
  userRole: process.env.JLR_USER_ROLE || 'sponsored',
  marketCode: process.env.JLR_MARKET_CODE || 'GB',
  langCode: process.env.JLR_LANG_CODE || 'EN',

  userAgent:
    process.env.JLR_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  timeout: int(process.env.JLR_TIMEOUT, 60) * 1000,

  // Encrypts the cached session. Reuses GSF_APP_KEY when that is already set.
  appKey: process.env.JLR_APP_KEY || process.env.GSF_APP_KEY || null,

  /*
   * The EPC's public login settings (Salesforce SLAS) and JLR's ForgeRock.
   * Read from the live site on 2026-09-24; override only if JLR changes them.
   */
  slas: {
    organizationId: process.env.JLR_SLAS_ORG_ID || 'f_ecom_bjkk_prd',
    clientId: process.env.JLR_SLAS_CLIENT_ID || 'd122e7d6-21b2-4e0e-b5f3-8a8e4819dac2',
    siteId: process.env.JLR_SLAS_SITE_ID || 'jlr-epc',
    hint: process.env.JLR_SLAS_HINT || 'forgerock-iepc',
  },
  forgerock: {
    baseUrl: process.env.JLR_AUTH_BASE_URL || 'https://enterprise.jaguarlandrover.com/auth',
    realm: process.env.JLR_AUTH_REALM || 'b2b',
    tree: process.env.JLR_AUTH_TREE || 'iepc-login',
  },

  cache: {
    dir: process.env.JLR_CACHE_DIR || path.join(jlrRoot, '.cache'),

    // Registration -> VIN barely changes; a plate transfer is the only reason.
    vehicleTtl: int(process.env.JLR_VEHICLE_TTL, 60 * 60 * 24 * 30), // 30 days

    // The catalogue tree for one vehicle. Walking it is the expensive step
    // (one request per node), so it is kept for a long time.
    treeTtl: int(process.env.JLR_TREE_TTL, 60 * 60 * 24 * 30), // 30 days

    // Parts on one page carry prices. JLR_PARTS_TTL=0 always hits live.
    partsTtl: int(process.env.JLR_PARTS_TTL, 600),
  },

  /*
   * The tree walk is sequential and paced so a first lookup for a vehicle
   * does not look like a burst. maxNodes is a hard stop in case the tree
   * turns out to be larger than expected or the leaf detection is wrong.
   */
  walkDelayMs: int(process.env.JLR_WALK_DELAY_MS, 250),
  maxNodes: int(process.env.JLR_MAX_NODES, 1500),

  /*
   * Markup applied to the JLR unitPrice to get the sell price. None by
   * default: JLR parts are quoted at the catalogue price. Deliberately not
   * falling back to GSF_MARKUP_PERCENT - set JLR_MARKUP_PERCENT to add one.
   */
  markupPercent: num(process.env.JLR_MARKUP_PERCENT, 0),
};

#!/usr/bin/env node
/**
 * The V2 quotation module: API + the React front end that talks to it.
 *
 *   node --env-file=.env bin/serve.js          # http://localhost:3000
 *
 * LOCAL TOOL, NOT A PUBLIC SERVER. There is no authentication, and every
 * response carries trade cost - our buying price from GSF. Do not expose this
 * to a network you do not control. What gets shared for review is the static
 * export (`bin/gsf.js quotations --export`), which has no live GSF access.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { GsfCategoryMap } from '../src/categories.js';
import { config } from '../src/config.js';
import { GsfClient } from '../src/client.js';
import { GsfAuthError, GsfBlockedError, GsfError } from '../src/errors.js';
import { GsfPriceService } from '../src/priceService.js';
import { JlrCatalogue } from '../jlr/src/catalogue.js';
import { JlrClient } from '../jlr/src/client.js';
import { config as jlrConfig } from '../jlr/src/config.js';
import { JlrAuthError, JlrError, JlrUpstreamError } from '../jlr/src/errors.js';
import { JlrPriceService } from '../jlr/src/priceService.js';
import {
  createQuotation,
  DEFAULT_BRAND_PRIORITY,
  quotations,
  sellPrice,
  updateQuotation,
} from '../src/quotations.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

// One client for the process, so the session and account number are fetched
// once and reused rather than per request.
const client = new GsfClient();
const categories = new GsfCategoryMap(client);
const prices = new GsfPriceService(client, categories);
const jlrClient = new JlrClient();
const jlrCatalogue = new JlrCatalogue(jlrClient);
const jlrPrices = new JlrPriceService(jlrCatalogue);

// Each supplier brings its own price service and markup. A quotation records
// which one it used, so an edit re-prices new lines against the same one.
const SUPPLIERS = {
  gsf: { prices, markupPercent: config.markupPercent },
  jlr: { prices: jlrPrices, markupPercent: jlrConfig.markupPercent },
};

function supplierOf(value) {
  const key = String(value ?? 'gsf').toLowerCase();
  if (!SUPPLIERS[key]) {
    throw new GsfError(`Unknown supplier "${value}". Use gsf or jlr.`);
  }
  return key;
}

const app = express();
app.use(express.json());

// ------------------------------------------------------------------ routes

/** The service picker. Reads the committed map - no network, no GSF call. */
app.get('/api/categories', async (req, res, next) => {
  try {
    const all = await categories.all();
    const q = String(req.query.q ?? '').trim().toLowerCase();

    const names = Object.keys(all)
      .filter((name) => !q || name.includes(q))
      .sort()
      .slice(0, Number.parseInt(req.query.limit ?? '50', 10));

    res.json({ total: Object.keys(all).length, matched: names.length, categories: names });
  } catch (error) {
    next(error);
  }
});

/**
 * Every fitment a vehicle offers in one category, each with its best part.
 * The picker calls this before a line joins a quotation, so the user chooses
 * the fitment instead of the system guessing at it.
 */
app.get('/api/options', async (req, res, next) => {
  const { registration, category } = req.query;

  if (!registration || !category) {
    return res.status(422).json({ error: 'validation_failed', message: 'registration and category are required.' });
  }

  try {
    const supplier = SUPPLIERS[supplierOf(req.query.supplier)];
    const found = await supplier.prices.listOptions(
      String(registration),
      String(category),
      DEFAULT_BRAND_PRIORITY,
    );

    // The picker is a screen a customer can end up looking at, so it carries
    // the quoted price only. Cost stays server-side.
    res.json({
      ...found,
      markupPercent: supplier.markupPercent,
      options: found.options.map(({ tradePrice, alternatives, ...option }) => ({
        ...option,
        sellPrice: sellPrice(tradePrice, supplier.markupPercent),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The JLR service picker. JLR has no global category list - the catalogue is
 * filtered to the vehicle - so the search runs over this vehicle's pages,
 * using the EPC's own section search (about a second), or the vehicle's tree
 * when that is already cached.
 */
app.get('/api/jlr/pages', async (req, res, next) => {
  const { registration, q } = req.query;

  if (!registration) {
    return res.status(422).json({ error: 'validation_failed', message: 'registration is required.' });
  }

  try {
    const found = await jlrPrices.searchPages(
      String(registration),
      String(q ?? ''),
      Number.parseInt(req.query.limit ?? '40', 10),
    );
    res.json({
      vehicle: found.vehicle.description,
      vin: found.vehicle.vin,
      pages: found.pages.map(({ id, name, label }) => ({ id, name, label })),
    });
  } catch (error) {
    next(error);
  }
});

/** The fixed JLR job list - the same for every vehicle. No network. */
app.get('/api/jlr/jobs', (_req, res) => {
  res.json({ jobs: jlrPrices.jobs.list() });
});

/**
 * One job priced for one vehicle: the parts it needs, found by callout base.
 * Sell prices only, like /api/options - cost stays server-side.
 */
app.get('/api/jlr/job', async (req, res, next) => {
  const { registration, job } = req.query;

  if (!registration || !job) {
    return res.status(422).json({ error: 'validation_failed', message: 'registration and job are required.' });
  }

  try {
    const found = jlrPrices.jobs.find(String(job));
    if (!found) return res.status(404).json({ error: 'not_found', message: `Unknown job "${job}".` });

    const markup = jlrConfig.markupPercent;
    const { options, ...rest } = await jlrPrices.listOptions(String(registration), found.label);
    res.json({
      ...rest,
      label: found.label,
      markupPercent: markup,
      options: options.map(({ tradePrice, alternatives, ...option }) => ({
        ...option,
        sellPrice: sellPrice(tradePrice, markup),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Raw parts on one JLR page, by ID. A debugging aid: it bypasses the tree
 * and service matching. Accepts a VIN in place of a registration.
 */
app.post('/api/jlr/catalogue', async (req, res, next) => {
  const { catalogueId, registration } = req.body ?? {};

  if (!catalogueId || !registration) {
    return res.status(422).json({
      error: 'validation_failed',
      message: 'catalogueId and registration (or VIN) are required.',
    });
  }

  try {
    const vehicle = await jlrPrices.vehicle(registration);
    res.json({
      ...vehicle,
      ...(await jlrCatalogue.parts({ catalogueId: String(catalogueId), vin: vehicle.vin })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/quotations', async (_req, res, next) => {
  try {
    // The list view needs headers, not every line of every quote.
    const all = await quotations.all();
    res.json({
      quotations: all.map((q) => ({
        number: q.number,
        registration: q.registration,
        supplier: q.supplier,
        vehicle: q.vehicle,
        date: q.date,
        createdAt: q.createdAt,
        services: q.totals?.services ?? q.lines?.length ?? 0,
        tradeCost: q.totals?.tradeCost ?? 0,
        sell: q.totals?.sell ?? 0,
        items: q.totals?.items ?? 0,
        needsReview: Boolean(q.needsReview),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/quotations/:number', async (req, res, next) => {
  try {
    const found = await quotations.get(req.params.number);
    if (!found) return res.status(404).json({ error: 'not_found' });
    res.json(found);
  } catch (error) {
    next(error);
  }
});

app.post('/api/quotations', async (req, res, next) => {
  const { registration, date, services, brands } = req.body ?? {};

  try {
    const supplier = supplierOf(req.body?.supplier);

    // Slow by design: each service is priced against the supplier in turn,
    // so a six-line quote is a few seconds. The front end shows progress.
    const quotation = await createQuotation({
      registration,
      date,
      services,
      brands: Array.isArray(brands) && brands.length > 0 ? brands : DEFAULT_BRAND_PRIORITY,
      service: SUPPLIERS[supplier].prices,
      supplier,
      markupPercent: SUPPLIERS[supplier].markupPercent,
    });

    res.status(201).json(quotation);
  } catch (error) {
    next(error);
  }
});

/**
 * Edit a stored quotation - quantities, added lines, removed lines.
 * Lines already on it keep the price they were quoted at.
 */
app.patch('/api/quotations/:number', async (req, res, next) => {
  try {
    const existing = await quotations.get(req.params.number);
    const supplier = SUPPLIERS[existing?.supplier ?? 'gsf'] ?? SUPPLIERS.gsf;
    res.json(
      await updateQuotation(req.params.number, { lines: req.body?.lines, service: supplier.prices }),
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/session', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await client.sessionInfo()) });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

// ------------------------------------------------------------ front end

app.use(express.static(path.join(pkgRoot, 'web')));

// ---------------------------------------------------------------- errors

app.use((error, _req, res, _next) => {
  if (error instanceof GsfBlockedError) {
    return res.status(503).json({ error: 'supplier_blocked', message: error.message });
  }
  if (error instanceof GsfAuthError) {
    return res.status(503).json({ error: 'supplier_auth', message: error.message });
  }
  if (error instanceof GsfError) {
    return res.status(400).json({ error: 'gsf_error', message: error.message });
  }
  if (error instanceof JlrAuthError) {
    return res.status(503).json({ error: 'supplier_auth', message: error.message });
  }
  if (error instanceof JlrUpstreamError) {
    return res.status(502).json({ error: 'jlr_error', message: error.message });
  }
  if (error instanceof JlrError) {
    return res.status(400).json({ error: 'jlr_error', message: error.message });
  }

  console.error(error);
  return res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Parts quotations (GSF + JLR)  ->  http://localhost:${PORT}`);
  console.log('  Local tool. Shows trade cost. Do not expose.\n');
});

// Close the JLR browser cleanly so its profile (and login) is flushed to disk.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    await jlrClient.close().catch(() => {});
    process.exit(0);
  });
}

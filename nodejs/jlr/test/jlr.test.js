/**
 * The JLR rules that decide what gets quoted, tested without touching JLR.
 *
 *   node --test jlr/test/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Config is read at import time, so the environment is set first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jlr-test-'));
process.env.JLR_WALK_DELAY_MS = '0';
process.env.JLR_MAX_NODES = '50';
process.env.JLR_CACHE_DIR = path.join(scratch, 'jlr-cache');
process.env.GSF_CACHE_DIR = path.join(scratch, 'gsf-cache');
process.env.GSF_QUOTATIONS_DIR = path.join(scratch, 'quotations');
process.env.JLR_RETAILER_CODE = 'R1';
process.env.JLR_RETAILER_ID = 'ID1';
process.env.JLR_EPC_EMAIL = 'test@example.com';

const { JlrCatalogue, normalisePart, readNodes, readVehicle, isVin, PATHS } = await import('../src/catalogue.js');
const { JlrHierarchy, matchPages, describes } = await import('../src/hierarchy.js');
const { options, select } = await import('../src/priceService.js');
const { createQuotation } = await import('../../src/quotations.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, 'catEntries.fixture.json'), 'utf8'));
const parts = payload.responseObject.catalogueEntries.map(normalisePart);
const oilPage = { id: 27576, name: 'Oil Filter', path: ['Engine', 'Lubrication', 'Oil Filter'], label: 'Engine › Lubrication › Oil Filter' };

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ------------------------------------------------------------------ options

test('drops parts JLR marks not applicable, and unpriced parts', () => {
  const skus = options([{ page: oilPage, parts }]).options.map((o) => o.sku);
  assert.ok(!skus.includes('LR022896'), 'applicableInd=false must never be quoted');
  assert.ok(!skus.includes('LR000001'), 'unitPrice=null must never be quoted');
});

test('keeps a part whose applicability JLR does not state', () => {
  const unflagged = [{ ...parts[0], applicable: null }];
  assert.equal(options([{ page: oilPage, parts: unflagged }]).options.length, 1);
});

test('one option per part number, however many callouts list it', () => {
  const list = options([{ page: oilPage, parts }]).options;
  assert.equal(list.filter((o) => o.sku === 'LR073669').length, 1);
  assert.deepEqual(list.map((o) => o.sku), ['LR073669', 'LR011279']);
});

test('options carry the GSF option shape the picker and quotations read', () => {
  const [first, second] = options([{ page: oilPage, parts }]).options;
  assert.equal(first.group, 'LR073669');
  assert.equal(first.tradePrice, 18.4);
  assert.equal(first.brand, 'JLR Genuine');
  assert.equal(first.position, 'Oil Filter');
  assert.match(first.label, /2\.0L 4 Cyl Diesel/);
  assert.equal(second.unitsPerVehicle, 2);
});

test('a non-GBP price is flagged', () => {
  const euro = [{ ...parts[0], currency: 'EUR' }];
  const [only] = options([{ page: oilPage, parts: euro }]).options;
  assert.equal(only.needsReview, true);
});

// ------------------------------------------------------------------- select

test('several candidates: picks one and flags the line', () => {
  const r = select({ pages: [oilPage.label], category: 'Oil Filter', ...options([{ page: oilPage, parts }]) });
  assert.equal(r.found, true);
  assert.equal(r.sku, 'LR073669');
  assert.equal(r.needsReview, true);
  assert.equal(r.alternatives.length, 1);
});

test('nothing quotable: found=false with a reason', () => {
  const r = select({ pages: [], category: 'Flux Capacitor', positions: [], options: [] });
  assert.equal(r.found, false);
  assert.match(r.reason, /No JLR catalogue page/);
});

// ----------------------------------------------------------------- matching

const tree = [
  oilPage,
  { id: 2, name: 'Fuel Filter', path: ['Fuel System', 'Fuel Filter'], label: 'Fuel System › Fuel Filter' },
  { id: 3, name: 'Oil Filter Housing Gasket', path: ['Engine', 'Oil Filter Housing Gasket'], label: 'Engine › Oil Filter Housing Gasket' },
  { id: 4, name: 'Wiper Blade', path: ['Body', 'Wipers', 'Wiper Blade'], label: 'Body › Wipers › Wiper Blade' },
];

test('the exact label the picker sends is that page, and only it', () => {
  const found = matchPages(tree, 'Engine › Oil Filter Housing Gasket');
  assert.equal(found.exact, true);
  assert.deepEqual(found.pages.map((p) => p.id), [3]);
});

test('a service name shortlists pages, best first', () => {
  const found = matchPages(tree, 'Oil Filter');
  assert.equal(found.exact, false);
  assert.equal(found.pages[0].id, 27576);
  assert.ok(found.pages.length <= 6);
});

test('page hints from aliases find assembly pages', () => {
  const pages = [
    { id: 1, name: 'Front Brake Discs And Calipers', path: ['Braking', 'Front Brake Discs And Calipers'], label: 'Braking › Front Brake Discs And Calipers' },
    { id: 2, name: 'Seat Pads', path: ['Seats', 'Seat Pads'], label: 'Seats › Seat Pads' },
  ];
  assert.equal(matchPages(pages, 'Brake Pads').pages[0].id, 1);
});

test('part descriptions decide: right part in, lookalikes out', () => {
  assert.ok(describes('Filter - Oil', 'Oil Filter'));
  assert.ok(!describes('Filter - Fuel', 'Oil Filter'), '"oil filter" never matches a fuel filter');
  assert.ok(!describes('Adaptor - Oil Filter', 'Oil Filter'), 'excluded in aliases');
  assert.ok(describes('Kit - Brake Pad - Front', 'Brake Pads'));
  assert.ok(!describes('Pad - Brake Pedal', 'Brake Pads'), 'pedal pads are excluded');
  assert.ok(describes('Blade - Wiper', 'Wipers'));
  assert.ok(!describes('Motor - Wiper - RHD', 'Wipers'));
  assert.ok(describes('Element - Air Cleaner', 'Air Filter'));
});

// --------------------------------------------------------------------- walk

function fakeCatalogue(children) {
  const calls = [];
  return {
    calls,
    async nextLevel(_vehicle, id) { calls.push(id); return children[id] ?? []; },
  };
}

test('walks to pages: an empty expansion or a leaf flag ends a branch', async () => {
  const catalogue = fakeCatalogue({
    24: [
      { id: 1, name: 'Engine', leaf: false },
      { id: 9, name: 'Body', leaf: false },
      { id: 8, name: 'Diesel Engine', leaf: false, applicable: false },
    ],
    1: [{ id: 10, name: 'Lubrication', leaf: false }],
    10: [{ id: 27576, name: 'Oil Filter', leaf: null }, { id: 11, name: 'Sump', leaf: true }],
    9: [],
  });

  const pages = await new JlrHierarchy(catalogue).walk({ vin: 'SALGA2BE8KA000001', catalogueId: 24 });
  assert.deepEqual(pages.map((p) => p.label).sort(), ['Body', 'Engine › Lubrication › Oil Filter', 'Engine › Lubrication › Sump']);
  assert.equal(catalogue.calls[0], 24, 'the walk starts at the model catalogue');
  assert.ok(!catalogue.calls.includes(11), 'a page is not expanded');
  assert.ok(!catalogue.calls.includes(8), 'a branch JLR marks not applicable is skipped');
});

test('stops at JLR_MAX_NODES instead of walking forever', async () => {
  // Every node has two children and none is ever flagged a leaf.
  let next = 100;
  const endless = {
    async nextLevel() {
      next += 2;
      return [{ id: next, name: `Node ${next}`, leaf: null }, { id: next + 1, name: `Node ${next + 1}`, leaf: null }];
    },
  };
  await assert.rejects(new JlrHierarchy(endless).walk({ vin: 'X', catalogueId: 1 }), /exceeded 50 nodes/);
});

// ------------------------------------------------------------------ readers

test('reads tree nodes as nextLevelHierarchies returns them', () => {
  const nodes = readNodes({
    success: true,
    responseObject: {
      catalogueHierarchies: [
        { catHieId: 53327, catHieType: 3, catHieDesc: '0302 Engine Lubrication', applicableInd: true },
        { catHieId: 43704, catHieType: 4, catHieDesc: '10A Oil Cooler And Filter', applicableInd: true },
      ],
    },
  });
  assert.deepEqual(nodes, [
    { id: 53327, name: '0302 Engine Lubrication', leaf: false, applicable: true },
    { id: 43704, name: '10A Oil Cooler And Filter', leaf: true, applicable: true },
  ]);
});

test('"Next level hierarchy is not available" reads as no children', () => {
  assert.deepEqual(readNodes({ success: false, errorMsg: 'Next level hierarchy is not available.' }), []);
});

test('reads the vehicle and its model catalogue from vinDecode', () => {
  const v = readVehicle({
    success: true,
    responseObject: [{ vin: 'SALVA2AG9CH625120', regNum: 'WL61RZO', catID: 24, catHieID: 24, catDescription: 'RANGE ROVER EVOQUE 2012 - 2018 (L538)' }],
  });
  assert.deepEqual(v, {
    registration: 'WL61RZO', vin: 'SALVA2AG9CH625120', catalogueId: 24,
    description: 'RANGE ROVER EVOQUE 2012 - 2018 (L538)', buildDate: null,
  });
});

test('vinDecode sends regNum for a plate and vin for a VIN, with the user details', async () => {
  const sent = [];
  const reply = { success: true, responseObject: [{ vin: 'SALVA2AG9CH625120', catID: 24 }] };
  const catalogue = new JlrCatalogue({ postJson: async (path, body) => { sent.push({ path, body }); return reply; } });

  await catalogue.decodeVehicle('wl61 rzo');
  await catalogue.decodeVehicle('salva2ag9ch625120');

  assert.equal(sent[0].path, PATHS.vinDecode);
  assert.equal(sent[0].body.regNum, 'WL61RZO');
  assert.equal(sent[1].body.vin, 'SALVA2AG9CH625120');
  assert.equal(sent[1].body.regNum, undefined);
  assert.equal(sent[0].body.retailerId, 'ID1');
  assert.equal(sent[0].body.userType, 'independent');
  assert.ok(isVin('SALVA2AG9CH625120') && !isVin('WL61RZO'));
});

test('an unknown plate is a clear error, not an empty vehicle', async () => {
  const catalogue = new JlrCatalogue({ postJson: async () => ({ success: false, errorMsg: 'Invalid registration' }) });
  await assert.rejects(catalogue.decodeVehicle('XX00XXX'), /did not recognise registration XX00XXX \(Invalid registration\)/);
});

// --------------------------------------------------------------- quotation

test('a JLR quotation records its supplier, markup and per-vehicle quantity', async () => {
  const stub = {
    async listOptions(_reg, category) {
      return { vehicle: 'Land Rover Discovery Sport', vin: 'SALGA2BE8KA000001', category, pages: [oilPage.label], ...options([{ page: oilPage, parts }]) };
    },
    async getPartPrice(reg, category) { return select(await this.listOptions(reg, category)); },
  };

  const q = await createQuotation({
    registration: 'wl61 rzo',
    date: '2026-09-24',
    services: [{ category: oilPage.label, group: 'LR011279' }],
    service: stub,
    supplier: 'jlr',
    markupPercent: 25,
  });

  assert.equal(q.supplier, 'jlr');
  assert.deepEqual(q.brandPriority, []);
  assert.equal(q.markupPercent, 25);
  assert.equal(q.lines[0].sku, 'LR011279');
  assert.equal(q.lines[0].quantity, 2, 'the seal is listed twice per vehicle');
  assert.equal(q.lines[0].sellPrice, 5.13);
  assert.equal(q.totals.sell, 10.26);
  assert.equal(q.vin, 'SALGA2BE8KA000001');
});

test('page context: "Element - Filter" on the Air Cleaner page is the air filter', () => {
  assert.ok(describes('Element - Filter', 'Air Filter', 'Engine Air Intake › 05A Air Cleaner'));
  assert.ok(!describes('Element - Filter', 'Air Filter', 'Fuel System › Fuel Filter'));
  assert.ok(describes('Belt', 'Auxiliary Belt', 'Accessory Drive › 05A Pulleys And Drive Belts'));
  assert.ok(!describes('Tensioner', 'Auxiliary Belt', 'Accessory Drive › 05A Pulleys And Drive Belts'));
});

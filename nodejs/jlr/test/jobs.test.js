/**
 * Job pricing by callout base, tested without touching JLR. The rows are
 * real ones from a Range Rover Evoque (L538) and a Range Rover Sport (L494),
 * read on 2026-09-27.
 *
 *   node --test jlr/test/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jlr-jobs-test-'));
process.env.JLR_CACHE_DIR = path.join(scratch, 'jlr-cache');
process.env.JLR_PARTS_TTL = '0';

const { JlrJobs, matchesBase, pagesFor, resolve, loadJobs } = await import('../src/jobs.js');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const part = (callout, partNumber, description, unitPrice, extra = {}) => ({
  callout,
  partNumber,
  description,
  unitPrice,
  quantity: 1,
  applicable: true,
  features: [],
  comments: [],
  toVin: [],
  ...extra,
});

// ------------------------------------------------------------------ matching

test('a callout matches its base, or the base plus one letter', () => {
  assert.ok(matchesBase('2005', '2005'));
  assert.ok(matchesBase('19542A', '19542'));
  assert.ok(matchesBase('<18K258', '18K258'));
  assert.ok(!matchesBase('2B120', '2B12'), 'a longer base number is a different part');
  assert.ok(!matchesBase('6C683', '6731'));
  assert.ok(!matchesBase('HB1', '2001'));
  assert.ok(matchesBase('6714', ['6731', '6714']), 'oil filter: spin-on or cartridge');
});

test('page hints: every word of one phrase in the page name', () => {
  const pages = [
    { id: 1, name: '05A Front Brake Discs And Calipers (Halewood (UK)) (To (V)FH999999)' },
    { id: 2, name: '05A Rear Brake Discs And Calipers (Halewood (UK))' },
    { id: 3, name: '15 Heater/Air Con Blower And Compnts' },
    { id: 4, name: '10A Heater/Air Cond.Internal Components (Heater Main Unit)' },
  ];
  assert.deepEqual(pagesFor(pages, ['front brake discs calipers']).map((p) => p.id), [1]);
  assert.deepEqual(pagesFor(pages, ['heater air cond internal', 'heater air con blower']).map((p) => p.id), [3, 4]);
});

// ------------------------------------------------------------------ choosing

test('one part: quoted, with the catalogue quantity', () => {
  const r = resolve([part('1125', 'LR007055', 'Disc - Brake', 104.14, { quantity: 2 })]);
  assert.equal(r.status, 'ok');
  assert.equal(r.rule, 'single');
  assert.equal(r.parts[0].lineTotal, 208.28);
});

test('LH and RH of the same part: both are quoted', () => {
  const r = resolve([
    part('17528', 'LR025113', 'Blade - Wiper', 32.96, { features: ['RHD'], comments: ['RH'] }),
    part('17528', 'LR025115', 'Blade - Wiper', 33.42, { features: ['RHD'], comments: ['LH'] }),
  ]);
  assert.equal(r.rule, 'pair');
  assert.deepEqual(r.parts.map((p) => p.partNumber), ['LR025113', 'LR025115']);
});

test('prefer words settle a size: brake fluid takes the 1 L, not 500 ML', () => {
  const r = resolve(
    [
      part('19542A', 'SIJ500030', 'Fluid - Brake', 9.22, { comments: ['500 ML'] }),
      part('19542B', 'SIJ500040', 'Fluid - Brake', 16.67, { comments: ['1 L'] }),
    ],
    { prefer: ['1 l'] },
  );
  assert.equal(r.rule, 'preferred');
  assert.equal(r.parts[0].partNumber, 'SIJ500040');
});

test('an "upgrade" accessory is dropped, even though it has no end VIN', () => {
  const r = resolve(
    [
      part('19N619', 'LR019192', 'Filter - Pollen', 21.3, { comments: ['Standard'], toVin: ['(V)CH667375'] }),
      part('19N619', 'VPLFS0488', 'Filter - Pollen', 81.4, { comments: ['PM 2.5 Upgrade'] }),
    ],
    { avoid: loadJobs().defaults.avoid },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.parts[0].partNumber, 'LR019192');
});

test('same part, same price, two numbers: the current one, the other as an alternative', () => {
  const r = resolve([
    part('12405', 'LR025605', 'Spark Plug', 23.43, { quantity: 4, toVin: ['(V)FH077413'] }),
    part('12405', 'LR123892', 'Spark Plug', 23.43, { quantity: 4 }),
  ]);
  assert.equal(r.rule, 'interchangeable');
  assert.equal(r.parts[0].partNumber, 'LR123892');
  assert.equal(r.alternatives[0].partNumber, 'LR025605');
});

test('a real choice: cheapest quoted provisionally and flagged for staff', () => {
  const r = resolve([
    part('2001', 'LR000002', 'Kit - Caliper Brake Pad', 120, { comments: ['For 18" Brakes'] }),
    part('2001', 'LR000001', 'Kit - Caliper Brake Pad', 95.84, { comments: ['For 16" Brakes'] }),
  ]);
  assert.equal(r.status, 'review');
  assert.equal(r.parts[0].partNumber, 'LR000001');
  assert.equal(r.alternatives.length, 1);
});

test('nothing priced and applicable: missing', () => {
  const r = resolve([part('2005', 'LR024469', 'Booster - Brake', null), part('2005', 'LR1', 'Booster', 10, { applicable: false })]);
  assert.equal(r.status, 'missing');
});

// ----------------------------------------------------------------- end to end

function fakePrices(pages, partsByPage) {
  return {
    vehicle: async () => ({ registration: 'WL61RZO', vin: 'SALVA2AG9CH625120', description: 'RANGE ROVER EVOQUE (L538)' }),
    // Section search: the fake returns every page; the job's page hints narrow it.
    hierarchy: { pages: async () => pages, sections: async () => pages },
    pageParts: async (_vehicle, id) => ({ parts: partsByPage[id] ?? [] }),
  };
}

test('a job: each base priced from its page, lookalikes on the page ignored', async () => {
  const jobs = new JlrJobs(
    fakePrices([{ id: 27595, name: '05A Front Brake Discs And Calipers (Halewood (UK))' }], {
      27595: [
        part('1125', 'LR007055', 'Disc - Brake', 104.14, { quantity: 2 }),
        part('2001', 'LR027309', 'Kit - Caliper Brake Pad', 95.84),
        part('2K004', 'LR027110', 'Shield - Splash', 48.96, { comments: ['LH'] }),
      ],
    }),
  );
  const r = await jobs.price('WL61RZO', 'front_pads_discs');
  assert.equal(r.needsReview, false);
  assert.deepEqual(r.lines.map((l) => l.parts[0].partNumber), ['LR027309', 'LR007055']);
  assert.equal(r.total, 304.12);
});

test('no page for it on this vehicle (spark plugs on a diesel) is not "missing"', async () => {
  const jobs = new JlrJobs(fakePrices([{ id: 1, name: '10A Oil Cooler And Filter' }], {}));
  const r = await jobs.price('PE17KMO', 'spark_plugs');
  assert.equal(r.lines[0].status, 'no_page');
  assert.equal(r.needsReview, true);
});

test('an unknown job names the known ones', async () => {
  const jobs = new JlrJobs(fakePrices([], {}));
  await assert.rejects(jobs.price('X', 'nope'), /Known jobs: front_brake_pads/);
});

// -------------------------------------------------------------- quotations

test('a job is found by key or by label, and nothing else', () => {
  const jobs = new JlrJobs(fakePrices([], {}));
  assert.equal(jobs.find('front_pads_discs').label, 'Front brake pads & discs');
  assert.equal(jobs.find('front brake pads & discs').key, 'front_pads_discs');
  assert.equal(jobs.find('05A Front Brake Discs And Calipers'), null);
});

test('a priced job becomes quotation options: parts ticked, alternatives marked, gaps listed', async () => {
  const { jobOptions } = await import('../src/priceService.js');
  const jobs = new JlrJobs(
    fakePrices([{ id: 1, name: '05A Ignition Coil And Wires/Spark Plugs' }], {
      1: [
        part('12405', 'LR025605', 'Spark Plug', 23.43, { quantity: 4, toVin: ['(V)FH077413'] }),
        part('12405', 'LR123892', 'Spark Plug', 23.43, { quantity: 4 }),
      ],
    }),
  );
  const found = jobOptions(await jobs.price('WL61RZO', 'spark_plugs'), 'Spark plugs');
  assert.deepEqual(
    found.options.map((o) => [o.group, o.alternative, o.unitsPerVehicle]),
    [
      ['LR123892', false, 4],
      ['LR025605', true, 4],
    ],
  );
  assert.equal(found.options[0].tradePrice, 23.43);
  assert.deepEqual(found.unpriced, []);
});

test('a diesel-only part on a petrol car is "not on this vehicle", not missing', async () => {
  const jobs = new JlrJobs(
    fakePrices([{ id: 1, name: '05A Fuel Injectors And Pipes 2.0L 16V TIVCT T/C 240PS Petrol,Halewood (UK)' }], {
      1: [part('9F593', 'LR1', 'Injector', 300)],
    }),
  );
  const r = await jobs.price('WL61RZO', 'glow_plugs');
  assert.equal(r.lines[0].status, 'no_page');
  assert.match(r.lines[0].reason, /diesel/);
});

test('fuel filter: the filter, not the complete housing assembly', () => {
  const r = resolve(
    [
      part('9S324', 'LR041978', 'Filter', 98.46, { comments: ['Less Bracket', 'Primary'] }),
      part('9S324', 'LR081085', 'Filter - Fuel', 174.61, { comments: ['With Bracket', 'Primary', 'Complete Assembly'] }),
    ],
    { avoid: ['upgrade', 'complete assembly'] },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.parts[0].partNumber, 'LR041978');
});

test('wheel bearing: a bare hub on the same base is never quoted', () => {
  const evoqueFront = [
    part('1215', 'LR024267', 'Bearing - Wheel Hub', 96.17, { quantity: 2, comments: ['RH/LH'] }),
    part('1104', 'LR025107', 'Hub - Wheel', 191.97, { quantity: 2, comments: ['RH/LH'] }),
  ];
  const r = resolve(evoqueFront, { require: ['bearing'], qty: 1 });
  assert.equal(r.parts[0].partNumber, 'LR024267');
  assert.equal(r.parts[0].quantity, 1);

  const l460 = [part('1104', 'LR152789', 'Hub - Wheel', 277.95, { comments: ['RH/LH', 'With Bearing'] })];
  assert.equal(resolve(l460, { require: ['bearing'] }).parts[0].partNumber, 'LR152789');

  const bareHubOnly = [part('1104', 'LR025107', 'Hub - Wheel', 191.97, { comments: ['RH/LH'] })];
  assert.equal(resolve(bareHubOnly, { require: ['bearing'] }).status, 'missing');
});

/**
 * The selection rules are the part with real business consequences, and the
 * only part testable without touching GSF. Fixture mirrors the shape of a
 * real /parts/api/parts payload for P44PYN.
 *
 *   node --test test/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { select } from '../src/priceService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, 'fixture.json'), 'utf8'));

test('prefers the requested brand and soonest availability', () => {
  const r = select(payload, 'BOSCH', 'Front', 'availability');
  assert.equal(r.sku, 'BOSAR550S');
  assert.equal(r.tradePrice, 20.9);
  assert.equal(r.brandMatched, true);
  assert.equal(r.fallbackUsed, false);
});

test('prefer=price picks the cheapest, ignoring brand when none requested', () => {
  const r = select(payload, null, 'Front', 'price');
  assert.equal(r.sku, 'CHEAPO1');
  assert.equal(r.tradePrice, 9.99);
});

test('falls back when the requested brand has nothing quotable', () => {
  const r = select(payload, 'FEBI', 'Front', 'availability');
  assert.equal(r.found, true);
  assert.equal(r.brandMatched, false);
  assert.equal(r.fallbackUsed, true);
});

test('flags needsReview when several fitment groups come back', () => {
  // 550/530 and 600/500 are different physical SIZES, not better/worse deals.
  const r = select(payload, 'BOSCH', 'Front', 'availability');
  assert.equal(r.needsReview, true);
  assert.match(r.reviewReason, /fitment groups/);
});

test('single fitment group does not need review', () => {
  const r = select(payload, 'BOSCH', 'Rear', 'availability');
  assert.equal(r.needsReview, false);
  assert.equal(r.reviewReason, null);
});

test('drops unpriced and out-of-stock parts', () => {
  const skus = [
    select(payload, null, 'Front', 'price').sku,
    ...select(payload, null, 'Front', 'price').alternatives.map((a) => a.sku),
  ];
  assert.ok(!skus.includes('NOPRICE1'), 'customerPrice=null must never be quoted');
  assert.ok(!skus.includes('OOS1'), 'OutOfStock must never be quoted');
});

test('alternatives stay inside the chosen fitment group', () => {
  const r = select(payload, 'BOSCH', 'Front', 'availability');
  assert.equal(r.fitmentGroup, '550/530');
  assert.ok(!r.alternatives.some((a) => a.sku === 'BOSA113S'), '600/500 is a different size');
});

test('null fitment is handled (the Python select crashes here)', () => {
  const r = select(payload, null, null, 'availability');
  assert.equal(r.found, true);
  assert.match(r.reviewReason, /compatible fitment groups/);
});

test('reports not-found without throwing when nothing is quotable', () => {
  const empty = { ...payload, partData: { parts: [] } };
  const r = select(empty, 'BOSCH', 'Front', 'availability');
  assert.equal(r.found, false);
  assert.equal(r.needsReview, true);
});

test('GroupTomorrow outranks Group72Hours', () => {
  // Wipers came back Immediate/OutOfStock only, so this value never appeared
  // in the fixture - and an unranked value sorts LAST, putting a next-day
  // part behind a three-day one. Live brake discs on P44PYN return it.
  const part = (sku, availability) => ({
    sku,
    brand: 'X',
    availability,
    customerPrice: 100,
    groupedPartNumber: 'G1',
    fitment: null,
  });

  const r = select(
    { partData: { parts: [part('SLOW-3DAY', 'Group72Hours'), part('NEXT-DAY', 'GroupTomorrow')] } },
    null,
    null,
    'availability',
  );

  assert.equal(r.sku, 'NEXT-DAY');
});

// A part builder for the ranking tests: one fitment group, equal prices, so
// availability is the only thing that can decide the winner.
const candidate = (sku, availability, customerPrice = 100) => ({
  sku,
  brand: 'X',
  availability,
  customerPrice,
  groupedPartNumber: 'G1',
  fitment: null,
});

const pick = (parts, brand = null) =>
  select({ partData: { parts } }, brand, null, 'availability');

test('HubAfternoon beats everything except Immediate', () => {
  assert.equal(pick([candidate('TOMORROW', 'HubTomorrow'), candidate('TODAY', 'HubAfternoon')]).sku, 'TODAY');
  assert.equal(pick([candidate('TODAY', 'HubAfternoon'), candidate('NOW', 'Immediate')]).sku, 'NOW');
});

test('an unranked availability value sorts mid-table, not last', () => {
  // Both values we have had to add - GroupTomorrow, then HubAfternoon - were
  // FASTER than Group72Hours, so burying unknowns picked the wrong part twice.
  const r = pick([candidate('THREE-DAY', 'Group72Hours'), candidate('MYSTERY', 'SomethingNew')]);
  assert.equal(r.sku, 'MYSTERY');
});

test('an unranked value still loses to every known-good one', () => {
  const r = pick([candidate('MYSTERY', 'SomethingNew'), candidate('KNOWN', 'GroupTomorrow')]);
  assert.equal(r.sku, 'KNOWN');
});

test('an unranked value is reported so it can be fixed', () => {
  const r = pick([candidate('A', 'Immediate'), candidate('B', 'SomethingNew')]);
  assert.deepEqual(r.unknownAvailability, ['SomethingNew']);

  const clean = pick([candidate('A', 'Immediate')]);
  assert.equal(clean.unknownAvailability, null);
});

test('brand preference is an ordered priority list', () => {
  const parts = [
    { ...candidate('MANN-1', 'Group72Hours'), brand: 'MANN-FILTER' },
    { ...candidate('BOSCH-1', 'Immediate'), brand: 'BOSCH' },
  ];

  // MANN is first in the list, so it wins even though BOSCH is available
  // sooner. We do not compare across brands - the priority is the point.
  const r = pick(parts, ['MANN-FILTER', 'BOSCH']);
  assert.equal(r.sku, 'MANN-1');
  assert.equal(r.brandSelected, 'MANN-FILTER');
  assert.equal(r.brandMatched, true);
});

test('brand list falls through to the next brand, then to anything', () => {
  const parts = [
    { ...candidate('BOSCH-1', 'Immediate'), brand: 'BOSCH' },
    { ...candidate('OTHER-1', 'Immediate'), brand: 'HENGST' },
  ];

  const second = pick(parts, ['MANN-FILTER', 'BOSCH']);
  assert.equal(second.brandSelected, 'BOSCH');

  const none = pick(parts, ['MANN-FILTER', 'FEBI']);
  assert.equal(none.brandMatched, false);
  assert.equal(none.fallbackUsed, true);
  assert.equal(none.found, true, 'still quotes something');
});

test('a single brand string still works', () => {
  const parts = [{ ...candidate('BOSCH-1', 'Immediate'), brand: 'BOSCH' }];
  assert.equal(pick(parts, 'BOSCH').brandSelected, 'BOSCH');
});

/**
 * Prices a customer-facing job ("Front brake pads & discs") on any JLR
 * vehicle, without the customer ever seeing a part number.
 *
 *   const jobs = new JlrJobs(prices);
 *   await jobs.price('WL61RZO', 'front_pads_discs');
 *
 * A job lists its parts by callout BASE number (jlr/data/jobs.json). The
 * base is the middle of JLR's engineer number - BJ32-2005-AC is a 2005, a
 * brake booster - and is the same on every model. So one job list covers
 * every catalogue: page names only say where to look, the base decides
 * which part it is. A free-text search for "brake" gives twenty rows; base
 * 2001 on the front brake page gives the pad kit.
 *
 * When one base still has several parts, resolve() settles what the data
 * can settle and flags the rest for staff (needsReview), never the customer.
 */

import fs from 'node:fs';
import path from 'node:path';

import { jlrRoot } from './config.js';
import { JlrError } from './errors.js';
import { quotable } from './priceService.js';

export class JlrJobs {
  constructor(prices, definitions = loadJobs()) {
    this.prices = prices;
    this.definitions = definitions;
  }

  list() {
    return Object.entries(this.definitions.jobs).map(([key, job]) => ({ key, label: job.label }));
  }

  /** A job by key or label ("front_pads_discs", "Front brake pads & discs"), or null. */
  find(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    for (const [key, job] of Object.entries(this.definitions.jobs)) {
      if (key === wanted || String(job.label).toLowerCase() === wanted) return { key, ...job };
    }
    return null;
  }

  job(key) {
    const job = this.definitions.jobs[key];
    if (!job) {
      throw new JlrError(`Unknown job "${key}". Known jobs: ${Object.keys(this.definitions.jobs).join(', ')}.`);
    }
    return job;
  }

  /** A registration or VIN and a job key -> every part line, priced, with review flags. */
  async price(input, key) {
    const job = this.job(key);
    const vehicle = await this.prices.vehicle(input);
    const lines = [];
    for (const want of job.parts) {
      const found = await this.pages(vehicle, want);
      const candidates = [];
      for (const p of found) {
        // Sequential, like the rest of the JLR code: a few calls, not a burst.
        const { parts } = await this.prices.pageParts(vehicle, p.id);
        for (const part of parts) if (matchesBase(part.callout, want.base)) candidates.push({ ...part, page: p.name });
      }
      lines.push({
        base: [want.base].flat().join('/'),
        name: want.name,
        pages: found.map((p) => p.name),
        // No page at all usually means the vehicle has no such part (spark
        // plugs on a diesel); a page without the part means the hints are off.
        ...(found.length === 0
          ? { status: 'no_page', rule: 'no_page', parts: [], alternatives: [], reason: 'No catalogue page for this on this vehicle.' }
          : candidates.length === 0 && otherEngine(found, want.engine)
            ? { status: 'no_page', rule: 'no_page', parts: [], alternatives: [], reason: `Only on ${want.engine} engines.` }
            : resolve(candidates, { ...want, avoid: [...(this.definitions.defaults?.avoid ?? []), ...(want.avoid ?? [])] })),
      });
    }

    const review = lines.filter((l) => l.status !== 'ok');
    return {
      supplier: 'jlr',
      job: key,
      label: job.label,
      registration: vehicle.registration,
      vin: vehicle.vin,
      vehicle: vehicle.description,
      lines,
      total: round(lines.flatMap((l) => l.parts).reduce((sum, p) => sum + p.lineTotal, 0)),
      needsReview: review.length > 0,
      reviewReason: review.length ? review.map((l) => `${l.name} (${l.base}): ${l.reason}`).join(' ') : null,
    };
  }

  /**
   * Pages to look on. With "sections", the EPC's section search finds them in
   * a call or two (then "pages" narrows, e.g. front vs rear). Without, the
   * vehicle's whole tree is walked - slow the first time on a vehicle.
   */
  async pages(vehicle, want) {
    if (!want.sections?.length) return pagesFor(await this.prices.hierarchy.pages(vehicle), want.pages);

    const byId = new Map();
    for (const phrase of want.sections) {
      for (const p of await this.prices.hierarchy.sections(vehicle, phrase)) if (!byId.has(p.id)) byId.set(p.id, p);
    }
    return pagesFor([...byId.values()], want.pages ?? want.sections);
  }
}

// ---------------------------------------------------------------- matching

/**
 * "19542A" is a 19542; "2B120" is not a 2B12. Callouts can carry a "<"
 * marker. A list of bases matches any of them (oil filter: 6731 or 6714).
 */
export function matchesBase(callout, base) {
  if (Array.isArray(base)) return base.some((b) => matchesBase(callout, b));
  const c = String(callout ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = String(base ?? '').toUpperCase();
  if (!b || !c.startsWith(b)) return false;
  return c.length === b.length || (c.length === b.length + 1 && /[A-Z]/.test(c.at(-1)));
}

/** Pages whose name has every word of any one phrase. */
export function pagesFor(pages, phrases = []) {
  return pages.filter((p) => {
    const have = new Set(words(p.name));
    return phrases.some((phrase) => words(phrase).every((w) => have.has(w)));
  });
}

/**
 * A part only one engine type has (glow plugs: diesel), and pages that are
 * all for a different one - JLR puts the engine in engine page names
 * ("2.0L 16V TIVCT T/C 240PS Petrol").
 */
function otherEngine(pages, engine) {
  if (!engine) return false;
  const want = engine.toLowerCase();
  return pages.every((p) => {
    const have = new Set(words(p.name));
    return !have.has(want) && (have.has('petrol') || have.has('diesel'));
  });
}

// ---------------------------------------------------------------- choosing

/**
 * Candidates for one base -> the part(s) to quote.
 *
 *   single           one part: nothing to choose
 *   pair             LH and RH of the same part: the job needs both
 *   preferred        the job's "prefer" words pick one (brake fluid: the 1 L)
 *   interchangeable  same description, same price: either will do
 *   review           a real choice - the cheapest is quoted provisionally
 *                    and staff confirm it
 *
 * JLR already filters the page to the VIN, so a part with a "to" VIN range
 * still fits this car; a range is not a reason to drop it.
 */
export function resolve(candidates, { prefer = [], avoid = [], require = [], qty = null } = {}) {
  // "require" is strict, unlike prefer/avoid: a wheel bearing job must never
  // quote a bare hub that shares the base number.
  let list = dedupe(quotable(candidates)).filter((p) => require.every((w) => hasWords(p, w)));

  if (list.length === 0) {
    return { status: 'missing', rule: 'missing', parts: [], alternatives: [], reason: 'No priced part with this base on the expected page.' };
  }

  list = narrow(list, (p) => !avoid.some((w) => hasWords(p, w)));
  const preferred = narrow(list, (p) => prefer.some((w) => hasWords(p, w)));
  const byPreference = preferred.length < list.length;
  list = preferred;

  const done = (rule, chosen, rest = [], reason = null) => ({
    status: rule === 'review' ? 'review' : 'ok',
    rule,
    parts: chosen.map((p) => line(p, qty)),
    alternatives: rest.map((p) => line(p, qty)),
    reason,
  });

  if (list.length === 1) return done(byPreference ? 'preferred' : 'single', list);

  // LH + RH: one of each side, otherwise the same part.
  const sides = list.map(side);
  if (sides.every(Boolean) && new Set(sides).size === 2 && list.length === 2 && sameDescription(list)) {
    return done('pair', list);
  }

  if (sameDescription(list) && new Set(list.map((p) => p.unitPrice)).size === 1) {
    // Prefer the part with no end of production - usually the newer number.
    const [chosen, ...rest] = [...list].sort((a, b) => ended(a) - ended(b));
    return done('interchangeable', [chosen], rest);
  }

  const [chosen, ...rest] = [...list].sort((a, b) => a.unitPrice - b.unitPrice);
  return done('review', [chosen], rest, `${list.length} JLR parts fit - confirm which (cheapest quoted).`);
}

/** Keep what passes the test, unless nothing would. */
function narrow(list, test) {
  const kept = list.filter(test);
  return kept.length > 0 ? kept : list;
}

function dedupe(parts) {
  const seen = new Map();
  for (const p of parts) if (!seen.has(p.partNumber)) seen.set(p.partNumber, p);
  return [...seen.values()];
}

function line(p, qty) {
  const quantity = qty ?? p.quantity ?? 1;
  return {
    partNumber: p.partNumber,
    description: p.description,
    callout: p.callout,
    notes: notes(p).join(', '),
    page: p.page ?? null,
    quantity,
    unitPrice: p.unitPrice,
    lineTotal: round(p.unitPrice * quantity),
  };
}

const notes = (p) => [...(p.features ?? []), ...(p.comments ?? [])].map(text).filter(Boolean);

function side(p) {
  const found = notes(p).map((n) => n.toUpperCase()).filter((n) => n === 'LH' || n === 'RH');
  return found.length === 1 ? found[0] : null;
}

const sameDescription = (list) => new Set(list.map((p) => String(p.description).toLowerCase())).size === 1;
const ended = (p) => ((p.toVin ?? []).length > 0 ? 1 : 0);

/** Every word of a phrase in the part's description, comments or features. "1 l" matches "1 L", not "500 ML". */
function hasWords(p, phrase) {
  const have = new Set(words([p.description, ...notes(p)].join(' ')));
  const want = words(phrase);
  return want.length > 0 && want.every((w) => have.has(w));
}

function words(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
}

function text(entry) {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.description ?? entry?.desc ?? entry?.featureDesc ?? entry?.comment ?? '').trim();
}

const round = (n) => Math.round(n * 100) / 100;

let cached = null;

/** jlr/data/jobs.json, read on first use. */
export function loadJobs() {
  if (cached) return cached;
  const file = path.join(jlrRoot, 'data', 'jobs.json');
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new JlrError(`${file} could not be read: ${error.message}`);
  }
  return cached;
}

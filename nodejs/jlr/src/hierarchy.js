/**
 * Turns a service name into the JLR catalogue page(s) that carry it.
 *
 *   "Oil Filter"  ->  Engine › Lubrication › Oil Filter  (catHieId 27576)
 *
 * GSF has one flat category map for every vehicle. JLR does not: the tree
 * comes back filtered to the VIN, so it is walked per vehicle, once, and
 * cached for JLR_TREE_TTL:
 *
 *   model catID (from vinDecode) -> major section -> minor section -> page
 *
 * About 200 requests for a typical model. Branches JLR marks not applicable
 * to the VIN are skipped.
 *
 * The walk is sequential and paced (JLR_WALK_DELAY_MS) and capped
 * (JLR_MAX_NODES). Warm a vehicle ahead of time with:
 *
 *   node --env-file=.env bin/jlr.js pages <reg|vin> --refresh
 *
 * Matching: an exact page label (what the picker sends) is that page. A
 * service name shortlists pages by name, and the part descriptions on them
 * decide - see matchPages() and describes(), and jlr/data/aliases.json.
 */

import fs from 'node:fs';
import path from 'node:path';

import { cache } from './cache.js';
import { config, jlrRoot } from './config.js';
import { JlrError } from './errors.js';

export const SEPARATOR = ' › ';
const MAX_DEPTH = 8;


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JlrHierarchy {
  constructor(catalogue) {
    this.catalogue = catalogue;
  }

  /** Every page (leaf) in this vehicle's tree: { id, name, path, label }. */
  async pages(vehicle, { refresh = false } = {}) {
    const key = `jlr:tree:${vehicle.vin}`;
    if (refresh) await cache.forget(key);
    return cache.remember(key, config.cache.treeTtl, () => this.walk(vehicle));
  }

  async walk(vehicle) {
    const pages = [];
    const seen = new Set();
    let visited = 0;

    const visit = async (nodes, trail, depth) => {
      for (const node of nodes) {
        if (seen.has(node.id) || node.applicable === false) continue;
        seen.add(node.id);

        const here = [...trail, node.name ?? String(node.id)];

        if (node.leaf === true || depth >= MAX_DEPTH) {
          pages.push(page(node, here));
          continue;
        }

        if (++visited > config.maxNodes) {
          throw new JlrError(
            `The JLR catalogue tree for ${vehicle.vin} exceeded ${config.maxNodes} nodes. ` +
              'Either leaf detection is wrong (check the nextLevelHierarchies response) or raise JLR_MAX_NODES.',
          );
        }

        if (config.walkDelayMs > 0) await sleep(config.walkDelayMs);
        const children = await this.catalogue.nextLevel(vehicle, node.id);

        // Pages are flagged by catHieType; an empty expansion is the fallback.
        if (children.length === 0) pages.push(page(node, here));
        else await visit(children, here, depth + 1);
      }
    };

    if (!vehicle.catalogueId) throw new JlrError(`No JLR catalogue ID for ${vehicle.vin}.`);

    const sections = await this.catalogue.nextLevel(vehicle, vehicle.catalogueId);
    if (sections.length === 0) {
      throw new JlrError(`JLR returned no catalogue sections for ${vehicle.vin} (catalogue ${vehicle.catalogueId}).`);
    }

    await visit(sections, [], 0);
    return pages;
  }

  /** The tree if it is already cached, else null. Never walks. */
  async cachedPages(vehicle) {
    return cache.get(`jlr:tree:${vehicle.vin}`);
  }

  /**
   * Pages whose name contains a phrase, from the EPC's own search: one call,
   * under a second, no tree walk. Every page found is remembered for the
   * vehicle so the picker's exact label resolves later without the tree.
   */
  async sections(vehicle, phrase) {
    const key = `jlr:sections:${vehicle.vin}:${normalise(phrase)}`;
    const found = await cache.remember(key, config.cache.treeTtl, () => this.catalogue.findSections(vehicle, phrase));
    await remember(vehicle, found);
    return found;
  }

  /**
   * Pages ranked against a free-text search, best first. A cached tree is
   * searched as before; otherwise the EPC's section search answers, with the
   * alias page phrases too ("oil filter" also looks for "oil cooler").
   */
  async search(vehicle, query, limit = 40) {
    const term = String(query ?? '').trim();
    const tree = await this.cachedPages(vehicle);

    if (tree) return term ? rank(tree, term).slice(0, limit).map(({ page: p }) => p) : tree.slice(0, limit);
    if (!term) return (await this.pages(vehicle)).slice(0, limit);

    const byId = new Map();
    for (const phrase of [term, ...ruleFor(term).pages]) {
      for (const p of await this.sections(vehicle, phrase)) if (!byId.has(p.id)) byId.set(p.id, p);
    }
    return [...byId.values()].slice(0, limit);
  }

  /** Where to look for a service: { exact, pages }. See matchPages(). */
  async resolve(vehicle, service) {
    // A label the picker got from section search is that page - no tree needed.
    const seen = (await cache.get(seenKey(vehicle))) ?? [];
    const exact = seen.filter((p) => p.label.toLowerCase() === String(service ?? '').trim().toLowerCase());
    if (exact.length > 0) return { exact: true, pages: exact };

    const all = await this.pages(vehicle);
    return matchPages(all, service);
  }
}

const seenKey = (vehicle) => `jlr:seen-pages:${vehicle.vin}`;

/** Add pages to the vehicle's list of pages found by section search. */
async function remember(vehicle, pages) {
  if (pages.length === 0) return;
  const seen = (await cache.get(seenKey(vehicle))) ?? [];
  const ids = new Set(seen.map((p) => p.id));
  const added = pages.filter((p) => !ids.has(p.id));
  if (added.length > 0) await cache.put(seenKey(vehicle), [...seen, ...added], config.cache.treeTtl);
}

// --------------------------------------------------------------- matching

/**
 * How many likely pages a service name is checked against. Each costs one
 * parts request (cached for JLR_PARTS_TTL), so this stays small.
 */
const SHORTLIST = 6;

/**
 * Pages to look on for a service: { exact, pages }.
 *
 * The picker sends an exact page label - that page, and only it. A service
 * name ("Brake Pads") is looser: JLR names pages after assemblies ("Front
 * Brake Discs And Calipers"), not after the part, so page names only
 * shortlist where to look. The part descriptions on those pages decide what
 * matches - see describes().
 */
export function matchPages(all, service) {
  const wanted = String(service ?? '').trim();
  if (!wanted) throw new JlrError('A service name is required.');

  const exact = all.filter((p) => p.label.toLowerCase() === wanted.toLowerCase());
  if (exact.length > 0) return { exact: true, pages: exact };

  const rule = ruleFor(wanted);
  const ranked = all
    .map((p) => ({ page: p, score: pageScore(p, wanted, rule) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.page.label.length - b.page.label.length);

  return { exact: false, pages: ranked.slice(0, SHORTLIST).map((r) => r.page) };
}

/**
 * Does a part answer a service? Every word of the service, or of one of its
 * alias phrases, must be in the description, and none of its exclusions:
 * "Filter - Oil" answers "Oil Filter", "Oil Cooler" does not, and "Pad -
 * Brake Pedal" does not answer "Brake Pads" because "pedal" is excluded.
 *
 * JLR often leaves the context to the page: on "Air Cleaner" the filter is
 * just "Element - Filter". An alias `context` entry covers that - on a page
 * whose label has these words, a part with those words counts.
 */
export function describes(text, service, pageLabel = '') {
  const have = new Set(tokens(text));
  const rule = ruleFor(service);

  if (rule.exclude.some((phrase) => containsAll(have, phrase))) return false;
  if ([service, ...rule.phrases].some((phrase) => containsAll(have, phrase))) return true;

  const page = new Set(tokens(pageLabel));
  return rule.context.some((c) => containsAll(page, c.page) && containsAll(have, c.part));
}

function containsAll(have, phrase) {
  const words = tokens(phrase);
  return words.length > 0 && words.every((w) => have.has(w));
}

/**
 * A whole phrase in the label scores high, single words a little, so "Air
 * Cleaner" outranks every page that merely mentions "air".
 */
function pageScore(p, service, rule) {
  const have = new Set(tokens(p.label));
  const phrases = [service, ...rule.phrases, ...rule.pages];

  let score = 0;
  for (const phrase of phrases) {
    const words = tokens(phrase);
    if (words.length === 0) continue;
    const hits = words.filter((w) => have.has(w)).length;
    score += hits === words.length ? 10 * words.length : hits;
  }
  return score;
}

/** Alias entry for a service: a list of phrases, or { phrases, pages, exclude, context }. */
function ruleFor(service) {
  const entry = aliases()[normalise(service)];
  if (Array.isArray(entry)) return { phrases: entry, pages: [], exclude: [], context: [] };
  return {
    phrases: entry?.phrases ?? [],
    // Context pages are also where to look.
    pages: [...(entry?.pages ?? []), ...(entry?.context ?? []).map((c) => c.page)],
    exclude: entry?.exclude ?? [],
    context: entry?.context ?? [],
  };
}

/** Picker search: pages containing every word of the query (or an alias). */
function rank(all, query) {
  const phrases = [query, ...ruleFor(query).phrases];

  return all
    .map((p) => ({ page: p, score: Math.max(...phrases.map((phrase) => score(p, phrase))) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.page.label.localeCompare(b.page.label));
}

/**
 * Share of the phrase's words found in the page name (full weight) or only
 * in its path (half weight). Every word must appear somewhere, or it is not
 * a match at all - "oil filter" must not match "Fuel Filter".
 */
function score(p, phrase) {
  const words = tokens(phrase);
  if (words.length === 0) return 0;

  const name = new Set(tokens(p.name));
  const trail = new Set(tokens(p.path.join(' ')));

  let total = 0;
  for (const word of words) {
    if (name.has(word)) total += 1;
    else if (trail.has(word)) total += 0.5;
    else return 0;
  }

  // Tighter names rank first: "Oil Filter" beats "Oil Filter Housing Gasket".
  return total / words.length + 1 / (1 + name.size);
}

const normalise = (text) => tokens(text).join(' ');

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function page(node, trail) {
  return { id: node.id, name: node.name ?? String(node.id), path: trail, label: trail.join(SEPARATOR) };
}

let aliasCache = null;

/** jlr/data/aliases.json, read on first use. A broken file is an error, not silence. */
function aliases() {
  if (aliasCache) return aliasCache;

  const file = path.join(jlrRoot, 'data', 'aliases.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return (aliasCache = {});
    throw new JlrError(`${file} could not be read: ${error.message}`);
  }

  aliasCache = Object.fromEntries(
    Object.entries(raw.aliases ?? {}).map(([service, rule]) => [normalise(service), rule]),
  );
  return aliasCache;
}

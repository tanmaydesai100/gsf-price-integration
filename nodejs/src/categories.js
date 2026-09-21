/**
 * Turns the category a user picks into the componentId the parts endpoint wants.
 * Mirrors laravel/app/Services/Gsf/GsfCategoryMap.php.
 *
 *   "Wipers"  ->  867
 *
 * The map is generated ONCE and stored as a flat JSON file:
 *
 *   node bin/gsf.js categories --export
 *
 * A normal price lookup reads that file and never touches /api/menus. That
 * keeps every quote down to two HTTP calls.
 *
 * Resolution order:
 *   1. the JSON file          (normal operation - no network)
 *   2. the cache              (if the file is missing)
 *   3. live /api/menus        (last resort; also what --export calls)
 *
 * The rule the export relies on, established during the investigation:
 *
 *   lastMenuNodeId (menu tree)  ==  componentId (parts call)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cache } from './cache.js';
import { config } from './config.js';
import { GsfError } from './errors.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const categoriesPath = () => config.categoriesFile || path.join(pkgRoot, 'data', 'categories.json');

const key = (caption) => String(caption).trim().replace(/\s+/g, ' ').toLowerCase();

export class GsfCategoryMap {
  #memo = null;

  constructor(client) {
    this.client = client;
  }

  /** { wipers: 867, 'wiper motor': 924, ... } */
  async all() {
    if (this.#memo) return this.#memo;

    const fromFile = await this.#fromFile();
    if (fromFile) {
      this.#memo = fromFile;
      return this.#memo;
    }

    this.#memo = await cache.remember(config.cache.menusKey, config.cache.menusTtl, () =>
      this.#fromApi(),
    );
    return this.#memo;
  }

  async componentId(category) {
    const map = await this.all();
    const hit = map[key(category)];
    if (hit) return hit;

    const suggestions = (await this.suggest(category)).slice(0, 8);
    throw new GsfError(
      `Unknown GSF category "${category}". Closest matches: ${suggestions.join(', ') || 'none'}. ` +
        '(If the catalogue changed, run: node bin/gsf.js categories --export)',
    );
  }

  async has(category) {
    return Boolean((await this.all())[key(category)]);
  }

  /** Fuzzy match - for error messages and for an admin category picker. */
  async suggest(needle) {
    const wanted = key(needle);
    if (!wanted) return [];
    return Object.keys(await this.all()).filter((caption) => caption.includes(wanted));
  }

  // ------------------------------------------------------------- generation

  /**
   * Fetch the live tree and write it to the category file.
   * Called by `node bin/gsf.js categories --export`. Not on the hot path.
   *
   * @returns {Promise<number>} number of categories written
   */
  async export(target = null) {
    const map = await this.#fromApi();
    const file = target || categoriesPath();

    const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${JSON.stringify(
        {
          _generated: new Date().toISOString(),
          _source: `${config.baseUrl.replace(/\/+$/, '')}/api/menus`,
          _note:
            'key = lowercased GSF menu caption, value = componentId (lastMenuNodeId). ' +
            'Regenerate with: node bin/gsf.js categories --export',
          categories: sorted,
        },
        null,
        4,
      )}\n`,
    );

    this.#memo = sorted;
    await cache.forget(config.cache.menusKey);

    return Object.keys(sorted).length;
  }

  async forget() {
    this.#memo = null;
    await cache.forget(config.cache.menusKey);
  }

  // ---------------------------------------------------------------- sources

  async #fromFile() {
    try {
      const decoded = JSON.parse(await fs.readFile(categoriesPath(), 'utf8'));
      const map = decoded?.categories;
      if (!map || Object.keys(map).length === 0) return null;

      return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Number.parseInt(v, 10)]));
    } catch {
      return null;
    }
  }

  async #fromApi() {
    const tree = (await this.client.get('/api/menus')).json();

    const map = {};
    walk(tree?.popularCategories ?? [], map);
    walk(tree?.featured ?? [], map);

    if (Object.keys(map).length === 0) {
      throw new GsfError('/api/menus returned no usable category nodes.');
    }

    return map;
  }
}

function walk(node, map) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, map);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const caption = String(node.caption ?? '').trim();
  const componentId = Number.parseInt(node.lastMenuNodeId ?? 0, 10) || 0;

  // Only leaf nodes carry a non-zero lastMenuNodeId; parent groups are 0.
  // First write wins, so the canonical path is kept over duplicates elsewhere
  // in the tree (both "Wipers" entries map to 867 anyway).
  if (caption && componentId > 0) {
    const k = caption.trim().replace(/\s+/g, ' ').toLowerCase();
    map[k] ??= componentId;
  }

  walk(node.children ?? [], map);
}

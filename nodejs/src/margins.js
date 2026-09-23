/**
 * Per-category margin, from data/margins.json.
 *
 *   node bin/quote.js margins            # what every rate is
 *   node bin/quote.js margins oil        # rates for categories matching "oil"
 *
 * GSF has 668 categories and nobody is setting 668 rates by hand, so the file
 * is a default plus the exceptions you actually care about. A category that is
 * not listed uses defaultPercent.
 *
 * The file is re-read whenever it changes on disk, so editing a rate takes
 * effect on the next quotation without restarting the server - which is the
 * point of it being a file rather than an environment variable.
 *
 * Changing a rate NEVER moves a quotation that already exists: every line
 * stores the rate it was priced at.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const marginsPath = () =>
  process.env.GSF_MARGINS_FILE || path.join(pkgRoot, 'data', 'margins.json');

const key = (category) => String(category ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

let cached = null;
let cachedAt = 0;

export const margins = {
  /** { defaultPercent, categories } - reloaded when the file changes. */
  async all() {
    const file = marginsPath();

    let modified = 0;
    try {
      modified = (await fs.stat(file)).mtimeMs;
    } catch {
      // No file: fall back to the configured default rather than failing a
      // quotation over a missing config file.
      return { defaultPercent: config.markupPercent, categories: {} };
    }

    if (cached && modified === cachedAt) return cached;

    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));

      const categories = {};
      for (const [name, percent] of Object.entries(parsed.categories ?? {})) {
        const value = Number.parseFloat(percent);
        if (Number.isFinite(value)) categories[key(name)] = value;
      }

      cached = {
        defaultPercent: Number.isFinite(Number.parseFloat(parsed.defaultPercent))
          ? Number.parseFloat(parsed.defaultPercent)
          : config.markupPercent,
        categories,
      };
      cachedAt = modified;
    } catch (error) {
      // A typo in the file must not silently reprice everything at 0%.
      console.error(`gsf: data/margins.json could not be read (${error.message}); using defaults`);
      return { defaultPercent: config.markupPercent, categories: {} };
    }

    return cached;
  },

  /** The rate for one category, falling back to the default. */
  async forCategory(category) {
    const { defaultPercent, categories } = await this.all();
    return categories[key(category)] ?? defaultPercent;
  },

  async forget() {
    cached = null;
    cachedAt = 0;
  },
};

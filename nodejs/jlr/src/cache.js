/**
 * A small JSON file cache for JLR lookups, kept inside jlr/.cache so this
 * integration shares no state with GSF.
 *
 * Holds registration -> VIN, each vehicle's catalogue tree, and short-lived
 * parts pages. None of it is a credential; the browser profile holds those.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

const fileFor = (key) =>
  path.join(config.cache.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);

// Two requests for the same key at once share one computation, so a first
// search on a vehicle cannot start the same tree walk twice.
const inFlight = new Map();

export const cache = {
  async get(key) {
    try {
      const entry = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
      if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
      return entry.value;
    } catch {
      return null;
    }
  },

  async put(key, value, ttlSeconds) {
    await fs.mkdir(config.cache.dir, { recursive: true });
    const target = fileFor(key);
    const tmp = `${target}.${process.pid}.tmp`;
    const entry = { key, expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null, value };
    await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(tmp, target);
  },

  async forget(key) {
    await fs.rm(fileFor(key), { force: true });
  },

  async remember(key, ttlSeconds, compute) {
    if (ttlSeconds <= 0) return compute();

    const hit = await this.get(key);
    if (hit !== null && hit !== undefined) return hit;

    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      const value = await compute();
      await this.put(key, value, ttlSeconds);
      return value;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, pending);
    return pending;
  },
};

/**
 * The Laravel version leans on Cache:: and Cache::lock(). Node has no
 * equivalent, so this is the small piece of it we actually need:
 *
 *   get / put / forget      - TTL'd key-value
 *   lock                    - so ten concurrent 401s produce ONE login
 *
 * File store by default, so this runs with nothing installed. Set REDIS_URL
 * and it uses Redis instead, which is what you want in production: with a
 * per-process store, every worker logs in to GSF separately.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- file store

class FileStore {
  constructor(dir) {
    this.dir = dir;
  }

  #path(key) {
    // Keys contain ':' and regs; hash so they are always valid filenames.
    return path.join(this.dir, `${createHash('sha1').update(key).digest('hex')}.json`);
  }

  async get(key) {
    try {
      const raw = JSON.parse(await fs.readFile(this.#path(key), 'utf8'));
      if (raw.expiresAt && raw.expiresAt < Date.now()) {
        await this.forget(key);
        return null;
      }
      return raw.value;
    } catch {
      return null;
    }
  }

  async put(key, value, ttlSeconds) {
    await fs.mkdir(this.dir, { recursive: true });
    const payload = JSON.stringify({
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
      value,
    });
    // Write-then-rename so a crash mid-write cannot leave a half file that
    // later parses as valid-but-truncated JSON.
    const target = this.#path(key);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  async forget(key) {
    await fs.rm(this.#path(key), { force: true });
  }

  /** Exclusive create is atomic on a local filesystem. */
  async acquire(name, ttlSeconds) {
    await fs.mkdir(this.dir, { recursive: true });
    const lockPath = path.join(this.dir, `${createHash('sha1').update(name).digest('hex')}.lock`);

    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(String(Date.now() + ttlSeconds * 1000));
      await handle.close();
      return () => fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      // Stale lock from a process that died before releasing.
      const expiresAt = Number.parseInt(await fs.readFile(lockPath, 'utf8').catch(() => '0'), 10);
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        await fs.rm(lockPath, { force: true });
      }
      return null;
    }
  }
}

// --------------------------------------------------------------- redis store

class RedisStore {
  constructor(client) {
    this.client = client;
  }

  async get(key) {
    const raw = await this.client.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async put(key, value, ttlSeconds) {
    const raw = JSON.stringify(value);
    if (ttlSeconds > 0) await this.client.set(key, raw, 'EX', ttlSeconds);
    else await this.client.set(key, raw);
  }

  async forget(key) {
    await this.client.del(key);
  }

  async acquire(name, ttlSeconds) {
    const token = randomUUID();
    const ok = await this.client.set(name, token, 'NX', 'PX', ttlSeconds * 1000);
    if (!ok) return null;

    return async () => {
      // Only release a lock we still own, or we could free someone else's.
      const script =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await this.client.eval(script, 1, name, token);
    };
  }
}

// ------------------------------------------------------------------- facade

let store = null;

async function resolveStore() {
  if (store) return store;

  if (config.cache.redisUrl) {
    let Redis;
    try {
      ({ default: Redis } = await import('ioredis'));
    } catch {
      throw new Error('REDIS_URL is set but ioredis is not installed. Run: npm install ioredis');
    }
    store = new RedisStore(new Redis(config.cache.redisUrl));
  } else {
    store = new FileStore(config.cache.dir || path.join(pkgRoot, '.cache'));
  }

  return store;
}

export const cache = {
  async get(key) {
    return (await resolveStore()).get(key);
  },

  async put(key, value, ttlSeconds) {
    return (await resolveStore()).put(key, value, ttlSeconds);
  },

  async forget(key) {
    return (await resolveStore()).forget(key);
  },

  /** Cache::remember - return the cached value, or compute and store it. */
  async remember(key, ttlSeconds, compute) {
    if (ttlSeconds <= 0) return compute();

    const hit = await this.get(key);
    if (hit !== null && hit !== undefined) return hit;

    const value = await compute();
    await this.put(key, value, ttlSeconds);
    return value;
  },

  /**
   * Cache::lock(...)->block(...). Resolves to a release function, or throws
   * if another holder does not finish in time.
   */
  async lock(name, ttlSeconds = 60, waitSeconds = 30) {
    const backing = await resolveStore();
    const deadline = Date.now() + waitSeconds * 1000;

    for (;;) {
      const release = await backing.acquire(name, ttlSeconds);
      if (release) return release;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock "${name}".`);
      }
      await sleep(250);
    }
  },
};

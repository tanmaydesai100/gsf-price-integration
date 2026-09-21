#!/usr/bin/env node
/**
 * Mirrors the two artisan commands:
 *   laravel/app/Console/Commands/GsfPriceCommand.php
 *   laravel/app/Console/Commands/GsfCategoriesCommand.php
 *
 *   node bin/gsf.js price P44PYN Wipers --brand=BOSCH
 *   node bin/gsf.js price P44PYN Wipers --all
 *   node bin/gsf.js price --whoami
 *   node bin/gsf.js price --logout          (forces a fresh login next call)
 *
 *   node bin/gsf.js categories --export     # regenerate the JSON file
 *   node bin/gsf.js categories wiper        # search the map
 *   node bin/gsf.js categories --count
 */

import { parseArgs } from 'node:util';

import { GsfCategoryMap } from '../src/categories.js';
import { GsfClient } from '../src/client.js';
import { GsfAuthError, GsfBlockedError, GsfError } from '../src/errors.js';
import { GsfPriceService } from '../src/priceService.js';

const USAGE = `
GSF TradeHub trade-price lookup (read-only)

  gsf price <reg> [category]    Look up a price          (category default: Wipers)
      --brand=BOSCH             Preferred brand
      --fitment=Front           Front, Rear, or "any"
      --prefer=availability     availability (default) or price
      --all                     List every candidate instead of picking one
      --whoami                  Show the current GSF session
      --logout                  Clear the cached cookie jar

  gsf categories [search]       Search the category -> componentId map
      --export                  Fetch the live tree and rewrite the file
      --path=<file>             Write somewhere other than data/categories.json
      --count                   Just print how many categories are loaded
`.trim();

const options = {
  brand: { type: 'string' },
  fitment: { type: 'string', default: 'Front' },
  prefer: { type: 'string' },
  path: { type: 'string' },
  all: { type: 'boolean', default: false },
  whoami: { type: 'boolean', default: false },
  logout: { type: 'boolean', default: false },
  export: { type: 'boolean', default: false },
  count: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const print = (value) => console.log(JSON.stringify(value, null, 2));

async function price(args, values) {
  const client = new GsfClient();

  if (values.logout) {
    await client.forgetSession();
    console.log('Cached GSF session cleared.');
    return 0;
  }

  if (values.whoami) {
    print(await client.sessionInfo());
    return 0;
  }

  const [reg, category = 'Wipers'] = args;
  if (!reg) {
    console.error('A registration is required.');
    return 1;
  }

  const fitment = values.fitment === 'any' ? null : values.fitment;
  const prices = new GsfPriceService(client);

  if (values.all) {
    const rows = await prices.listParts(reg, category, fitment);
    console.table(
      rows.map((r) => ({
        SKU: r.sku,
        Brand: r.brand,
        Fit: r.fitment,
        Group: r.fitmentGroup,
        Trade: r.tradePrice,
        RRP: r.rrp,
        Availability: r.availability,
      })),
    );
    console.log(`${rows.length} candidates.`);
    return 0;
  }

  const result = await prices.getPartPrice(reg, category, values.brand ?? null, fitment, values.prefer ?? null);
  print(result);

  if (result.needsReview) {
    console.warn(`\nNEEDS REVIEW: ${result.reviewReason}`);
  }

  return result.found ? 0 : 1;
}

async function categories(args, values) {
  const map = new GsfCategoryMap(new GsfClient());

  if (values.export) {
    const target = values.path || null;
    console.log('Fetching /api/menus ...');
    const written = await map.export(target);
    console.log(`Wrote ${written} categories.`);
    console.log('Commit this file. Price lookups now read it from disk.');
    return 0;
  }

  const all = await map.all();

  if (values.count) {
    console.log(Object.keys(all).length);
    return 0;
  }

  const [search] = args;
  if (search) {
    const hits = await map.suggest(search);
    if (hits.length === 0) {
      console.warn(`No category matches "${search}".`);
      return 1;
    }
    console.table(hits.map((c) => ({ Category: c, componentId: all[c] })));
    return 0;
  }

  console.log(`${Object.keys(all).length} categories loaded. Pass a search term to filter.`);
  console.log('Example: node bin/gsf.js categories wiper');
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'price':
      return price(rest, values);
    case 'categories':
      return categories(rest, values);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof GsfBlockedError) {
    console.error(`\nBLOCKED: ${error.message}`);
    console.error('Do not loop retries - that escalates the block.');
  } else if (error instanceof GsfAuthError) {
    console.error(`\nAUTH FAILED: ${error.message}`);
  } else if (error instanceof GsfError) {
    console.error(`\nGSF ERROR: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * JLR counterpart to bin/gsf.js.
 *
 *   node --env-file=.env bin/jlr.js login                    # sign in, cache the session
 *   node --env-file=.env bin/jlr.js vehicle WL61RZO
 *   node --env-file=.env bin/jlr.js pages WL61RZO "oil filter"
 *   node --env-file=.env bin/jlr.js pages WL61RZO --refresh     # re-walk the tree
 *   node --env-file=.env bin/jlr.js parts WL61RZO 27576
 *   node --env-file=.env bin/jlr.js price WL61RZO "Oil Filter"
 *   node --env-file=.env bin/jlr.js raw nextLevel '{"vin":"...","catHieId":24}'
 *
 * Anywhere a registration is taken, a VIN works too.
 */

import { parseArgs } from 'node:util';

import { bodies, JlrCatalogue, PATHS } from '../jlr/src/catalogue.js';
import { JlrClient } from '../jlr/src/client.js';
import { JlrAuthError, JlrError, JlrUpstreamError } from '../jlr/src/errors.js';
import { JlrJobs } from '../jlr/src/jobs.js';
import { JlrPriceService } from '../jlr/src/priceService.js';

const USAGE = `
JLR EPC parts-price lookup (read-only)

  jlr login                         Sign in now and cache the session
  jlr whoami                        Show the cached session (no network)
  jlr logout                        Forget the cached session
  jlr vehicle <reg|vin>             Registration -> VIN, description, feature codes
  jlr pages <reg|vin> [search]      Catalogue pages for the vehicle (walks the tree once)
      --refresh                     Discard the cached tree and walk it again
  jlr parts <reg|vin> <pageId>      Every part on one catalogue page
  jlr price <reg|vin> <service>     Price a service, as a quotation line would
      --all                         List every part on the matching pages instead
  jlr jobs                          List the customer-facing jobs (jlr/data/jobs.json)
  jlr job <reg|vin> <job>           Price one job: parts by callout base, review flags
  jlr check <reg|vin>...            Every job on each vehicle, one table - confirms
                                    the base numbers hold on those catalogues
  jlr raw <call> [json]           Send one catalogue call and print the raw reply.
                                    <call> is vinDecode, nextLevel or parts;
                                    [json] replaces the built body.
`.trim();

const options = {
  refresh: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const print = (value) => console.log(JSON.stringify(value, null, 2));

async function run(command, args, values, prices) {
  const [input, ...rest] = args;
  const needInput = () => {
    if (!input) throw new JlrError('A registration or VIN is required.');
  };

  const auth = prices.catalogue.client.auth;

  switch (command) {
    case 'login': {
      print(await auth.login());
      return 0;
    }

    case 'whoami': {
      print(await auth.whoami());
      return 0;
    }

    case 'logout': {
      await auth.logout();
      console.log('Cached JLR session cleared.');
      return 0;
    }

    case 'vehicle': {
      needInput();
      print(await prices.vehicle(input));
      return 0;
    }

    case 'pages': {
      needInput();
      const vehicle = await prices.vehicle(input);
      if (values.refresh) console.error('Walking the JLR catalogue tree - this can take a minute or two ...');
      const all = await prices.hierarchy.pages(vehicle, { refresh: values.refresh });
      const shown = rest[0] ? await prices.hierarchy.search(vehicle, rest[0], 50) : all;
      console.table(shown.map((p) => ({ ID: p.id, Page: p.label })));
      console.log(`${shown.length} of ${all.length} pages for ${vehicle.vin}.`);
      return 0;
    }

    case 'parts': {
      needInput();
      const [pageId] = rest;
      if (!pageId) throw new JlrError('A catalogue page ID is required.');
      const vehicle = await prices.vehicle(input);
      const result = await prices.pageParts(vehicle, pageId);
      console.log(`${result.category ?? 'Page'} (${result.catalogueId}) for ${vehicle.vin}`);
      console.table(result.parts.map(row));
      return 0;
    }

    case 'price': {
      needInput();
      const service = rest.join(' ');
      if (!service) throw new JlrError('A service name is required, e.g. "Oil Filter".');

      if (values.all) {
        const rows = await prices.listParts(input, service);
        console.table(rows.map((r) => ({ Page: r.page, ...row(r) })));
        console.log(`${rows.length} parts.`);
        return 0;
      }

      const result = await prices.getPartPrice(input, service);
      print(result);
      if (result.needsReview) console.warn(`\nNEEDS REVIEW: ${result.reviewReason}`);
      return result.found ? 0 : 1;
    }

    case 'jobs': {
      console.table(new JlrJobs(prices).list());
      return 0;
    }

    case 'job': {
      needInput();
      const [key] = rest;
      if (!key) throw new JlrError('A job key is required - see `jlr jobs`.');
      const result = await new JlrJobs(prices).price(input, key);
      console.log(`${result.label} - ${result.vehicle} (${result.vin})`);
      console.table(
        result.lines.flatMap((l) =>
          [...l.parts, ...l.alternatives.map((a) => ({ ...a, alternative: true }))].map((p) => ({
            Base: l.base,
            Rule: p.alternative ? '  (alt)' : l.rule,
            Part: p.partNumber,
            Description: p.description,
            Notes: p.notes,
            Qty: p.quantity,
            Unit: p.unitPrice,
            Total: p.alternative ? '' : p.lineTotal,
          })),
        ),
      );
      for (const l of result.lines.filter((x) => x.status === 'missing')) console.log(`MISSING ${l.base} ${l.name} - pages searched: ${l.pages.join('; ') || 'none matched'}`);
      console.log(`Total (trade): £${result.total.toFixed(2)}`);
      if (result.needsReview) console.warn(`\nNEEDS REVIEW: ${result.reviewReason}`);
      return 0;
    }

    case 'check': {
      if (args.length === 0) throw new JlrError('One or more registrations or VINs are required.');
      const jobs = new JlrJobs(prices);
      const rows = [];
      for (const vehicleInput of args) {
        const vehicle = await prices.vehicle(vehicleInput);
        console.error(`Checking ${vehicle.description} (${vehicle.vin}) ...`);
        for (const { key } of jobs.list()) {
          const r = await jobs.price(vehicleInput, key);
          for (const l of r.lines) {
            rows.push({
              Vehicle: vehicle.description?.match(/\(([A-Z0-9]+)\)/)?.[1] ?? vehicle.vin,
              Job: key,
              Base: l.base,
              Result: l.status === 'ok' ? `ok (${l.rule})` : l.status.toUpperCase(),
              Parts: l.parts.map((p) => `${p.partNumber} x${p.quantity}`).join(', '),
              Alts: l.alternatives.map((p) => p.partNumber).join(', '),
              Price: l.parts.reduce((s, p) => s + p.lineTotal, 0).toFixed(2),
            });
          }
        }
      }
      console.table(rows);
      const count = (s) => rows.filter((r) => r.Result === s).length;
      const ok = rows.filter((r) => r.Result.startsWith('ok')).length;
      console.log(
        `${ok}/${rows.length} resolved automatically; ${count('REVIEW')} review, ${count('MISSING')} missing, ` +
          `${count('NO_PAGE')} not on the vehicle (no page).`,
      );
      return 0;
    }

    case 'raw': {
      const [call, json] = args;
      if (!PATHS[call]) throw new JlrError(`Unknown call "${call}". Use one of: ${Object.keys(PATHS).join(', ')}.`);
      const body = json ? JSON.parse(json) : bodies[call]({});
      console.error(`POST ${PATHS[call]}\n${JSON.stringify(body)}\n`);
      print(await prices.catalogue.raw(PATHS[call], body));
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

function row(part) {
  return {
    Callout: part.callout,
    Part: part.partNumber,
    Description: part.description,
    Qty: part.quantity,
    Price: part.unitPrice,
    Applicable: part.applicable,
  };
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

  const client = new JlrClient();
  try {
    return await run(command, rest, values, new JlrPriceService(new JlrCatalogue(client)));
  } finally {
    await client.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof JlrAuthError) {
    console.error(`\nAUTH FAILED: ${error.message}`);
  } else if (error instanceof JlrUpstreamError) {
    console.error(`\nJLR ERROR: ${error.message}`);
  } else if (error instanceof JlrError) {
    console.error(`\n${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

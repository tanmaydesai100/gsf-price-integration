# GSF price lookup — Node

The same read-only lookup as `laravel/`, in Node. Use whichever matches the
app this is going into; they are independent and neither calls the other.

Node 18+. Two dependencies: `got` and `tough-cookie`.

## Setup

```bash
npm install
cp .env.example .env          # fill in GSF_EMAIL, GSF_PASSWORD, GSF_APP_KEY
```

`GSF_APP_KEY` encrypts the cached session cookie at rest. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Use it

```js
import { GsfPriceService } from './src/index.js';

const result = await new GsfPriceService().getPartPrice('P44PYN', 'Wipers', 'BOSCH');
// { found: true, brand: 'BOSCH', sku: 'BOSAR550S', tradePrice: 20.90,
//   availability: 'Immediate', needsReview: true, ... }
```

## CLI

Mirrors the artisan commands:

```bash
node bin/gsf.js price --whoami                     # check the session
node bin/gsf.js categories --export                # build the category map, once
node bin/gsf.js price P44PYN Wipers --brand=BOSCH
node bin/gsf.js price P44PYN Wipers --all          # every candidate
node bin/gsf.js price --logout                     # force a fresh login
```

## HTTP route

`snippets/route-express.js` is an Express router mounting
`POST /api/gsf/part-price`. Keep it behind auth — it returns trade cost.

```js
app.use('/api/gsf', requireAuth, rateLimit({ windowMs: 60_000, max: 30 }), gsfRouter);
```

Needs `express` installed; it is not a dependency of this package.

## Tests

```bash
npm test
```

Nine tests over the selection rules, run against a fixture — no network. They
pin the behaviour that costs money if it drifts: unpriced and out-of-stock
parts are never quoted, alternatives stay inside one fitment group, and
multiple fitment groups set `needsReview`.

## Cache

File-based in `.cache/` by default, so it runs with nothing installed.

**Set `REDIS_URL` in production.** With a per-process cache every worker keeps
its own cookie jar and logs in separately, which is what the login lock exists
to prevent. `npm install ioredis` to enable it.

## Map to the Laravel version

| Node | Laravel |
|---|---|
| `src/client.js` | `GsfClient.php` |
| `src/categories.js` | `GsfCategoryMap.php` |
| `src/priceService.js` | `GsfPriceService.php` |
| `src/errors.js` | `Exceptions/` |
| `src/config.js` | `config/gsf.php` |
| `src/cache.js` | Laravel's `Cache::` / `Cache::lock()` |
| `bin/gsf.js` | the two artisan commands |
| `snippets/route-express.js` | `GsfPriceController.php` + `routes-api.php` |
| `data/categories.json` | `storage/app/gsf/categories.json` |

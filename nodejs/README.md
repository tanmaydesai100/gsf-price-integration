# GSF price lookup — Node

The same read-only lookup as `laravel/`, in Node. Use whichever matches the
app this is going into; they are independent and neither calls the other.

Two dependencies: `got` and `tough-cookie`.

**Node 18+ to run the library. Node 20.6+ to use the commands below as
written**, because nothing in this package loads `.env` — there is no
`dotenv`, and `src/config.js` reads `process.env` directly. The commands rely
on Node's built-in `--env-file` flag instead. On Node 18, export the variables
yourself (see [Without `--env-file`](#without---env-file)).

## Quick start

```bash
cd nodejs
node -v                                  # need v20.6.0 or newer
npm ci
npm test                                 # 11 tests, no network, ~0.3s

cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Open `.env` and set:

| Variable | Value |
|---|---|
| `GSF_EMAIL` | your TradeHub login |
| `GSF_APP_KEY` | the base64 string printed above |
| `GSF_PASSWORD` | leave **empty** — see [Credentials](#credentials) |

Then sign in once and check it worked:

```bash
GSF_PASSWORD='your-password' node --env-file=.env bin/gsf.js price --whoami
```

Expect `gsf: signed in, cookie jar cached` on stderr, then your session as
JSON. From here on the password is not needed — see [Sessions](#sessions).

```bash
node --env-file=.env bin/gsf.js price P44PYN "Oil Filter"
```

## Credentials

`.env` is gitignored, but a password in a file is still a password on disk.
Prefer your OS keychain and inject it only for the one command that needs it.

macOS:

```bash
security add-generic-password -a "$USER" -s gsf-tradehub -w   # prompts, no shell history

GSF_PASSWORD=$(security find-generic-password -a "$USER" -s gsf-tradehub -w) \
  node --env-file=.env bin/gsf.js price --whoami
```

Linux, with `libsecret`:

```bash
secret-tool store --label='GSF TradeHub' service gsf-tradehub

GSF_PASSWORD=$(secret-tool lookup service gsf-tradehub) \
  node --env-file=.env bin/gsf.js price --whoami
```

A shell-provided variable overrides `--env-file`, so this works with
`GSF_PASSWORD=` left blank in `.env`. The `VAR=value command` form scopes the
variable to that single process — it never enters your environment, so there
is nothing to unset afterwards.

Never put credentials in source, and never commit a filled-in `.env`.

**On a server the password must be reachable by the process** (secret manager
or injected env), or the integration stops the first time the session drops
and cannot log back in.

## Sessions

There is no bearer token. Auth is a NextAuth session cookie, and the client
logs in itself — you never copy a cookie from a browser.

The jar is cached encrypted (AES-256-GCM, keyed by `GSF_APP_KEY`) and reused
for **every** later call, across processes and restarts, for 14 days
(`GSF_COOKIE_TTL`). It re-authenticates only on a 401, or after `--logout`.

So the everyday command needs no password at all:

```bash
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads"
```

To confirm reuse rather than assume it: run any command twice. The
`gsf: signed in, cookie jar cached` line appears on the first run only.

Keep `GSF_APP_KEY` stable across deploys. Change it and the cached jar fails
its auth tag, gets discarded, and every call logs in again.

## CLI

```bash
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads"
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads" --all
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads" --brand=BREMBO
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads" --fitment="Front Axle"
node --env-file=.env bin/gsf.js price P44PYN "Brake Pads" --prefer=price

node --env-file=.env bin/gsf.js price --whoami       # who am I signed in as
node --env-file=.env bin/gsf.js price --logout       # force a fresh login
```

`price` exits 0 when a part is found, 1 when nothing is quotable.

Worth a shell function in `~/.zshrc` or `~/.bashrc`:

```bash
gsf() {
  local N=/absolute/path/to/gsf-price-integration/nodejs
  node --env-file="$N/.env" "$N/bin/gsf.js" "$@"
}
```

Then `gsf price P44PYN "Oil Filter"` from anywhere.

### Without `--env-file`

Node 18, or a setup that already manages env vars:

```bash
set -a; source .env; set +a
node bin/gsf.js price P44PYN "Oil Filter"
```

## Categories

`data/categories.json` maps a category name to the `componentId` the parts
endpoint needs (`"wipers"` → `867`). It is committed with all 668 categories,
so **a fresh clone needs no export** and a price lookup never touches
`/api/menus`.

Names must match the catalogue exactly — it is `Batteries (Applicated)`, not
`Batteries`. Search the map offline:

```bash
node --env-file=.env bin/gsf.js categories brake
node --env-file=.env bin/gsf.js categories --count
```

An unknown name fails with the closest matches listed. Regenerate only if the
catalogue changes:

```bash
node --env-file=.env bin/gsf.js categories --export   # needs a live session
```

## Fitment

**The catalogue's fitment labels are not consistent between categories.**
Observed values:

| Category | Fitment values |
|---|---|
| Wipers | `Front`, `Rear` |
| Brakes | `Front Axle`, `Rear Axle` |
| Filters | `N/A` |
| Batteries | *(empty string)* |

`--fitment` therefore defaults to **all fitments**. Passing the wrong label
returns nothing rather than erroring, so omit it unless you know the exact
string for that category.

The cost of returning everything is that front and rear come back together,
which is two fitment groups, which sets `needsReview: true`. That is correct
— the catalogue cannot tell you which axle you meant.

## Reading the result

```js
import { GsfPriceService } from './src/index.js';

const r = await new GsfPriceService().getPartPrice('P44PYN', 'Wipers', 'BOSCH');
// { found: true, brand: 'BOSCH', sku: 'BOSA381H', tradePrice: 9.40,
//   availability: 'Immediate', needsReview: true, alternatives: [...], ... }
```

Signature: `getPartPrice(reg, category, brand?, fitment?, prefer?)`.

- `tradePrice` is **our cost, ex-VAT**. Never expose it to a customer.
- `brand` is a *preference*, not a filter. If that brand has nothing priced
  and in stock, another is chosen and `fallbackUsed: true` is set.
- **`needsReview: true` means do not auto-quote.** More than one fitment group
  came back, i.e. more than one physical size, and the catalogue cannot say
  which fits. A human picks.
- Unpriced and out-of-stock parts are never selected. In a live sample, 68 of
  88 parts were `OutOfStock`, so an empty result is normal, not a bug.
- Availability ranks `Immediate` → `HubTomorrow` → `GroupTomorrow` →
  `Group72Hours`. Anything unrecognised sorts last.

## HTTP route

`snippets/route-express.js` is an Express router mounting
`POST /api/gsf/part-price`. Keep it behind auth — it returns trade cost.

```js
app.use('/api/gsf', requireAuth, rateLimit({ windowMs: 60_000, max: 30 }), gsfRouter);
```

Needs `express` installed; it is not a dependency of this package.

## Customer PDF and email

On the new-quotation form, **Customer details** are all optional: name, email,
phone, account no., address. They can be added or changed later from the
quotation (**Edit**).

On a quotation, **View PDF** and **Download PDF** give the customer's copy in
the Auto Assist Group layout ([src/quotePdf.js](src/quotePdf.js)). The header
([assets/quote-header.png](assets/quote-header.png)) and the footer (address,
VAT and company numbers) are fixed. The rest comes from the quotation: the
customer, the quotation number, date, make, model and registration, and each
priced line with net, 20% VAT and total. Trade cost never appears, and lines
that could not be priced are left out.

**Email PDF** sends it as an attachment to the customer's email, or to any
address typed in, from the company's Microsoft 365 mailbox ([src/mailer.js](src/mailer.js)). It
stays disabled until one way to send is set in `.env` (see `.env.example`):

- **Microsoft Graph** (preferred): `MS_TENANT_ID`, `MS_CLIENT_ID`,
  `MS_CLIENT_SECRET`, and `MAIL_FROM` for the mailbox it sends as. The app
  registration needs the `Mail.Send` application permission. A copy is kept in
  that mailbox's Sent Items.
- **SMTP**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
  Microsoft 365 turns SMTP AUTH off by default ("SmtpClientAuthentication is
  disabled for the Tenant").

`MAIL_BCC` is optional for either. Each send is recorded on the quotation.

Customer details are left out of the shared review export (`bin/quote.js`).

## Tests

```bash
npm test
```

Eleven tests over the selection rules, run against a fixture — no network. They
pin the behaviour that costs money if it drifts: unpriced and out-of-stock
parts are never quoted, alternatives stay inside one fitment group, multiple
fitment groups set `needsReview`, and a next-day part never loses to a
three-day one.

## Cache

File-based in `.cache/` by default, so it runs with nothing installed. Holds
the cookie jar plus parts payloads. `rm -rf .cache` is always safe — it just
forces a fresh login.

**Cached parts payloads contain stock levels**, so anything cached is stock as
of that moment. Default TTL is 600s; set `GSF_PARTS_TTL=0` for live data on
every call.

**Set `REDIS_URL` in production.** With a per-process cache every worker keeps
its own cookie jar and logs in separately, which is what the login lock exists
to prevent. `npm install ioredis` to enable it.

## Troubleshooting

| Message | Cause |
|---|---|
| `AUTH FAILED: ... not configured` | `.env` is not being read — are you using `--env-file`? |
| `AUTH FAILED: GSF rejected the login` | Bad credentials, or the form field name. Try `GSF_USER_FIELD=username` (see `src/config.js`) |
| `BLOCKED: 403 ... DataDome` | Edge/WAF block, not auth. **Do not retry in a loop** — that escalates it. Capture fresh cookies from a browser on this server's egress IP |
| `Unknown GSF category "X"` | Wrong name. Run `categories <search>` for the exact string |
| `NOT FOUND ... considered 0` | Usually a fitment label that does not exist for this category. Drop `--fitment` |

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

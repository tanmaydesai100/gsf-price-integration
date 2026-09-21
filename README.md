# GSF TradeHub price lookup

Read-only integration: registration + category (+ optional brand) → trade price.

```
getPartPrice("P44PYN", "Wipers", "BOSCH")
```

There is **no API token**. TradeHub authenticates with a NextAuth session
**cookie** valid for a rolling ~1 year. So the flow is: log in once → cache the
cookie jar → reuse it for every lookup → log in again only when the jar is
empty or a call returns 401.

---

## Order of work

### 1. Run the Python validator FIRST, from the production server

This is the gate on everything else. The investigation could not verify
server-side access (the test sandbox's proxy blocked the domain), so the open
question is whether **DataDome** — which sits at the edge — lets a non-browser
client through.

```bash
pip install requests

# Safest first test: paste cookies from a logged-in Chrome (no password anywhere)
#   DevTools > Application > Cookies > trade.gsfcarparts.com
export GSF_COOKIE='__Secure-next-auth.session-token=...; datadome=...'
python3 python/gsf_price.py --reg P44PYN --category Wipers --brand BOSCH
```

- **JSON comes back** → green light, build the Laravel service.
- **`BLOCKED: 403`** → DataDome is blocking the server's IP. Stop. Do not loop
  retries. That is a conversation with GSF, not a code problem.

Then test the headless login, which is what the Laravel service does:

```bash
export GSF_EMAIL='...'
export GSF_PASSWORD='...'
python3 python/gsf_price.py --login --reg P44PYN --category Wipers --brand BOSCH
```

If the login is rejected, the form field name is the likely culprit — see
**Login field name** below.

### 2. Drop the Laravel files in

```
laravel/config/gsf.php                                  → config/gsf.php
laravel/app/Services/Gsf/*                              → app/Services/Gsf/
laravel/app/Http/Controllers/Api/GsfPriceController.php → app/Http/Controllers/Api/
laravel/app/Console/Commands/*.php                      → app/Console/Commands/
laravel/storage/app/gsf/categories.json                 → storage/app/gsf/
laravel/snippets/env.example                            → append to .env
laravel/snippets/routes-api.php                         → merge into routes/api.php
```

No service provider binding needed — Laravel autowires all three classes.

### 3. Test from artisan

```bash
php artisan gsf:price --whoami
php artisan gsf:categories --export              # once, then commit the file
php artisan gsf:price P44PYN Wipers --brand=BOSCH
php artisan gsf:price P44PYN Wipers --all        # every candidate
php artisan gsf:price --logout                   # force a fresh login
```

---

## Login field name

The credentials provider's username field was **not verified**. Default is
`email`. To confirm: sign in to TradeHub with DevTools → Network open, find the
POST to `/api/auth/callback/credentials`, read its form body. If it says
`username`, set `GSF_USER_FIELD=username`.

Both providers are live on the site:

```
GET /api/auth/providers
→ azure-ad    (oauth)        ← GSF internal staff
  credentials (credentials)  ← trade accounts, what we use
```

---

## This is an API integration, not scraping

No HTML is ever parsed. No browser, no page traversal, no DOM selectors. The
price comes from one JSON endpoint and is read as structured data:

```php
$response->json()['partData']['parts']   // 26 objects, 70 fields each
```

Nothing here breaks when GSF restyles a page.

## How a lookup runs — two HTTP calls

| Step | Call | Source |
|---|---|---|
| — | category → componentId | **local JSON file**, no network |
| 1 | `POST /vrm/api {"vrm":"P44PYN"}` | live |
| 2 | `GET /parts/api/parts?partType=Wipers&componentId=867` | live (10 min cache) |

Plus a login, but only when the cookie jar is empty or a call returns 401.

Headers on step 2: the cookie jar, `customerAccount` (read from the live
session), `vrm`. That's the whole of the authentication.

**`componentId` is what selects the category.** `partType` is a display label
only — but it must be present or the endpoint returns zero parts.

## The category file

`/api/menus` is fetched **once**, at install, and flattened to a JSON file.
Price lookups read that file from disk and never call it again.

```bash
php artisan gsf:categories --export     # writes storage/app/gsf/categories.json
git add storage/app/gsf/categories.json # commit it
```

```json
{
  "_generated": "2026-09-20T17:04:00+01:00",
  "categories": { "wipers": 867, "wiper arm": 901, "brake pad set": 1234, ... }
}
```

The shipped file is a **seed** containing only the three componentIds verified
against the live site (`wipers` 867, `wiper arm` 901, `wiper motor` 924). Run
`--export` on the production server to fill in the rest (~1,300 entries).

```bash
php artisan gsf:categories wiper      # search the map
php artisan gsf:categories --count
```

Resolution order is file → cache → live API, so a missing file degrades
gracefully instead of breaking. Regenerate only if GSF restructures its
catalogue, or a category name stops resolving.

**Categories go in a file. Prices and stock never do** — those must be live on
every quote.

---

## Selection rules

1. Filter to the requested `fitment` (default `Front`).
2. Drop anything with `customerPrice === null` — GSF won't sell it to us.
3. Drop `availability === "OutOfStock"`.
4. Count distinct `groupedPartNumber` values among what's left. **More than one
   means more than one physical SIZE** → `needsReview: true`.
5. Sort by strategy: `availability` (soonest first, then cheapest — default) or
   `price` (cheapest first).
6. Prefer the requested brand; if it has nothing in stock, fall back to the best
   remaining part and set `fallbackUsed: true`.
7. `alternatives` lists other brands **in the same fitment group only**.

### The wiper problem, stated plainly

For P44PYN the catalogue returns **five distinct front fitment groups**
(550/530, 550/550, 600/500 …). Nothing in the payload says which fits, and
`isBestMatch` / `multipleFitmentOptions` are both unpopulated. TradeHub itself
shows *"There are multiple options! Call your local branch."*

So the service returns a price **and** `needsReview: true`. Show the price on
the quote with a "confirm blade size" flag. Don't try to engineer the ambiguity
away — it's real.

---

## Operational notes

- **Never call GSF from the browser.** CORS blocks it, and it would expose our
  session cookie and trade prices to anyone with DevTools. The route is
  server-side and behind auth.
- **One shared cookie jar**, not one per user. It's the company account.
- **Login is locked** (`Cache::lock('gsf:login')`) so ten concurrent 401s
  produce one login, not ten.
- **Use a persistent cache store** (redis or database). With `array` or a
  multi-server `file` cache, every worker logs in separately.
- **401 ≠ 403.** A 401 means the session died → re-login is correct. A 403 is
  DataDome → alert a human and stop. The client class treats them differently
  on purpose.
- **`GSF_PARTS_TTL` caches stock levels too.** 600s is a compromise; set 0 for
  always-live at the cost of ~1.1s per quote.
- Prices are **ex-VAT** (`vatRate: 0.2` is returned).
- Pricing is **account-specific** — it only appears when `customerAccount`
  matches the signed-in account.

## Still worth doing

Email the GSF account manager about official read-only pricing/stock API
access. There's no public API, but GSF clearly runs some partner channel
(BOOKAR has an order-submission integration). An official endpoint would make
all of the above unnecessary.

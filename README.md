# GSF TradeHub price lookup

Read-only lookup: registration + category (+ optional brand) → trade price.

There is no API token. TradeHub authenticates with a session **cookie**, so we
log in, reuse the cookie, and read one JSON endpoint. No HTML is ever parsed.

---

## Test it

Run this **on the production server** — the point is to prove that server's IP
isn't blocked by DataDome, GSF's bot protection at the edge.

```bash
pip install requests

unset GSF_PASSWORD                              # clear any stale value
export GSF_EMAIL='marc@autoassistgroup.com'
read -rs GSF_PASSWORD && export GSF_PASSWORD    # type password, press Enter

python python/gsf_price.py --login --reg P44PYN --category Wipers --brand BOSCH
```

`read -rs` keeps the password out of your shell history. Typing
`export GSF_PASSWORD='...'` would save it to `~/.zsh_history` in plain text.

**Expected:** a JSON object with `tradePrice`, `brand`, `sku`, `availability`.

**If you get `BLOCKED: 403`:** DataDome is refusing this server. Stop — don't
retry in a loop, it makes the block worse. That's a conversation with GSF.

Other options: `--all` lists every candidate, `--prefer price` picks cheapest
instead of soonest-available.

---

## What's in here

**`python/`** — the validator above. Standalone, throwaway. Logs in fresh every
run, saves nothing. Fine for testing by hand, not for production.

**`laravel/`** — the same lookup written for our backend, so this can be
integrated into our own system later. Not runnable on its own; the files are
copied into the Laravel app:

```
laravel/config/gsf.php              → config/gsf.php
laravel/app/Services/Gsf/*          → app/Services/Gsf/
laravel/app/Http/Controllers/...    → app/Http/Controllers/Api/
laravel/app/Console/Commands/*      → app/Console/Commands/
laravel/storage/app/gsf/*.json      → storage/app/gsf/
laravel/snippets/env.example        → append to .env
laravel/snippets/routes-api.php     → merge into routes/api.php
```

Then:

```bash
php artisan gsf:price --whoami                    # check the session
php artisan gsf:categories --export               # build the category map, once
php artisan gsf:price P44PYN Wipers --brand=BOSCH
```

Unlike the Python script, it logs in **once** and caches the cookie for 14 days.

**`nodejs/`** — the same thing again in Node, if the backend it goes into turns
out to be Node rather than Laravel. Runs on its own: `cd nodejs && npm install
&& npm test`. See `nodejs/README.md`.

The three folders are independent. None of them calls the others.

---

## Things to know

- **Never call GSF from the browser** — it would expose our session cookie and
  trade prices to anyone with DevTools open. Server-side only, behind auth.
- **401 ≠ 403.** 401 means the session died, so re-login. 403 is DataDome —
  alert a human and stop.
- **Prices are ex-VAT** and account-specific.
- **Wipers often need review.** The catalogue returns several front fitment
  groups (550/530, 600/500 …) with nothing saying which fits. TradeHub itself
  says "call your local branch." So the result carries `needsReview: true` —
  show the price with a "confirm blade size" flag.
- The login form field name (`email` vs `username`) was never confirmed. If
  login is rejected, try `--user-field username`.

The detail behind each of these is in the code comments — see
`GsfClient.php` for the session and 401/403 handling, and `GsfPriceService.php`
for the part-selection rules.

# JLR EPC integration

The JLR counterpart to the GSF lookup. It follows the same flow: registration +
service in, priced parts out, then the same picker and quotations. It is read-only
throughout.

This directory imports nothing from the GSF code. `bin/serve.js` and
`bin/jlr.js` connect it to the rest of the app.

## How it maps to GSF

| Step | GSF | JLR |
|---|---|---|
| Login | NextAuth cookie, plain HTTP | ForgeRock + Salesforce OAuth, plain HTTP ([auth.js](src/auth.js)) |
| Reg → vehicle | `/vrm/api` | `vehicleConfig/vinDecode`: VIN + the model's catalogue ID |
| Service → where to look | one flat `data/categories.json` | this vehicle's catalogue tree (model → major → minor → page), walked once and cached ([hierarchy.js](src/hierarchy.js)) |
| Parts + prices | `/parts/api/parts` | `catEntries` |
| Choosing a part | brand priority, availability, price | the service is matched against part descriptions on a shortlist of pages; parts JLR marks not-applicable are dropped; one option per JLR part number ([priceService.js](src/priceService.js)) |

`JlrPriceService` has the same `listOptions` / `getPartPrice` shapes as
`GsfPriceService`. That lets the quotation module and the picker use either
supplier. A quotation stores `supplier: 'gsf' | 'jlr'`, and edits re-price new
lines against that supplier.

## What is confirmed

Everything, against the live EPC on 2026-09-24: the login, `vinDecode`,
`nextLevelHierarchies` and `catEntries`. The request bodies are the ones the
EPC front end sends; [endpoints.json](endpoints.json) records them. There is no
`majorSections` call - the tree starts from the model's catalogue ID that
`vinDecode` returns.

Example: `WL61RZO` → Range Rover Evoque 2012–2018 (catalogue 24), 260 pages,
walked in about 70 seconds. "Oil Filter" → LR025306 *Filter - Oil*, £8.73.

## How a service finds its part

JLR names pages after assemblies ("Front Brake Discs And Calipers"), not parts,
and often leaves the context to the page (on "Air Cleaner" the filter is just
*Element - Filter*). So for a service name:

1. Page names **shortlist** up to 6 likely pages.
2. The **part descriptions** on those pages decide what matches: every word of
   the service, or of an alias phrase, and none of its exclusions.
3. Nothing matching means **not found**. It never falls back to "everything on
   that page".

[data/aliases.json](data/aliases.json) holds the phrases, page hints,
exclusions and page-context rules. Checked services on the Evoque: oil, air and
pollen filter, brake pads and discs, wiper blades, spark plugs, auxiliary belt.
When a service doesn't match, add to that file. The picker's own search sends
an exact page label and lists every part on that page.

## Jobs: pricing without the customer choosing parts

A text search for "brake" on one vehicle returns about twenty parts. Customers
choose a **job** instead ("Front brake pads & discs"), and
[data/jobs.json](data/jobs.json) says which parts it takes by **callout base
number**. The base is the middle of JLR's engineer number (BJ32-**2005**-AC is
a brake booster). JLR kept it from the Ford system, so it is the same on every
model. One job list therefore covers every catalogue: page hints say where to
look, and the base decides which part it is ([src/jobs.js](src/jobs.js)).

When a base still has several parts, the rules settle what the data can settle:

| Rule | Example | Result |
|---|---|---|
| single | Evoque front discs 1125 | quoted |
| pair | wiper blades 17528, LH + RH | both quoted |
| preferred | brake fluid 19542A (500 ML) / B (1 L) | the job's `prefer` picks the 1 L |
| avoid | pollen filter: standard vs "PM 2.5 Upgrade" | the upgrade is dropped |
| interchangeable | spark plug LR025605 / LR123892, same price | one quoted, the other kept as an alternative |
| review | anything else | cheapest quoted, `needsReview` for staff |
| no_page | spark plugs on a diesel | the vehicle has no such part |

```bash
node --env-file=.env bin/jlr.js jobs
node --env-file=.env bin/jlr.js job WL61RZO front_pads_discs
node --env-file=.env bin/jlr.js check WL61RZO PE17KMO     # every job, every vehicle
```

**On the web page.** With "JLR genuine" selected, the new-quotation form shows
the jobs as buttons above the catalogue search. Picking one prices it for the
registration (`/api/jlr/job`) and opens the parts panel, with the job's parts
ticked, alternatives unticked, lines staff should confirm marked, and parts the
vehicle doesn't have listed underneath. Each part becomes a normal quotation line:
category = the job's label, group = the JLR part number. So create, edit and
re-price go through `listOptions` like any other line. Search stays underneath for
anything that isn't a job.

**Speed.** Pages are found with the EPC's own section search
(`searchCatalogues`, type SECTION): one call per phrase, under a second, already
filtered to the VIN. The tree is not walked, so a car never seen before prices a
job in about 1.7 s, where the tree walk took around 45 s. The web picker's page
search uses the same call, and falls back to the tree only when that is already
cached. Part-description search (type PART) exists too, but it missed the oil
filter and drive belt in testing, so the code finds the page and reads all of it.

**Checked live on 2026-09-28** with an empty cache: New Range Rover L460 (3.0
diesel), Evoque L538 and RR Sport L494. 38 of 42 lines resolved automatically.
Spark plugs (two diesels) and the brake booster (the L460 has none) have no page,
which is correct. The L460 pollen filter is flagged for review: it has an exterior
and an interior filter. The L460 oil filter is base 6714 (cartridge), not 6731
(spin-on), so that job lists both.

**Added 2026-09-28: fuel filter, glow plugs, battery**, checked on the same three
cars. The fuel filter is 9S324 on both diesels; the job takes the filter, not the
"Complete Assembly" housing. 9155, the Ford fuel filter base, is also listed but
not yet seen. Glow plugs are 12A342 on the L460 and 11A604 on the L494, ×6 each.
The battery is 10655, and the job skips the "USA locally sourced" part. Fuel filter
and glow plugs are marked `"engine": "diesel"`, so the petrol Evoque shows them as
not on the vehicle.

**Added 2026-09-28: front and rear wheel bearing**, checked on the same three
cars. JLR catalogues the bearing three ways: 1215 "Bearing - Wheel Hub" (L494,
Evoque front), 1225 "Hub And Bearing" (Evoque rear) and 1104 "Hub - Wheel, With
Bearing" (L460). On the Evoque, 1104 is a hub without a bearing, so these jobs
`require` the word "bearing" and never quote a bare hub. Quantity is one side
(`qty: 1`); change it to 2 on the quotation for both sides.

**Earlier, on 2026-09-27**, Evoque L538 (2.0 petrol) and Range Rover Sport
L494 (3.0 diesel). All 12 jobs resolved automatically on both, except spark
plugs on the diesel (no page, as expected). Every base held across both models.
The only fix needed was a page hint: the L494 keeps its pollen filter on
"Heater/Air Con Blower And Compnts". Run `check` on a new model before offering
it, and when a line says MISSING, widen that part's `pages`. Don't change the base.

## Configuration

```bash
cp jlr/.env.example .env      # or append to the existing nodejs/.env
chmod 600 .env
```

Required: `JLR_EPC_EMAIL`, `JLR_EPC_PASSWORD`, `JLR_RETAILER_CODE`, plus an
encryption key: `JLR_APP_KEY`, or the existing
`GSF_APP_KEY`.

`JLR_RETAILER_CODE` is the sponsoring retailer's partner code. The EPC sends it
as both retailer code and retailer ID. To find it: log in on jlrepc.com, open
DevTools → Application → Session storage → `customerSessionItem` →
`customerRetailerID`. Every other setting has a documented default in
[.env.example](.env.example).

**Login.** Plain HTTP, no browser. The client signs in with the email and
password and caches the session in `jlr/.cache`, encrypted with the app key.
Later calls and restarts reuse it:

- The catalogue token lasts about an hour. When it runs out, a new one is fetched.
- The login token lasts 30 minutes. When it runs out, the refresh token renews it.
- A full sign-in happens only when JLR refuses the refresh or answers 401 twice.

If JLR ever adds MFA to the account, login stops with an error naming the extra
step rather than retrying.

```bash
node --env-file=.env bin/jlr.js login     # sign in now, cache the session
node --env-file=.env bin/jlr.js whoami    # what is cached (no network)
node --env-file=.env bin/jlr.js logout    # forget it
```

**Price.** JLR parts are quoted at the catalogue `unitPrice`, with no markup.
`JLR_MARKUP_PERCENT` can add one. It defaults to 0 and does not fall back to
`GSF_MARKUP_PERCENT`, so GSF's markup never applies to JLR.

## Using it

```bash
node --env-file=.env bin/serve.js     # pick "JLR genuine" on the new-quotation form
```

In JLR mode the service search runs over **this vehicle's** catalogue pages,
because JLR has no list that covers every car. The first search on a vehicle
walks its whole tree: sequential, paced by `JLR_WALK_DELAY_MS`, capped by
`JLR_MAX_NODES`. That can take a minute or two, and the result is cached for
`JLR_TREE_TTL`. To warm a vehicle ahead of time:

```bash
node --env-file=.env bin/jlr.js pages <reg|vin> --refresh
node --env-file=.env bin/jlr.js pages <reg|vin> "oil filter"
node --env-file=.env bin/jlr.js parts <reg|vin> 27576
node --env-file=.env bin/jlr.js price <reg|vin> "Oil Filter"
```

`price` also accepts quotation-style service names ("Wipers", "Brake Pads").
They are matched against page names, with extra JLR wording from
[data/aliases.json](data/aliases.json). That list is a starting point: add to it
when a service doesn't match.

The "JLR page lookup" panel at the bottom of the web page fetches one page by
ID. It bypasses the tree and the service matching, so it is useful while those
are being confirmed.

## Tests

```bash
node --test jlr/test/*.test.js
```

These cover the login chain against a fake JLR: full login, reuse after a
restart, refresh, a refresh that is refused, a 401 retry, an MFA prompt, wrong
credentials and encryption. They also cover part filtering, the option shape,
service → page matching, the tree walk, response readers, and a JLR quotation
from start to finish. None of them touch the real JLR.

## Runtime state

`jlr/.cache` is gitignored. It holds the encrypted session, VINs, catalogue
trees and short-lived prices. Delete it to force a fresh login and fresh
lookups, or use `bin/jlr.js logout` to clear only the session.

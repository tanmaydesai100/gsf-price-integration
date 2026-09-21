#!/usr/bin/env python3
"""
gsf_price.py — standalone validator for the GSF TradeHub read-only price lookup.

RUN THIS FIRST, FROM THE PRODUCTION SERVER, before writing any Laravel code.
It proves three things in one go:

  1. the production server can reach trade.gsfcarparts.com without a DataDome 403
  2. the login flow works headlessly (or that a pasted cookie works)
  3. the price returned matches what TradeHub shows in the browser

Everything here is READ-ONLY. No basket, order or checkout endpoint is touched.

Usage
-----
  # Safest: paste cookies from a logged-in browser (no password anywhere)
  export GSF_COOKIE='__Secure-next-auth.session-token=...; datadome=...'
  python3 gsf_price.py --reg P44PYN --category Wipers --brand BOSCH

  # Or let it log in (see LOGIN FIELD NAMES below before using this)
  export GSF_EMAIL='...'
  export GSF_PASSWORD='...'
  python3 gsf_price.py --login --reg P44PYN --category Wipers --brand BOSCH

  # Dump the whole candidate list instead of one pick
  python3 gsf_price.py --reg P44PYN --category Wipers --all

LOGIN FIELD NAMES
-----------------
The credentials provider's field names were NOT verified during the
investigation. Defaults here are "email" + "password". To confirm for real:
open the TradeHub login page with DevTools > Network, sign in, and look at the
form body of the POST to /api/auth/callback/credentials. If it says "username"
instead of "email", pass --user-field username.
"""

import argparse
import json
import os
import sys

try:
    import requests
except ImportError:
    sys.exit("pip install requests")

BASE = "https://trade.gsfcarparts.com"

# A browser-shaped header set. DataDome sits at the edge; a bare python-requests
# user-agent is the classic profile it blocks.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept": "application/json, text/plain, */*",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Referer": BASE + "/",
}


class GsfBlocked(Exception):
    """403 — DataDome or WAF. Do NOT retry; retrying makes it worse."""


class GsfAuthFailed(Exception):
    """401 — no valid session."""


# --------------------------------------------------------------------------
# session
# --------------------------------------------------------------------------

def make_session(cookie_header=None):
    s = requests.Session()
    s.headers.update(BROWSER_HEADERS)
    if cookie_header:
        for part in cookie_header.split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            name, value = part.split("=", 1)
            s.cookies.set(name.strip(), value.strip(), domain="trade.gsfcarparts.com")
    return s


def login(session, email, password, user_field="email"):
    """NextAuth credentials sign-in. Returns nothing; cookies land in the session."""
    # Warm up: picks up the datadome cookie the edge hands out to real browsers.
    session.get(BASE + "/", timeout=30)

    csrf_res = session.get(BASE + "/api/auth/csrf", timeout=30)
    _guard(csrf_res)
    csrf_token = csrf_res.json()["csrfToken"]

    res = session.post(
        BASE + "/api/auth/callback/credentials",
        data={
            "csrfToken": csrf_token,
            "callbackUrl": BASE + "/",
            "json": "true",
            user_field: email,
            "password": password,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        allow_redirects=False,
        timeout=45,
    )
    _guard(res)

    # NextAuth signals a bad password by redirecting back to the sign-in page
    # with ?error=, rather than returning a 4xx.
    location = res.headers.get("location", "")
    body = res.text[:400]
    if "error" in location.lower() or '"error"' in body.lower():
        raise GsfAuthFailed(f"login rejected — location={location!r} body={body!r}")


def whoami(session):
    """Returns (account_no, user_email, expires). Also validates the session."""
    res = session.get(BASE + "/api/auth/session", timeout=30)
    _guard(res)
    data = res.json() or {}
    user = data.get("user") or {}
    customer = user.get("customer") or {}
    account_no = customer.get("accountNo")
    if not account_no:
        raise GsfAuthFailed("session has no customer.accountNo — not signed in")
    return str(account_no), user.get("email"), data.get("expires")


def _guard(res):
    if res.status_code == 403:
        raise GsfBlocked("403 — DataDome/WAF blocked this request. Do not retry.")
    if res.status_code == 401:
        raise GsfAuthFailed("401 — session cookie missing or expired.")
    res.raise_for_status()


# --------------------------------------------------------------------------
# category map:  "Wipers" -> componentId 867
# --------------------------------------------------------------------------

def category_map(session):
    res = session.get(BASE + "/api/menus", timeout=45)
    _guard(res)
    tree = res.json()

    out = {}

    def walk(node):
        if isinstance(node, list):
            for child in node:
                walk(child)
            return
        if not isinstance(node, dict):
            return
        caption = (node.get("caption") or "").strip()
        component_id = node.get("lastMenuNodeId") or 0
        if caption and component_id:
            out.setdefault(caption.lower(), int(component_id))
        walk(node.get("children") or [])

    walk(tree.get("popularCategories") or [])
    walk(tree.get("featured") or [])
    return out


# --------------------------------------------------------------------------
# the actual price call
# --------------------------------------------------------------------------

def fetch_parts(session, account_no, reg, category, component_id):
    # Step 1 — resolve the registration. Optional in practice (the vrm header
    # alone worked for cached vehicles) but correct for a reg the account has
    # never looked up before, which was never proven otherwise.
    session.post(
        BASE + "/vrm/api",
        json={"vrm": reg},
        headers={"Content-Type": "application/json"},
        timeout=45,
    )

    # Step 2 — parts, pricing and stock.
    res = session.get(
        BASE + "/parts/api/parts",
        params={"partType": category, "componentId": component_id},
        headers={
            "customerAccount": account_no,
            "vrm": reg,
            "Cache-Control": "no-store",
        },
        timeout=60,
    )
    _guard(res)
    return res.json()


# --------------------------------------------------------------------------
# selection
# --------------------------------------------------------------------------

IN_STOCK_RANK = {"Immediate": 0, "HubTomorrow": 1, "Group72Hours": 2}


def select(payload, brand=None, fitment="Front", prefer="availability"):
    """
    prefer="availability"  soonest-available first, then cheapest  (default)
    prefer="price"         cheapest first, then soonest-available

    These give DIFFERENT answers on real data. For P44PYN/BOSCH:
      availability -> BOSAR550S  GBP 20.90  (Immediate, 550/530mm)
      price        -> BOSAR550S  GBP 20.90  (also cheapest BOSCH)
    and the 600/500mm BOSCH (BOSA113S, GBP 26.02) is a different SIZE, not a
    worse deal. That is why needsReview exists — pick a strategy for the
    commercial default, but let a human confirm the size.
    """
    parts = ((payload.get("partData") or {}).get("parts")) or []

    rows = [p for p in parts if not fitment or p.get("fitment") == fitment]
    priced = [p for p in rows if p.get("customerPrice") is not None]
    in_stock = [p for p in priced if p.get("availability") != "OutOfStock"]

    if not in_stock:
        return {
            "found": False,
            "reason": "no priced, in-stock part for this vehicle/fitment",
            "consideredRows": len(rows),
        }

    groups = sorted({p.get("groupedPartNumber") for p in in_stock})
    needs_review = len(groups) > 1

    if prefer == "price":
        def sort_key(p):
            return (p.get("customerPrice"), IN_STOCK_RANK.get(p.get("availability"), 9))
    else:
        def sort_key(p):
            return (IN_STOCK_RANK.get(p.get("availability"), 9), p.get("customerPrice"))

    preferred = sorted(
        [p for p in in_stock if brand and (p.get("brand") or "").upper() == brand.upper()],
        key=sort_key,
    )
    chosen = preferred[0] if preferred else sorted(in_stock, key=sort_key)[0]

    alternatives = [
        {
            "sku": p["sku"],
            "brand": p.get("brand"),
            "tradePrice": p.get("customerPrice"),
            "availability": p.get("availability"),
        }
        for p in sorted(in_stock, key=sort_key)
        if p.get("groupedPartNumber") == chosen.get("groupedPartNumber")
        and p["sku"] != chosen["sku"]
    ]

    vehicle = payload.get("vehicle") or {}

    return {
        "found": True,
        "registration": vehicle.get("vrm"),
        "vehicle": f"{vehicle.get('make')} {vehicle.get('model')}".strip(),
        "category": payload.get("partTypeDecoded"),
        "componentId": chosen.get("componentId"),
        "brand": chosen.get("brand"),
        "sku": chosen.get("sku"),
        "description": chosen.get("description"),
        "tradePrice": chosen.get("customerPrice"),
        "rrp": chosen.get("retailPrice"),
        "vatRate": chosen.get("taxRate"),
        "inStock": True,
        "availability": chosen.get("availability"),
        "stock": {
            "local": chosen.get("localStock"),
            "hub": chosen.get("hubStock"),
            "company": chosen.get("companyStock"),
        },
        "fitment": chosen.get("fitment"),
        "fitmentGroup": chosen.get("groupedPartNumber"),
        "strategy": prefer,
        "brandRequested": brand,
        "brandMatched": bool(preferred),
        "fallbackUsed": bool(brand) and not preferred,
        "needsReview": needs_review,
        "reviewReason": (
            f"{len(groups)} distinct {fitment.lower()} fitment groups returned — "
            "size cannot be determined from the catalogue data"
        ) if needs_review else None,
        "alternatives": alternatives,
    }


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="GSF TradeHub read-only price lookup")
    ap.add_argument("--reg", required=True)
    ap.add_argument("--category", default="Wipers")
    ap.add_argument("--brand", default=None)
    ap.add_argument("--fitment", default="Front", help="Front, Rear, or '' for both")
    ap.add_argument("--prefer", default="availability", choices=["availability", "price"],
                    help="tie-break strategy when several parts qualify")
    ap.add_argument("--login", action="store_true", help="log in with GSF_EMAIL / GSF_PASSWORD")
    ap.add_argument("--user-field", default="email", help="login form field name: email or username")
    ap.add_argument("--all", action="store_true", help="print every candidate instead of one pick")
    args = ap.parse_args()

    cookie = os.environ.get("GSF_COOKIE")
    if not cookie and not args.login:
        sys.exit("Set GSF_COOKIE, or pass --login with GSF_EMAIL / GSF_PASSWORD set.")

    session = make_session(cookie)

    try:
        if args.login:
            email = os.environ.get("GSF_EMAIL")
            password = os.environ.get("GSF_PASSWORD")
            if not email or not password:
                sys.exit("--login needs GSF_EMAIL and GSF_PASSWORD in the environment.")
            login(session, email, password, args.user_field)

        account_no, user_email, expires = whoami(session)
        print(f"# signed in as {user_email} — session expires {expires}",
              file=sys.stderr)

        cats = category_map(session)
        component_id = cats.get(args.category.lower())
        if not component_id:
            close = [c for c in cats if args.category.lower() in c][:10]
            sys.exit(f"Unknown category {args.category!r}. Did you mean: {close}")
        print(f"# category {args.category!r} -> componentId {component_id}", file=sys.stderr)

        payload = fetch_parts(session, account_no, args.reg.upper().replace(" ", ""),
                              args.category, component_id)

        if args.all:
            rows = ((payload.get("partData") or {}).get("parts")) or []
            print(json.dumps([
                {
                    "sku": p.get("sku"), "brand": p.get("brand"), "fitment": p.get("fitment"),
                    "tradePrice": p.get("customerPrice"), "rrp": p.get("retailPrice"),
                    "availability": p.get("availability"),
                    "fitmentGroup": p.get("groupedPartNumber"),
                    "description": p.get("description"),
                } for p in rows
            ], indent=2))
            return

        print(json.dumps(select(payload, args.brand, args.fitment, args.prefer), indent=2))

    except GsfBlocked as e:
        sys.exit(f"BLOCKED: {e}\n"
                 "This is the DataDome outcome. Do not loop retries — capture fresh\n"
                 "cookies from a real browser on this machine's IP, or raise it with GSF.")
    except GsfAuthFailed as e:
        sys.exit(f"AUTH FAILED: {e}")


if __name__ == "__main__":
    main()

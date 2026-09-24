# JLR EPC integration

This directory is intentionally separate from the GSF integration.

The public JLR EPC entry point is:

```text
https://www.jlrepc.com/jlr-epc/en-GB/home
```

Independent users are redirected to the JLR ForgeRock login:

```text
https://enterprise.jaguarlandrover.com/business/?realm=b2b&authIndexType=service&authIndexValue=iepc-login
```

The authenticated catalogue API has not been confirmed. Do not copy GSF
endpoints or credentials into this directory. After an authorised login,
capture the read-only catalogue request from the browser Network panel and
record its method, path, query/body fields, and response shape in
`jlr/endpoints.json`.

## Confirmed catalogue request

After vehicle selection and navigation through the hierarchy, the browser
posts to:

```text
POST /mobify/proxy/apigee/iepc/catalogue/api/v1/catEntries
```

The request includes the selected page ID (`catHieId`) and VIN. The response
contains `responseObject.catalogueEntries[]`; each entry includes the JLR part
number (`apn`), callout, description, applicability, quantity, currency, and
`unitPrice`.

The hierarchy uses these paths:

```text
/mobify/proxy/apigee/iepc/catalogue/api/v1/majorSections
/mobify/proxy/apigee/iepc/catalogue/api/v1/nextLevelHierarchies
```

## Configuration

Copy the values into the process environment. Never commit credentials.

```text
JLR_EPC_BASE_URL=https://www.jlrepc.com
JLR_EPC_EMAIL=
JLR_EPC_PASSWORD=
JLR_RETAILER_CODE=
JLR_RETAILER_ID=
```

For local development, copy `jlr/.env.example` to `nodejs/.env` and fill in
the values. `nodejs/.env` is gitignored:

```bash
cp jlr/.env.example .env
chmod 600 .env
```

Then start the app with:

```bash
node --env-file=.env bin/serve.js
```

The JLR client starts the normal ForgeRock JSON authentication tree and fills
the username/password callbacks from `JLR_EPC_EMAIL` and `JLR_EPC_PASSWORD`.
It then reuses the returned session cookie for catalogue requests. If the
account requires MFA, CAPTCHA, or a changed authentication tree, the client
stops with an interactive-login error; in that case use the optional
`JLR_SESSION_COOKIE` or `JLR_APIGEE_TOKEN` runtime overrides. Do not paste
secrets into the React UI or commit them.

The persistent browser profile defaults to `jlr/.jlr-profile`, keeping all JLR
runtime state inside this directory. It is ignored by Git.

The catalogue request is implemented in `src/catalogue.js`. The login/session
flow is deliberately not guessed: it uses JLR ForgeRock and must be connected
using the approved session mechanism before calling the catalogue service.

For a logged-in session, set `JLR_SESSION_COOKIE` at runtime with the cookie
header from that authorized session. Do not commit it or put it in source
files. `JlrWorkflow` then exposes the website sequence:

```text
vehicle(body)
sections(body)
children(body)
parts({ catalogueId, vin, featureCodes })
```

The browser must supply the request bodies for `vehicle`, `sections`, and
`children` until those account-specific payloads have been captured. The
parts request body is normalized by `JlrCatalogue` and its response is ready
for service matching and UI confirmation.

## Planned flow

1. Authenticate through the approved JLR flow.
2. Resolve the vehicle using the confirmed catalogue request.
3. Fetch compatible parts and pricing.
4. Return a normalised read-only result to the existing application.

No GSF files are imported by this directory.
/**
 * Mirrors laravel/config/gsf.php. Every value comes from the environment.
 */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  baseUrl: process.env.GSF_BASE_URL || 'https://trade.gsfcarparts.com',

  /*
   * Credentials for the NextAuth "credentials" provider.
   *
   * IMPORTANT: the form field name for the username was NOT verified during
   * the investigation. Default is "email". To confirm: sign in to TradeHub
   * with DevTools > Network open and inspect the form body of the POST to
   * /api/auth/callback/credentials. If it reads "username", set
   * GSF_USER_FIELD=username.
   */
  email: process.env.GSF_EMAIL,
  password: process.env.GSF_PASSWORD,
  userField: process.env.GSF_USER_FIELD || 'email',

  // Optional. Leave unset and it is read from /api/auth/session after login.
  accountNo: process.env.GSF_ACCOUNT_NO || null,

  /*
   * DataDome sits at the edge. A bare node/undici user-agent is the classic
   * profile it blocks, so we present as a browser.
   */
  userAgent:
    process.env.GSF_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',

  timeout: int(process.env.GSF_TIMEOUT, 60) * 1000,

  cache: {
    // Cookie jar. The live session expires in ~1 year; we re-check well before.
    cookiesKey: 'gsf:cookies',
    cookiesTtl: int(process.env.GSF_COOKIE_TTL, 60 * 60 * 24 * 14), // 14 days

    // Fallback only - the category map normally comes from the file below.
    menusKey: 'gsf:menus',
    menusTtl: int(process.env.GSF_MENUS_TTL, 60 * 60 * 24 * 30), // 30 days

    /*
     * Parts payload cache, in seconds. This payload CONTAINS STOCK LEVELS,
     * so anything cached is stock as of that moment. 600 is a sane compromise
     * for quoting. Set GSF_PARTS_TTL=0 to always hit live.
     */
    partsTtl: int(process.env.GSF_PARTS_TTL, 600),

    // File store unless REDIS_URL is set. Use Redis in production: with a
    // per-process store every worker logs in separately.
    redisUrl: process.env.REDIS_URL || null,
    dir: process.env.GSF_CACHE_DIR || null, // defaults to <pkg>/.cache
  },

  /*
   * Category map, generated once by:  node bin/gsf.js categories --export
   *
   * Maps the category a user picks ("Wipers") to the componentId the parts
   * endpoint needs (867). Committed to git, read from disk on every lookup,
   * so a normal price call NEVER hits /api/menus.
   */
  categoriesFile: process.env.GSF_CATEGORIES_FILE || null, // defaults to <pkg>/data/categories.json

  // 'availability' = soonest-available first, then cheapest.
  // 'price'        = cheapest first, then soonest-available.
  prefer: process.env.GSF_PREFER || 'availability',

  // Used to encrypt the cached cookie jar at rest. Required.
  appKey: process.env.GSF_APP_KEY || process.env.APP_KEY || null,
};

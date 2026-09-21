<?php

return [

    'base_url' => env('GSF_BASE_URL', 'https://trade.gsfcarparts.com'),

    /*
    | Credentials for the NextAuth "credentials" provider.
    |
    | IMPORTANT: the form field name for the username was NOT verified during
    | the investigation. Default is "email". To confirm: sign in to TradeHub
    | with DevTools > Network open and inspect the form body of the POST to
    | /api/auth/callback/credentials. If it reads "username", set
    | GSF_USER_FIELD=username.
    |
    | Put these in a secret manager, not in a .env committed to git.
    */
    'email'      => env('GSF_EMAIL'),
    'password'   => env('GSF_PASSWORD'),
    'user_field' => env('GSF_USER_FIELD', 'email'),

    /*
    | Optional. Leave null and it is read from /api/auth/session
    | (user.customer.accountNo) after login — one less thing to keep in sync.
    */
    'account_no' => env('GSF_ACCOUNT_NO'),

    /*
    | DataDome sits at the edge. A bare Guzzle user-agent is the classic
    | profile it blocks, so we present as a browser.
    */
    'user_agent' => env('GSF_USER_AGENT',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '.
        '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'),

    'timeout' => (int) env('GSF_TIMEOUT', 60),

    'cache' => [
        // Cookie jar. The live session expires in ~1 year; we re-check well before.
        'cookies_key' => 'gsf:cookies',
        'cookies_ttl' => (int) env('GSF_COOKIE_TTL', 60 * 60 * 24 * 14),   // 14 days

        // Fallback only — the category map normally comes from the file below.
        'menus_key'   => 'gsf:menus',
        'menus_ttl'   => (int) env('GSF_MENUS_TTL', 60 * 60 * 24 * 30),   // 30 days

        /*
        | Parts payload cache, in seconds. This payload CONTAINS STOCK LEVELS,
        | so anything you cache is stock as of that moment. 600 is a sane
        | compromise for quoting. Set GSF_PARTS_TTL=0 to always hit live.
        */
        'parts_ttl'   => (int) env('GSF_PARTS_TTL', 600),
    ],

    /*
    | Category map, generated once by:  php artisan gsf:categories --export
    |
    | Maps the category a user picks ("Wipers") to the componentId the parts
    | endpoint needs (867). Committed to git, read from disk on every lookup,
    | so a normal price call NEVER hits /api/menus. Regenerate only if GSF
    | restructures its catalogue.
    */
    'categories_file' => env('GSF_CATEGORIES_FILE', storage_path('app/gsf/categories.json')),

    // 'availability' = soonest-available first, then cheapest.
    // 'price'        = cheapest first, then soonest-available.
    'prefer' => env('GSF_PREFER', 'availability'),

    // Where to shout when the session dies or DataDome blocks us.
    'alert_email' => env('GSF_ALERT_EMAIL'),
];

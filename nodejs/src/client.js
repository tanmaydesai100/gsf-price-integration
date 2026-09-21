/**
 * Transport + session management for GSF TradeHub.
 * Mirrors laravel/app/Services/Gsf/GsfClient.php.
 *
 * There is no OAuth and no bearer token on TradeHub. Authentication is a
 * NextAuth session COOKIE, valid for a rolling one-year window. So:
 *
 *   - we log in once, cache the cookie jar, and reuse it for every lookup
 *   - we only log in again when the jar is empty or a call returns 401
 *   - a 403 is DataDome, NOT an auth problem: we surface it and stop
 *
 * Everything this class does is read-only. It never touches basket, order,
 * checkout or payment endpoints.
 */

import got from 'got';
import { CookieJar } from 'tough-cookie';

import { cache } from './cache.js';
import { config } from './config.js';
import { GsfAuthError, GsfBlockedError, GsfError } from './errors.js';
import { assertKeyConfigured, decrypt, encrypt } from './secretbox.js';

export class GsfClient {
  #jar = null;
  #accountNo = null;

  // ---------------------------------------------------------------- public

  /** Authenticated GET. Re-authenticates once on 401, then retries. */
  async get(path, searchParams = {}, headers = {}) {
    return this.#send('GET', path, { searchParams }, headers);
  }

  /** Authenticated JSON POST. Only used for the read-only /vrm/api lookup. */
  async postJson(path, json, headers = {}) {
    return this.#send('POST', path, { json }, headers);
  }

  /** The trade account number, from the live session unless pinned in config. */
  async accountNo() {
    if (this.#accountNo) return this.#accountNo;
    if (config.accountNo) {
      this.#accountNo = String(config.accountNo);
      return this.#accountNo;
    }

    const session = (await this.get('/api/auth/session')).json();
    const no = session?.user?.customer?.accountNo;

    if (!no) {
      throw new GsfAuthError('Signed in but no customer.accountNo in the session payload.');
    }

    this.#accountNo = String(no);
    return this.#accountNo;
  }

  /** Diagnostics for the CLI / health check. */
  async sessionInfo() {
    const session = (await this.get('/api/auth/session')).json();

    return {
      email: session?.user?.email ?? null,
      accountNo: session?.user?.customer?.accountNo ?? null,
      customer: session?.user?.customer?.name ?? null,
      branchId: session?.user?.customer?.branchId ?? null,
      expires: session?.expires ?? null,
    };
  }

  /** Drop the cached cookies - next call logs in again. */
  async forgetSession() {
    await cache.forget(config.cache.cookiesKey);
    this.#jar = null;
    this.#accountNo = null;
  }

  // --------------------------------------------------------------- internal

  async #send(method, path, options, headers) {
    let response = await this.#dispatch(method, path, options, headers);

    if (response.statusCode === 401) {
      // Session died. Log in once and replay the request exactly once.
      console.warn('gsf: 401 - re-authenticating');
      await this.forgetSession();
      await this.#authenticate();

      response = await this.#dispatch(method, path, options, headers);

      if (response.statusCode === 401) {
        this.#alert('GSF session could not be re-established (401 after fresh login).');
        throw new GsfAuthError(
          'Still 401 after re-authenticating. Check GSF_EMAIL / GSF_PASSWORD.',
        );
      }
    }

    this.#guard(response, path);
    return response;
  }

  async #dispatch(method, path, options, headers) {
    const jar = await this.#cookieJar();

    const response = await got(this.#url(path), {
      method,
      cookieJar: jar,
      headers: { ...this.#browserHeaders(), ...headers },
      timeout: { request: config.timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      followRedirect: true,
      maxRedirects: 3,
      responseType: 'text',
      ...options,
    });

    // got has updated the jar in place (including any refreshed datadome
    // cookie); persist it so the next request reuses it.
    await this.#persistJar(jar);

    return wrap(response);
  }

  #guard(response, path) {
    if (response.statusCode === 403) {
      this.#alert(`GSF returned 403 on ${path} - DataDome / WAF block.`);
      throw new GsfBlockedError(
        `403 from GSF on ${path}. This is an edge block, not an auth failure. ` +
          'Do not retry in a loop - capture fresh cookies from a browser on this ' +
          "server's egress IP, or raise it with GSF.",
      );
    }

    if (response.statusCode === 401) {
      throw new GsfAuthError(`401 from GSF on ${path}.`);
    }

    if (response.statusCode >= 400) {
      throw new GsfError(`GSF returned HTTP ${response.statusCode} on ${path}.`);
    }
  }

  // ------------------------------------------------------------------ auth

  async #cookieJar() {
    if (this.#jar) return this.#jar;

    const stored = await this.#loadJar();
    if (stored) {
      this.#jar = stored;
      return this.#jar;
    }

    await this.#authenticate();
    return this.#jar;
  }

  /**
   * NextAuth credentials sign-in.
   *
   * A lock means ten concurrent quotes that all hit a dead session produce
   * ONE login, not ten. The others wait and pick up the fresh jar.
   */
  async #authenticate() {
    let release;
    try {
      release = await cache.lock('gsf:login', 60, 30);
    } catch {
      throw new GsfAuthError('Timed out waiting for another process to complete GSF login.');
    }

    try {
      // Someone else may have logged in while we waited.
      const stored = await this.#loadJar();
      if (stored) {
        this.#jar = stored;
        return;
      }

      if (!config.email || !config.password) {
        throw new GsfAuthError('GSF_EMAIL / GSF_PASSWORD are not configured.');
      }

      // Check this BEFORE the round trip: a login that succeeds and then
      // cannot cache its cookie would re-login on every single request.
      assertKeyConfigured();

      const jar = new CookieJar();
      const base = {
        cookieJar: jar,
        headers: this.#browserHeaders(),
        timeout: { request: config.timeout },
        throwHttpErrors: false,
        retry: { limit: 0 },
        responseType: 'text',
      };

      // 1. Warm up - the edge hands real browsers a datadome cookie here.
      await got(this.#url('/'), base);

      // 2. CSRF token (NextAuth requires it on the credentials callback).
      const csrf = wrap(await got(this.#url('/api/auth/csrf'), base));
      this.#guard(csrf, '/api/auth/csrf');
      const csrfToken = csrf.json()?.csrfToken;

      if (!csrfToken) {
        throw new GsfAuthError('No csrfToken returned by /api/auth/csrf.');
      }

      // 3. Sign in.
      const login = wrap(
        await got(this.#url('/api/auth/callback/credentials'), {
          ...base,
          method: 'POST',
          followRedirect: false,
          form: {
            csrfToken,
            callbackUrl: this.#url('/'),
            json: 'true',
            [config.userField]: config.email,
            password: config.password,
          },
        }),
      );

      this.#guard(login, '/api/auth/callback/credentials');

      // NextAuth signals a bad password with a redirect back to the sign-in
      // page carrying ?error=, not with a 4xx status.
      const location = login.headers.location ?? '';
      if (`${location}${login.body}`.toLowerCase().includes('error')) {
        this.#alert('GSF login was rejected - check the credentials and the user_field name.');
        throw new GsfAuthError(
          'GSF rejected the login. If the credentials are right, the form field name is ' +
            `probably wrong - try GSF_USER_FIELD=username. Redirect was: ${location}`,
        );
      }

      this.#jar = jar;
      await this.#persistJar(jar);
      this.#accountNo = null;

      console.warn('gsf: signed in, cookie jar cached');
    } finally {
      await release?.();
    }
  }

  // ---------------------------------------------------------------- cookies

  async #loadJar() {
    const raw = await cache.get(config.cache.cookiesKey);
    if (!raw) return null;

    try {
      const jar = CookieJar.fromJSON(JSON.parse(decrypt(raw)));
      return jar.toJSON().cookies.length > 0 ? jar : null;
    } catch {
      console.warn('gsf: cached cookie jar could not be decrypted, discarding');
      return null;
    }
  }

  async #persistJar(jar) {
    const serialised = jar.toJSON();
    if (!serialised.cookies?.length) return;

    await cache.put(
      config.cache.cookiesKey,
      encrypt(JSON.stringify(serialised)),
      config.cache.cookiesTtl,
    );
  }

  // ----------------------------------------------------------------- utils

  #browserHeaders() {
    return {
      'User-Agent': config.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      Referer: `${config.baseUrl.replace(/\/+$/, '')}/`,
    };
  }

  #url(path) {
    return `${config.baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
  }

  #alert(message) {
    console.error(message);
    // Wire this to your notification channel of choice.
  }
}

/**
 * Responses are fetched as text and parsed lazily: DataDome returns an HTML
 * challenge page on 403, and a JSON parse of that would throw before #guard
 * ever got the chance to say "this is a block, do not retry".
 */
function wrap(response) {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

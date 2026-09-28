/**
 * Logs in to the JLR EPC over plain HTTP and hands out the token the
 * catalogue API accepts. No browser.
 *
 * The chain, verified against the live site on 2026-09-24:
 *
 *   1. EPC authorize (Salesforce SLAS, PKCE, hint=forgerock-iepc)
 *        -> 303 to JLR ForgeRock authorize (realm b2b)
 *   2. ForgeRock JSON login, tree iepc-login: username + password only
 *        -> SSOSession cookie
 *   3. ForgeRock authorize again, now with the session
 *        -> redirects back to /callback/forgerock?code=...&usid=...
 *   4. SLAS token endpoint: code + PKCE verifier
 *        -> access_token (30 min) + refresh_token
 *   5. /apigee-token with that access token
 *        -> the "rdm" token the /mobify/proxy/apigee catalogue calls use
 *
 * Token state is cached encrypted on disk (jlr/.cache), so restarts do not
 * log in again. What happens when the rdm token is needed:
 *
 *   rdm token < 55 min old          use it
 *   access token still valid        step 5 only
 *   refresh token                   refresh, then step 5
 *   otherwise, or refresh rejected  full login (steps 1-5)
 *
 * If JLR ever adds MFA to the account, step 2 returns callbacks beyond
 * username/password and login stops with a JlrAuthError saying which.
 */

import { createHash, randomBytes } from 'node:crypto';

import { CookieJar } from 'tough-cookie';

import { cache } from './cache.js';
import { config } from './config.js';
import { JlrAuthError, JlrError } from './errors.js';
import { open, seal } from './secretbox.js';

const STATE_KEY = 'jlr:auth';
const RDM_TTL_MS = 55 * 60 * 1000; // the EPC itself renews after 59 minutes
const ACCESS_MARGIN_MS = 60 * 1000;

const b64url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class JlrAuth {
  #state = null;
  #pending = null;

  /** `fetchImpl` is injectable so the chain can be tested without JLR. */
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
  }

  /** The bearer token for catalogue calls, logging in or refreshing as needed. */
  async rdmToken() {
    const state = await this.#load();
    if (state?.rdmToken && Date.now() < state.rdmExpiresAt) return state.rdmToken;
    return this.#once(() => this.#renew());
  }

  /**
   * Called after a 401/403 from the catalogue. Drops the rdm token so the
   * next call fetches a new one; with `full`, drops everything and logs in.
   */
  async invalidate({ full = false } = {}) {
    const state = (await this.#load()) ?? {};
    const next = full ? {} : { ...state, rdmToken: null, rdmExpiresAt: 0 };
    await this.#save(next);
  }

  /** Forget the session entirely. The next call logs in from scratch. */
  async logout() {
    this.#state = {};
    await cache.forget(STATE_KEY);
  }

  /** Force a full login now. Returns non-secret facts about the session. */
  async login() {
    await this.#once(() => this.#fullLogin().then((state) => this.#withRdm(state)));
    return this.whoami();
  }

  async whoami() {
    const state = await this.#load();
    if (!state?.accessToken) return { loggedIn: false };
    return {
      loggedIn: true,
      email: config.email,
      customerId: state.customerId ?? null,
      accessTokenExpires: new Date(state.accessExpiresAt).toISOString(),
      catalogueTokenExpires: state.rdmExpiresAt ? new Date(state.rdmExpiresAt).toISOString() : null,
      canRefresh: Boolean(state.refreshToken),
    };
  }

  // ------------------------------------------------------------- renewal

  /** Concurrent callers share one renewal instead of logging in twice. */
  async #once(work) {
    if (!this.#pending) this.#pending = work().finally(() => (this.#pending = null));
    return this.#pending;
  }

  async #renew() {
    let state = (await this.#load()) ?? {};

    if (!state.accessToken || Date.now() >= state.accessExpiresAt - ACCESS_MARGIN_MS) {
      state = (state.refreshToken && (await this.#refresh(state))) || (await this.#fullLogin());
    }

    try {
      return await this.#withRdm(state);
    } catch (error) {
      // An access token JLR has since revoked: log in once more, then give up.
      if (!(error instanceof JlrAuthError)) throw error;
      return this.#withRdm(await this.#fullLogin());
    }
  }

  async #withRdm(state) {
    const response = await this.#http(`${config.baseUrl}/apigee-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.accessToken}` },
      body: JSON.stringify({ usid: state.usid }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || !body.token) {
      throw new JlrAuthError(`JLR /apigee-token returned HTTP ${response.status} without a token.`);
    }

    const next = { ...state, rdmToken: String(body.token), rdmExpiresAt: Date.now() + RDM_TTL_MS };
    await this.#save(next);
    return next.rdmToken;
  }

  /** Refresh-token grant. Returns null (not an error) when JLR declines it. */
  async #refresh(state) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
      client_id: config.slas.clientId,
      redirect_uri: redirectUri(),
      channel_id: config.slas.siteId,
    });
    const response = await this.#http(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) return null;

    return this.#fromTokenResponse(body, state);
  }

  async #fullLogin() {
    if (!config.email || !config.password) {
      throw new JlrAuthError('JLR_EPC_EMAIL and JLR_EPC_PASSWORD are not configured.');
    }

    const jar = new CookieJar();
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash('sha256').update(verifier).digest());

    // 1. EPC authorize -> ForgeRock authorize URL.
    const start = new URL(`${slasBase()}/oauth2/authorize`);
    start.search = new URLSearchParams({
      channel_id: config.slas.siteId,
      redirect_uri: redirectUri(),
      client_id: config.slas.clientId,
      code_challenge: challenge,
      hint: config.slas.hint,
    }).toString();

    const first = await this.#http(start.toString(), {}, jar);
    const forgerockAuthorize = first.headers.get('location');
    if (!forgerockAuthorize) {
      throw new JlrAuthError(`JLR login could not start: the EPC authorize step returned HTTP ${first.status}.`);
    }

    // 2. ForgeRock JSON login.
    await this.#forgerockLogin(jar);

    // 3. Authorize again with the session, following redirects to the callback.
    let url = new URL(forgerockAuthorize, start).toString();
    for (let hop = 0; hop < 10 && !url.startsWith(redirectUri()); hop++) {
      const response = await this.#http(url, {}, jar);
      const next = response.headers.get('location');
      if (!next) {
        throw new JlrAuthError(
          `JLR login stopped at ${new URL(url).host}${new URL(url).pathname} (HTTP ${response.status}) ` +
            'instead of returning to the EPC - it may be asking for consent or another step.',
        );
      }
      url = new URL(next, url).toString();
    }

    const callback = new URL(url);
    const code = callback.searchParams.get('code');
    const usid = callback.searchParams.get('usid');
    if (!code) throw new JlrAuthError('JLR login returned to the EPC without an authorisation code.');

    // 4. Code -> access + refresh token.
    const response = await this.#http(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code_pkce',
        code_verifier: verifier,
        client_id: config.slas.clientId,
        redirect_uri: redirectUri(),
        usid: usid ?? '',
        channel_id: config.slas.siteId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new JlrAuthError(`JLR token exchange failed (HTTP ${response.status}).`);
    }

    console.error('jlr: signed in, session cached');
    return this.#fromTokenResponse(body, { usid });
  }

  async #forgerockLogin(jar) {
    const url =
      `${config.forgerock.baseUrl}/json/realms/root/realms/${encodeURIComponent(config.forgerock.realm)}` +
      `/authenticate?authIndexType=service&authIndexValue=${encodeURIComponent(config.forgerock.tree)}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-API-Version': 'protocol=1.0,resource=2.1',
      'X-Requested-With': 'forgerock-sdk',
    };

    let body = await (await this.#http(url, { method: 'POST', headers }, jar)).json();

    for (let round = 0; round < 5; round++) {
      const callbacks = body.callbacks ?? [];
      const unknown = callbacks.map((c) => c.type).filter((t) => t !== 'NameCallback' && t !== 'PasswordCallback');
      if (unknown.length > 0) {
        throw new JlrAuthError(
          `JLR login is asking for more than a username and password (${unknown.join(', ')}). ` +
            'This needs a person - log in on jlrepc.com once to see what it wants.',
        );
      }

      for (const callback of callbacks) {
        if (callback.type === 'NameCallback') callback.input[0].value = config.email;
        if (callback.type === 'PasswordCallback') callback.input[0].value = config.password;
      }

      const response = await this.#http(url, { method: 'POST', headers, body: JSON.stringify(body) }, jar);
      body = await response.json().catch(() => ({}));

      if (response.status === 401) {
        throw new JlrAuthError(`JLR rejected the login: ${body.message || 'check JLR_EPC_EMAIL and JLR_EPC_PASSWORD'}.`);
      }
      if (!response.ok) throw new JlrAuthError(`JLR login returned HTTP ${response.status}.`);
      if (body.tokenId) return;
    }

    throw new JlrAuthError('JLR login did not complete after five steps.');
  }

  #fromTokenResponse(body, previous) {
    return {
      accessToken: body.access_token,
      accessExpiresAt: Date.now() + (Number(body.expires_in) || 1800) * 1000,
      refreshToken: body.refresh_token ?? previous.refreshToken ?? null,
      usid: body.usid ?? previous.usid ?? null,
      customerId: body.customer_id ?? previous.customerId ?? null,
      rdmToken: null,
      rdmExpiresAt: 0,
    };
  }

  // ------------------------------------------------------------ plumbing

  async #http(url, init = {}, jar = null) {
    const headers = new Headers(init.headers ?? {});
    headers.set('User-Agent', config.userAgent);
    if (jar) {
      const cookie = await jar.getCookieString(url);
      if (cookie) headers.set('Cookie', cookie);
    }

    let response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeout),
      });
    } catch (error) {
      throw new JlrError(`Could not reach ${new URL(url).host}: ${error.message}`, { cause: error });
    }

    if (jar) {
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        await jar.setCookie(cookie, url).catch(() => {});
      }
    }
    return response;
  }

  async #load() {
    if (this.#state) return this.#state;
    const sealed = await cache.get(STATE_KEY);
    this.#state = sealed ? open(sealed) ?? {} : {};
    return this.#state;
  }

  async #save(state) {
    this.#state = state;
    // Kept as long as the refresh token could be useful; JLR decides when
    // it actually expires, and a rejected refresh just means a full login.
    await cache.put(STATE_KEY, seal(state), 60 * 60 * 24 * 30);
  }
}

const slasBase = () =>
  `${config.baseUrl}/mobify/proxy/api/shopper/auth/v1/organizations/${config.slas.organizationId}`;
const tokenUrl = () => `${slasBase()}/oauth2/token`;
const redirectUri = () => `${config.baseUrl}/callback/forgerock`;

import got from 'got';
import { CookieJar } from 'tough-cookie';

import { config } from './config.js';
import { JlrBrowserSession } from './browserSession.js';

export class JlrClient {
  #jar = new CookieJar();
  #authenticated = false;
  #browserSession = config.sessionCookie || config.apigeeToken ? null : new JlrBrowserSession();

  async postJson(path, body) {
    if (this.#browserSession) return this.#browserSession.postJson(path, body);
    await this.#ensureAuthenticated();
    const response = await got(this.#url(path), {
      cookieJar: this.#jar,
      method: 'POST',
      json: body,
      headers: this.#headers(),
      timeout: { request: config.timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      responseType: 'json',
    });

    if (response.statusCode === 401) {
      this.#authenticated = false;
      throw new Error(
        `JLR returned HTTP 401 from ${path}. Set a current JLR_SESSION_COOKIE and, if required by the account, JLR_APIGEE_TOKEN.`,
      );
    }
    if (response.statusCode >= 400) {
      throw new Error(`JLR returned HTTP ${response.statusCode} from ${path}.`);
    }

    return response.body;
  }

  async #ensureAuthenticated() {
    if (this.#authenticated || config.sessionCookie || config.apigeeToken) return;
    if (!config.email || !config.password) {
      throw new Error('JLR_EPC_EMAIL and JLR_EPC_PASSWORD are not configured.');
    }

    const url = `${config.authBaseUrl.replace(/\/+$/, '')}/json/realms/${encodeURIComponent(config.authRealm)}/authenticate`;
    const query = new URLSearchParams({
      authIndexType: 'service',
      authIndexValue: config.authTree,
    });
    const baseOptions = {
      cookieJar: this.#jar,
      headers: {
        ...this.#headers(),
        Accept: 'application/json',
        'Accept-API-Version': 'protocol=1.0,resource=2.1',
        'X-Requested-With': 'forgerock-sdk',
        'Content-Type': 'application/json',
      },
      timeout: { request: config.timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      responseType: 'json',
    };

    let response = await got(`${url}?${query}`, { ...baseOptions, method: 'POST' });
    let body = response.body;
    if (response.statusCode >= 400 || !body?.authId) {
      throw new Error(`JLR login could not start (HTTP ${response.statusCode}).`);
    }

    const callbacks = body.callbacks ?? [];
    for (const callback of callbacks) {
      const type = callback.type;
      const inputs = callback.input ?? [];
      const name = inputs.find((input) => input.name === 'IDToken1') || inputs.find((input) => /username|name/i.test(input.name));
      const password = inputs.find((input) => input.name === 'IDToken2') || inputs.find((input) => /password/i.test(input.name));
      if (type === 'NameCallback' && name) name.value = config.email;
      if (type === 'PasswordCallback' && password) password.value = config.password;
    }

    response = await got(`${url}?${query}`, {
      ...baseOptions,
      method: 'POST',
      json: { ...body, callbacks },
    });
    body = response.body;

    if (response.statusCode >= 400 || body?.code || body?.callbacks) {
      throw new Error('JLR login was rejected or requires an interactive step (MFA/CAPTCHA).');
    }

    if (body?.tokenId) {
      this.#jar.setCookie(`iPlanetDirectoryPro=${body.tokenId}`, config.authBaseUrl);
    }
    this.#authenticated = true;
  }

  #url(path) {
    return `${config.baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
  }

  #headers() {
    const headers = {
      'User-Agent':
        process.env.JLR_USER_AGENT ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: `${config.baseUrl.replace(/\/+$/, '')}/jlr-epc/en-GB/home`,
    };

    if (config.sessionCookie) headers.Cookie = config.sessionCookie;
    if (config.apigeeToken) {
      headers.Authorization = config.apigeeToken.startsWith('Bearer ')
        ? config.apigeeToken
        : `Bearer ${config.apigeeToken}`;
    }
    return headers;
  }
}
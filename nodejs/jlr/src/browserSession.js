import path from 'node:path';
import { chromium } from 'playwright';

import { config } from './config.js';

const ENTRY_URL = `${config.baseUrl.replace(/\/+$/, '')}/jlr-epc/en-GB`;
const LOGIN_URL =
  'https://enterprise.jaguarlandrover.com/business/?realm=b2b&authIndexType=service&authIndexValue=iepc-login' +
  '&goto=https:%2F%2Fwww.jlrepc.com%2Fcallback%2Fforgerock' +
  '&gotoOnFail=https:%2F%2Fwww.jlrepc.com%2Fcallback%2Fforgerock-fail';

export class JlrBrowserSession {
  #context = null;
  #page = null;
  #loginPromise = null;

  async postJson(pathname, body) {
    await this.#login();
    const response = await this.#pageFetch(pathname, body);

    if (response.status() === 401) {
      await this.#login(true);
      const retry = await this.#pageFetch(pathname, body);
      if (retry.status() === 401) throw new Error(`JLR session expired while calling ${pathname}.`);
      if (!retry.ok()) throw new Error(`JLR returned HTTP ${retry.status()} from ${pathname}.`);
      return retry.json();
    }

    if (!response.ok()) throw new Error(`JLR returned HTTP ${response.status()} from ${pathname}.`);
    return response.json();
  }

  async #pageFetch(pathname, body) {
    const result = await this.#page.evaluate(async ({ url, payload }) => {
      const token = [...Object.values(localStorage), ...Object.values(sessionStorage)]
        .map((value) => {
          try { return JSON.parse(value); } catch { return null; }
        })
        .find((value) => value?.accessToken)?.accessToken;
      const headers = { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.text() };
    }, { url: this.#url(pathname), payload: body });

    return {
      status: () => result.status,
      ok: () => result.status >= 200 && result.status < 300,
      json: () => JSON.parse(result.body),
    };
  }

  async #login(force = false) {
    if (this.#loginPromise) return this.#loginPromise;
    this.#loginPromise = this.#authenticate(force).finally(() => {
      this.#loginPromise = null;
    });
    return this.#loginPromise;
  }

  async #authenticate(force) {
    if (force && this.#context) await this.#context.clearCookies();
    if (!this.#context) {
      this.#context = await chromium.launchPersistentContext(
        path.resolve(config.profileDir),
        { headless: config.browserHeadless, viewport: { width: 1440, height: 900 } },
      );
    }

    this.#page = this.#context.pages()[0] || (await this.#context.newPage());
    await this.#page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: config.timeout });

    const independent = this.#page.getByRole('button', { name: 'Independent', exact: true });
    if (await independent.count() && await independent.isEnabled()) {
      await independent.click();
    } else if (!this.#page.url().includes('enterprise.jaguarlandrover.com')) {
      await this.#page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    }

    const username = this.#page.locator('#username');
    const password = this.#page.locator('#password');
    if (await username.count() && await password.count()) {
      if (!config.email || !config.password) {
        throw new Error('JLR_EPC_EMAIL and JLR_EPC_PASSWORD are not configured.');
      }
      await username.fill(config.email);
      await password.fill(config.password);
      await this.#page.getByRole('button', { name: 'Login', exact: true }).click();
    }

    try {
      await this.#page.waitForURL(/jlrepc\.com\/jlr-epc\//, { timeout: config.loginTimeout });
    } catch {
      throw new Error(
        'JLR login did not complete. Complete any MFA/CAPTCHA in the opened browser, then retry.',
      );
    }
  }

  #url(pathname) {
    return `${config.baseUrl.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
  }

  #headers() {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Referer: `${config.baseUrl.replace(/\/+$/, '')}/jlr-epc/en-GB/home`,
    };
  }
}
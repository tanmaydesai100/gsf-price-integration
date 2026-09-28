import { randomUUID } from 'node:crypto';

import { JlrAuth } from './auth.js';
import { config } from './config.js';
import { JlrAuthError, JlrError, JlrUpstreamError } from './errors.js';

/**
 * POST-JSON to the EPC catalogue API, authenticated with the token JlrAuth
 * provides. Plain HTTP; see auth.js for how the token is obtained.
 *
 * Headers match what the EPC front end sends to /mobify/proxy/apigee:
 * a bearer token and a fresh rdm-transaction-id per request.
 */
export class JlrClient {
  constructor({ auth = new JlrAuth(), fetchImpl = globalThis.fetch } = {}) {
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  async postJson(path, body) {
    let response = await this.#send(path, body);

    // Expired catalogue token: fetch a new one. Still refused: log in again.
    for (const full of [false, true]) {
      if (response.status !== 401 && response.status !== 403) break;
      await this.auth.invalidate({ full });
      response = await this.#send(path, body);
    }

    if (response.status === 401 || response.status === 403) {
      throw new JlrAuthError(`JLR refused ${path} (HTTP ${response.status}) even after logging in again.`);
    }
    if (!response.ok) {
      throw new JlrUpstreamError(`JLR returned HTTP ${response.status} from ${path}.`, {
        status: response.status,
        path,
      });
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new JlrUpstreamError(`JLR returned a non-JSON response from ${path}.`, { path });
    }
  }

  /** Nothing to release: kept so callers can close any client the same way. */
  async close() {}

  async #send(path, body) {
    const token = await this.auth.rdmToken();
    const url = `${config.baseUrl}/${String(path).replace(/^\/+/, '')}`;

    try {
      return await this.fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': config.userAgent,
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'rdm-transaction-id': randomUUID(),
          Origin: config.baseUrl,
          Referer: `${config.baseUrl}/jlr-epc/en-GB/home`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeout),
      });
    } catch (error) {
      throw new JlrError(`Could not reach JLR for ${path}: ${error.message}`, { cause: error });
    }
  }
}

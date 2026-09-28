/**
 * The JLR login chain against a fake JLR - no network.
 *
 *   node --test jlr/test/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jlr-auth-test-'));
process.env.JLR_CACHE_DIR = scratch;
process.env.JLR_APP_KEY = 'test-key';
process.env.JLR_EPC_EMAIL = 'user@example.com';
process.env.JLR_EPC_PASSWORD = 'secret';

const { JlrAuth } = await import('../src/auth.js');
const { JlrClient } = await import('../src/client.js');
const { JlrAuthError } = await import('../src/errors.js');
const { seal, open } = await import('../src/secretbox.js');
const { cache } = await import('../src/cache.js');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
test.beforeEach(() => cache.forget('jlr:auth'));

const EPC = 'https://www.jlrepc.com';
const FR = 'https://enterprise.jaguarlandrover.com/auth';

/** A fake JLR that follows the real chain and counts what was called. */
function fakeJlr({ extraCallback = null, catalogueRejects = 0, refreshWorks = true } = {}) {
  const calls = [];
  let issued = 0;
  let rejects = catalogueRejects;

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const redirect = (location, cookie) => {
    const headers = new Headers({ Location: location });
    if (cookie) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const route = `${u.host}${u.pathname}`;
    calls.push(route);
    const headers = new Headers(init.headers);

    if (route.endsWith('/oauth2/authorize') && u.host === 'www.jlrepc.com') {
      return redirect(`${FR}/oauth2/realms/root/realms/b2b/authorize?client_id=IEPCPortalClient`);
    }
    if (route.endsWith('/b2b/authenticate')) {
      const body = init.body ? JSON.parse(init.body) : null;
      if (!body) {
        const callbacks = [
          { type: 'NameCallback', input: [{ name: 'IDToken1', value: '' }] },
          { type: 'PasswordCallback', input: [{ name: 'IDToken2', value: '' }] },
        ];
        return json(200, { authId: 'a1', callbacks });
      }
      if (body.callbacks?.some((c) => c.type === 'NameCallback')) {
        const [name, pass] = body.callbacks.map((c) => c.input[0].value);
        if (name !== 'user@example.com' || pass !== 'secret') return json(401, { message: 'Login failure' });
        if (extraCallback) return json(200, { authId: 'a2', callbacks: [{ type: extraCallback, output: [] }] });
        return new Response(JSON.stringify({ tokenId: 'sso-1', successUrl: '/auth/console' }), {
          status: 200,
          headers: { 'Set-Cookie': 'SSOSession=sso-1; Path=/; Secure' },
        });
      }
    }
    if (route.endsWith('/b2b/authorize')) {
      assert.match(headers.get('cookie') ?? '', /SSOSession=sso-1/, 'the session cookie must be sent');
      return redirect(`${EPC}/callback/forgerock?code=c1&usid=u1`);
    }
    if (route.endsWith('/oauth2/token')) {
      const form = new URLSearchParams(init.body.toString());
      if (form.get('grant_type') === 'refresh_token' && !refreshWorks) return json(400, { message: 'invalid refresh_token' });
      issued += 1;
      return json(200, { access_token: `access-${issued}`, refresh_token: 'refresh-1', expires_in: 1800, usid: 'u1', customer_id: 'cust' });
    }
    if (route.endsWith('/apigee-token')) {
      assert.match(headers.get('authorization'), /^Bearer access-/);
      return json(200, { token: `rdm-${issued}` });
    }
    if (route.includes('/mobify/proxy/apigee/')) {
      assert.ok(headers.get('rdm-transaction-id'), 'every catalogue call carries a transaction id');
      if (rejects > 0) { rejects -= 1; return json(401, {}); }
      return json(200, { ok: true, auth: headers.get('authorization') });
    }
    return json(404, {});
  };

  return { fetchImpl, calls };
}

const count = (calls, fragment) => calls.filter((c) => c.includes(fragment)).length;

test('logs in through the whole chain and returns the catalogue token', async () => {
  const jlr = fakeJlr();
  const token = await new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken();
  assert.equal(token, 'rdm-1');
  assert.equal(count(jlr.calls, '/b2b/authenticate'), 2);
  assert.equal(count(jlr.calls, '/apigee-token'), 1);
});

test('a cached session is reused across instances - no second login', async () => {
  const jlr = fakeJlr();
  await new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken();
  const before = jlr.calls.length;

  const again = await new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken();
  assert.equal(again, 'rdm-1');
  assert.equal(jlr.calls.length, before, 'a restart must not touch the network');
});

test('an expired access token is refreshed, not re-logged-in', async () => {
  const jlr = fakeJlr();
  const auth = new JlrAuth({ fetchImpl: jlr.fetchImpl });
  await auth.rdmToken();

  // Age the cached session past both expiries.
  const sealed = await cache.get('jlr:auth');
  const state = open(sealed);
  await cache.put('jlr:auth', seal({ ...state, accessExpiresAt: 0, rdmExpiresAt: 0 }), 3600);

  const fresh = new JlrAuth({ fetchImpl: jlr.fetchImpl });
  assert.equal(await fresh.rdmToken(), 'rdm-2');
  assert.equal(count(jlr.calls, '/b2b/authenticate'), 2, 'no second password login');
});

test('a rejected refresh falls back to a full login', async () => {
  const jlr = fakeJlr({ refreshWorks: false });
  await new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken();
  const state = open(await cache.get('jlr:auth'));
  await cache.put('jlr:auth', seal({ ...state, accessExpiresAt: 0, rdmExpiresAt: 0 }), 3600);

  assert.equal(await new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken(), 'rdm-2');
  assert.equal(count(jlr.calls, '/b2b/authenticate'), 4, 'logged in again');
});

test('a 401 from the catalogue gets a new token and the call succeeds', async () => {
  const jlr = fakeJlr({ catalogueRejects: 1 });
  const client = new JlrClient({ auth: new JlrAuth({ fetchImpl: jlr.fetchImpl }), fetchImpl: jlr.fetchImpl });
  const reply = await client.postJson('/mobify/proxy/apigee/iepc/catalogue/api/v1/catEntries', {});
  assert.equal(reply.ok, true);
  assert.equal(count(jlr.calls, '/apigee-token'), 2);
});

test('an MFA step stops login with a clear error, never a loop', async () => {
  const jlr = fakeJlr({ extraCallback: 'ChoiceCallback' });
  await assert.rejects(
    new JlrAuth({ fetchImpl: jlr.fetchImpl }).rdmToken(),
    (error) => error instanceof JlrAuthError && /ChoiceCallback/.test(error.message),
  );
});

test('wrong credentials are reported as an auth error', async () => {
  const { config } = await import('../src/config.js');
  const saved = config.password;
  config.password = 'wrong';
  try {
    await assert.rejects(new JlrAuth({ fetchImpl: fakeJlr().fetchImpl }).rdmToken(), /rejected the login/);
  } finally {
    config.password = saved;
  }
});

test('the cached session is encrypted, and unreadable with another key', async () => {
  const sealed = seal({ refreshToken: 'refresh-1' });
  assert.ok(!sealed.includes('refresh-1'));
  assert.deepEqual(open(sealed), { refreshToken: 'refresh-1' });

  const { config } = await import('../src/config.js');
  const saved = config.appKey;
  config.appKey = 'another-key';
  try {
    assert.equal(open(sealed), null);
  } finally {
    config.appKey = saved;
  }
});

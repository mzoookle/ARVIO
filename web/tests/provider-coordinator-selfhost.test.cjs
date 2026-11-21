'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load.cjs');

const cloudConfig = { selfHosted: true, netlifyBackendUrl: 'https://arvio-sync.example.net/.netlify/functions' };

function providerMocks() {
  const calls = [];
  const mock = async (provider, profile, action, extra = {}) => {
    calls.push({ provider, profile, action, extra });
    if (action === 'status') return { connected: true };
    if (action === 'start') return { userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.example.test/activate', expiresIn: 900, interval: 5 };
    if (action === 'poll') return { connected: true };
    if (action === 'disconnect') return { disconnected: true };
    throw Error('Unexpected action: ' + action);
  };
  const request = async (provider, profile, path, method, body) => {
    calls.push({ provider, profile, action: 'request', path, method, body });
    return { data: [], headers: new Headers({ 'x-pagination-page-count': '1' }) };
  };
  return { calls, module: { providerCoordinator: mock, providerCoordinatorRequest: request } };
}

test('selfhost gateway sends native ARVIO bearer; no provider grants or browser cookies', async () => {
  const calls = [];
  let session = { userId: 'native-account-1' };
  const gateway = load('lib/providerCoordinator.ts', {
    './config': { config: cloudConfig },
    './http': { HttpError: class HttpError extends Error { constructor(status, message, retry) { super(message); this.status=status; this.retryAfter=retry; } } },
    './store/clients': { authClient: { get session() { return session; }, accessToken: async () => 'native-arvio-jwt' } }
  }, {
    fetch: async (url, options) => {
      calls.push({url, options});
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ connected: true }) };
    }
  });
  const status = await gateway.providerCoordinator('simkl', 'profile-1', 'status');
  assert.equal(status.connected, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://arvio-sync.example.net/.netlify/functions/provider-coordinator');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer native-arvio-jwt');
  assert.equal(calls[0].options.credentials, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { provider: 'simkl', profileId: 'profile-1', action: 'status' });
  session = { userId: 'other-account' };
  await assert.rejects(() => gateway.providerCoordinator('simkl', '', 'status'), /valid ARVIO profile/);
});

test('SIMKL selfhost restores cloud connection without storing refresh grants; all API calls use gateway', async () => {
  const mocked = providerMocks();
  const store = storage();
  const simkl = load('lib/simkl.ts', {
    './config': { config: cloudConfig },
    './providerCoordinator': mocked.module,
    './store/clients': { authClient: { session: { userId: 'account-1' } } },
    './storage': store,
    './http': { jsonRequest: async () => { throw Error('Legacy HTTP called'); }, HttpError: Error },
    './sync': {},
    './tmdb': {},
    './simklV2': {}
  });
  const client = new simkl.SimklClient();
  client.setProfile('profile-1');
  await client.restoreSession();
  assert.equal(client.isConnected, true);
  const stored = [...store.values.values()];
  assert.ok(stored.every(value => !JSON.stringify(value).includes('refresh_token')));
  await client.customListsRequest('/lists/user/42');
  assert.ok(mocked.calls.some(c => c.action === 'request' && c.path === '/lists/user/42' && c.provider === 'simkl'));
  await client.disconnect();
  assert.equal(client.isConnected, false);
  assert.ok(mocked.calls.some(c => c.action === 'disconnect'));
});

test('WeTrakr selfhost restores gateway connection and preserves pagination headers', async () => {
  const mocked = providerMocks();
  const we = load('lib/wetrakr.ts', {
    './config': { config: cloudConfig },
    './providerCoordinator': mocked.module,
    './sync': {}
  });
  const client = new we.WeTrakrClient();
  client.setProfile('profile-1');
  await client.restoreSession();
  assert.equal(client.isConnected, true);
  assert.equal((await client.watchlist()).length, 0);
  assert.ok(mocked.calls.some(c => c.action === 'request' && c.path.startsWith('/sync/tracking/planning/all?limit=100')));
  await client.disconnect();
  assert.equal(client.isConnected, false);
});

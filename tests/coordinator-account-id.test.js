"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// No real DB, credentials, or provider network access in this test.
const nativeId = "11111111-1111-4111-8111-111111111111";
const dbAccountId = "22222222-2222-4222-8222-222222222222";
const originalLoad = Module._load;
const target = path.resolve(__dirname, "../netlify-auth-site/private-cloud/provider-coordinator.js");
let sqlCalls = [];
const client = {
  async query(sql, params = []) {
    sqlCalls.push({ sql, params });
    if (sql.includes("SELECT * FROM public.arvio_provider_credentials")) return { rows: [] };
    if (sql.includes("FROM public.arvio_provider_credentials")) return { rows: [] };
    return { rows: [] };
  },
  release() {}
};
const pool = { connect: async () => client, query: (...args) => client.query(...args) };
Module._load = function (name, parent, main) {
  if (parent?.filename === target && name === "../netlify/functions/_backend") {
    return { getPool: () => pool };
  }
  return originalLoad.apply(this, arguments);
};
let coordinator;
try { coordinator = require(target); } finally { Module._load = originalLoad; }
const backend = {
  options: () => null,
  resolveIdentity: async () => ({ supabaseUserId: nativeId, email: "test@example.net" }),
  getOrCreateAccount: async (dbClient, identity) => {
    assert.equal(dbClient, client);
    assert.equal(identity.supabaseUserId, nativeId);
    return { id: dbAccountId };
  },
  parseBody: (event) => JSON.parse(event.body)
};
function event(provider, action) {
  return { httpMethod: "POST", headers: {}, body: JSON.stringify({ provider, action, profileId: "profile123" }), queryStringParameters: {} };
}

test("status uses DB account ID, not native JWT subject", async () => {
  sqlCalls = [];
  const response = await coordinator.handle(event("simkl", "status"), backend);
  assert.equal(response.statusCode, 200, response.body);
  const lookup = sqlCalls.find(c => c.sql.includes("SELECT provider,status"));
  assert.ok(lookup);
  assert.deepEqual(lookup.params, [dbAccountId, "profile123", "simkl"]);
});

test("start writes pending authorization against DB account ID", async () => {
  sqlCalls = [];
  process.env.ARVIO_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SIMKL_V2_CLIENT_ID = "test-client-id";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    device_code: "test-device", user_code: "ABCD", verification_uri: "https://simkl.com/activate",
    expires_in: 600, interval: 5
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const response = await coordinator.handle(event("simkl", "start"), backend);
    assert.equal(response.statusCode, 200, response.body);
    const insert = sqlCalls.find(c => c.sql.includes("INSERT INTO public.arvio_provider_credentials"));
    assert.ok(insert, "expected pending credential insert");
    assert.equal(insert.params[0], dbAccountId);
    assert.notEqual(insert.params[0], nativeId);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.ARVIO_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.SIMKL_V2_CLIENT_ID;
  }
});


test("WeTrakr start writes pending authorization against DB account ID", async () => {
  sqlCalls = [];
  process.env.ARVIO_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.WETRAKR_CLIENT_ID = "test-wetrakr-client-id";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    device_code: "test-wetrakr-device", user_code: "WXYZ", verification_url: "https://wetrakr.com/activate",
    expires_in: 600, interval: 5
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const response = await coordinator.handle(event("wetrakr", "start"), backend);
    assert.equal(response.statusCode, 200, response.body);
    const insert = sqlCalls.find(c => c.sql.includes("INSERT INTO public.arvio_provider_credentials"));
    assert.ok(insert);
    assert.equal(insert.params[0], dbAccountId);
    assert.notEqual(insert.params[0], nativeId);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.ARVIO_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.WETRAKR_CLIENT_ID;
  }
});

"use strict";
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { getPool } = require("../netlify/functions/_backend");

const SIMKL_BASE = "https://api.simkl.com";
const WETRAKR_BASE = "https://api.wetrakr.com";
const SIMKL_PATHS = [
  /^\/users\/settings$/, /^\/sync\/activities$/, /^\/sync\/all-items(?:\/.*)?$/,
  /^\/sync\/playback(?:\/.*)?$/, /^\/sync\/history$/, /^\/sync\/history\/remove$/,
  /^\/sync\/add-to-list$/, /^\/scrobble\/(?:start|pause|stop)$/,
  /^\/lists\/\d+$/, /^\/lists\/user\/\d+$/
];
const WETRAKR_PATHS = [
  // Library reads and tracking writes used by ARVIO's RemoteSyncProvider.
  /^\/sync\/tracking\/(?:planning|watching|watched|hold|dropped|playing)\/(?:all|movies|shows|movie|show|episodes)\/?$/,
  /^\/sync\/tracking\/?$/,
  /^\/sync\/tracking\/remove(?:\/all)?\/?$/,
  // Custom-list index, membership lookup, list item pages and membership writes.
  /^\/sync\/lists\/?$/,
  /^\/sync\/lists\/item\/(?:movie|show)\/\d+\/?$/,
  /^\/sync\/lists\/\d+\/items(?:\/remove)?\/?$/,
  /^\/discover\/recommended$/,
  /^\/media\/external\/tmdb\/\d+$/,
  /^\/scrobble\/(?:playing|start|pause|stop)$/
];

function key() {
  const raw = process.env.ARVIO_CREDENTIAL_ENCRYPTION_KEY || "";
  let decoded;
  try { decoded = Buffer.from(raw, "base64"); } catch {}
  if (!decoded || decoded.length !== 32) throw new Error("ARVIO_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return decoded;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
function decrypt(value) {
  if (!value) return null;
  const [version, iv, tag, body] = String(value).split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unsupported credential ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
}
function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers }, body: JSON.stringify(body) };
}
function safeProfile(value) {
  const profile = String(value || "").trim();
  if (!profile || profile.length > 128 || /[\u0000-\u001f]/.test(profile)) throw Object.assign(new Error("invalid_profile"), { statusCode: 400 });
  return profile;
}
function providerConfig(provider) {
  if (provider === "simkl") {
    const clientId = process.env.SIMKL_V2_CLIENT_ID || process.env.SIMKL_CLIENT_ID || "";
    if (!clientId) throw new Error("SIMKL_V2_CLIENT_ID is not configured");
    return { base: SIMKL_BASE, clientId, headers: { "simkl-api-key": clientId, "user-agent": "ARVIO Private Cloud" } };
  }
  if (provider === "wetrakr") {
    const clientId = process.env.WETRAKR_CLIENT_ID || "";
    if (!clientId) throw new Error("WETRAKR_CLIENT_ID is not configured");
    return { base: WETRAKR_BASE, clientId, headers: { "wetrakr-api-key": clientId, "wetrakr-api-version": "1", "user-agent": "ARVIO Private Cloud" } };
  }
  throw Object.assign(new Error("unsupported_provider"), { statusCode: 400 });
}
async function providerFetch(provider, path, method, body, accessToken) {
  const cfg = providerConfig(provider);
  const url = new URL(path, cfg.base);
  const headers = { ...cfg.headers, accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let payload;
  if (body !== undefined && body !== null && method !== "GET") {
    if (provider === "simkl" && path.startsWith("/oauth2/")) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(20000), redirect: "error" });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: "invalid_provider_response" }; }
  return { status: response.status, data, headers: { retryAfter: response.headers.get("retry-after"), pageCount: response.headers.get("x-pagination-page-count"), page: response.headers.get("x-pagination-page"), limit: response.headers.get("x-pagination-limit"), itemCount: response.headers.get("x-pagination-item-count") } };
}
async function withCredential(accountId, profileId, provider, work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '8s'");
    const found = await client.query(
      "SELECT * FROM public.arvio_provider_credentials WHERE account_id=$1 AND profile_id=$2 AND provider=$3 FOR UPDATE",
      [accountId, profileId, provider]);
    const row = found.rows[0] || null;
    const result = await work(client, row);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
async function upsert(client, accountId, profileId, provider, fields) {
  await client.query(`INSERT INTO public.arvio_provider_credentials
    (account_id,profile_id,provider,status,secret_ciphertext,pending_ciphertext,provider_user_id,provider_username,scopes,expires_at,refresh_expires_at,connected_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
    ON CONFLICT (account_id,profile_id,provider) DO UPDATE SET status=EXCLUDED.status,
    secret_ciphertext=EXCLUDED.secret_ciphertext,pending_ciphertext=EXCLUDED.pending_ciphertext,
    provider_user_id=EXCLUDED.provider_user_id,provider_username=EXCLUDED.provider_username,
    scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,refresh_expires_at=EXCLUDED.refresh_expires_at,
    connected_at=EXCLUDED.connected_at,updated_at=now()`,
  [accountId, profileId, provider, fields.status, fields.secret ? encrypt(fields.secret) : null,
    fields.pending ? encrypt(fields.pending) : null, fields.userId || null, fields.username || null,
    fields.scopes || [], fields.expiresAt ? new Date(fields.expiresAt) : null,
    fields.refreshExpiresAt ? new Date(fields.refreshExpiresAt) : null,
    fields.status === "connected" ? new Date() : null]);
}
function publicStatus(row) {
  return { provider: row?.provider, status: row?.status || "disconnected", connected: row?.status === "connected",
    username: row?.provider_username || null, connectedAt: row?.connected_at || null,
    expiresAt: row?.expires_at || null, refreshExpiresAt: row?.refresh_expires_at || null };
}
async function start(provider, accountId, profileId) {
  return withCredential(accountId, profileId, provider, async (client, row) => {
    if (provider === "simkl") {
      const cfg = providerConfig(provider);
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const result = await providerFetch(provider, "/oauth2/device", "POST", {
        client_id: cfg.clientId, scope: "media:read media:write", code_challenge: challenge, code_challenge_method: "S256"
      });
      if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(result.data.error || "provider_error"), { statusCode: 502 });
      const d = result.data;
      const pending = { deviceCode: d.device_code, userCode: d.user_code, url: d.verification_uri_complete || d.verification_uri,
        expiresAt: Date.now() + Number(d.expires_in || 900) * 1000, interval: Math.max(5, Number(d.interval || 5)), verifier };
      await upsert(client, accountId, profileId, provider, { status: row?.status === "connected" ? "connected" : "pending", secret: row?.secret_ciphertext ? decrypt(row.secret_ciphertext) : null, expiresAt: row?.expires_at ? new Date(row.expires_at).getTime() : null, pending });
      return { userCode: pending.userCode, verificationUrl: pending.url, expiresIn: Number(d.expires_in || 900), interval: pending.interval };
    }
    const result = await providerFetch(provider, "/oauth/device/code", "POST", { client_id: providerConfig(provider).clientId });
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error("provider_error"), { statusCode: 502 });
    const d = result.data;
    const pending = { deviceCode: d.device_code, userCode: d.user_code, url: d.verification_url,
      expiresAt: Date.now() + Math.min(1800, Number(d.expires_in || 600)) * 1000, interval: Math.max(5, Number(d.interval || 5)) };
    if (pending.url !== "https://wetrakr.com/activate" || !pending.deviceCode || !pending.userCode) throw new Error("Invalid WeTrakr device response");
    await upsert(client, accountId, profileId, provider, { status: row?.status === "connected" ? "connected" : "pending", secret: row?.secret_ciphertext ? decrypt(row.secret_ciphertext) : null, expiresAt: row?.expires_at ? new Date(row.expires_at).getTime() : null, pending });
    return { userCode: pending.userCode, verificationUrl: pending.url, expiresIn: Number(d.expires_in || 600), interval: pending.interval };
  });
}
async function poll(provider, accountId, profileId) {
  return withCredential(accountId, profileId, provider, async (client, row) => {
    const pending = decrypt(row?.pending_ciphertext);
    if (!pending || pending.expiresAt <= Date.now()) throw Object.assign(new Error("device_code_expired"), { statusCode: 410 });
    let result;
    if (provider === "simkl") result = await providerFetch(provider, "/oauth2/token", "POST", { client_id: providerConfig(provider).clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode, code_verifier: pending.verifier });
    else result = await providerFetch(provider, "/oauth/device/token", "POST", { code: pending.deviceCode, client_id: providerConfig(provider).clientId });
    if (result.status === 400 || result.status === 428 || result.data.error === "authorization_pending") return { connected: false, pending: true };
    if (result.status === 429) return { connected: false, pending: true, retryAfter: Number(result.headers.retryAfter || 10) };
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(result.data.error || "provider_error"), { statusCode: 502 });
    const d = result.data, access = d.access_token, refresh = d.refresh_token || d.new_refresh_token;
    if (!access || !refresh) throw new Error("Provider returned an incomplete credential grant");
    const expiresAt = Date.now() + Number(d.expires_in || 604800) * 1000;
    const secret = { accessToken: access, refreshToken: refresh, tokenType: d.token_type || "Bearer" };
    await upsert(client, accountId, profileId, provider, { status: "connected", secret, expiresAt,
      refreshExpiresAt: provider === "wetrakr" ? Date.now() + 180 * 86400000 : null, scopes: String(d.scope || "").split(/\s+/).filter(Boolean) });
    return { connected: true, status: "connected" };
  });
}
async function refreshIfNeeded(client, accountId, profileId, provider, row) {
  if (!row || row.status !== "connected" || !row.secret_ciphertext) throw Object.assign(new Error("connection_required"), { statusCode: 401 });
  let secret = decrypt(row.secret_ciphertext);
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > Date.now() + 60000) return { secret, row };
  const body = provider === "simkl" ? { client_id: providerConfig(provider).clientId, grant_type: "refresh_token", refresh_token: secret.refreshToken }
    : { refresh_token: secret.refreshToken };
  const result = await providerFetch(provider, provider === "simkl" ? "/oauth2/token" : "/oauth/token/refresh", "POST", body);
  if (result.status < 200 || result.status >= 300) {
    if ([400, 401, 403].includes(result.status) && /invalid_grant|invalid_refresh_token/i.test(JSON.stringify(result.data))) {
      await client.query("UPDATE public.arvio_provider_credentials SET status='reconnect_required',updated_at=now() WHERE account_id=$1 AND profile_id=$2 AND provider=$3", [accountId, profileId, provider]);
      throw Object.assign(new Error("reconnect_required"), { statusCode: 401 });
    }
    throw Object.assign(new Error("provider_temporarily_unavailable"), { statusCode: 503 });
  }
  const d = result.data;
  secret = { accessToken: d.access_token, refreshToken: d.refresh_token || d.new_refresh_token || secret.refreshToken, tokenType: d.token_type || "Bearer" };
  if (!secret.accessToken || !secret.refreshToken) throw new Error("Invalid refreshed provider grant");
  const expiresAt = Date.now() + Number(d.expires_in || 604800) * 1000;
  await client.query("UPDATE public.arvio_provider_credentials SET secret_ciphertext=$4,expires_at=$5,refresh_expires_at=$6,updated_at=now() WHERE account_id=$1 AND profile_id=$2 AND provider=$3",
    [accountId, profileId, provider, encrypt(secret), new Date(expiresAt), provider === "wetrakr" ? row.refresh_expires_at : null]);
  return { secret, row: { ...row, expires_at: new Date(expiresAt) } };
}
function isAllowedProviderPath(provider, path) {
  const allowed = provider === "simkl" ? SIMKL_PATHS : WETRAKR_PATHS;
  const cleanPath = String(path || "");
  return cleanPath.startsWith("/") && !cleanPath.startsWith("//") &&
    allowed.some((rule) => rule.test(cleanPath.split("?")[0]));
}
async function request(provider, accountId, profileId, path, method, body) {
  const cleanPath = String(path || "");
  if (!isAllowedProviderPath(provider, cleanPath))
    throw Object.assign(new Error("path_not_allowed"), { statusCode: 403 });
  const verb = String(method || "GET").toUpperCase();
  if (!new Set(["GET", "POST", "PUT", "DELETE"]).has(verb)) throw Object.assign(new Error("method_not_allowed"), { statusCode: 405 });
  return withCredential(accountId, profileId, provider, async (client, row) => {
    const { secret } = await refreshIfNeeded(client, accountId, profileId, provider, row);
    const first = await providerFetch(provider, cleanPath, verb, body, secret.accessToken);
    if (first.status === 401) {
      // Retry once after forcing refresh, but retain the stored grant on transient failures.
      const freshRow = await client.query("SELECT * FROM public.arvio_provider_credentials WHERE account_id=$1 AND profile_id=$2 AND provider=$3 FOR UPDATE", [accountId, profileId, provider]);
      const latest = freshRow.rows[0];
      const latestSecret = decrypt(latest.secret_ciphertext);
      if (latestSecret.accessToken === secret.accessToken) {
        const forced = await providerFetch(provider, provider === "simkl" ? "/oauth2/token" : "/oauth/token/refresh", "POST",
          provider === "simkl" ? { client_id: providerConfig(provider).clientId, grant_type: "refresh_token", refresh_token: latestSecret.refreshToken } : { refresh_token: latestSecret.refreshToken });
        if (forced.status < 200 || forced.status >= 300) {
          if ([400, 401, 403].includes(forced.status) && /invalid_grant|invalid_refresh_token/i.test(JSON.stringify(forced.data))) {
            await client.query("UPDATE public.arvio_provider_credentials SET status='reconnect_required',updated_at=now() WHERE account_id=$1 AND profile_id=$2 AND provider=$3", [accountId, profileId, provider]);
            throw Object.assign(new Error("reconnect_required"), { statusCode: 401 });
          }
          throw Object.assign(new Error("provider_temporarily_unavailable"), { statusCode: 503 });
        }
        const d = forced.data, next = { accessToken: d.access_token, refreshToken: d.refresh_token || d.new_refresh_token || latestSecret.refreshToken, tokenType: "Bearer" };
        const expiresAt = Date.now() + Number(d.expires_in || 604800) * 1000;
        await client.query("UPDATE public.arvio_provider_credentials SET secret_ciphertext=$4,expires_at=$5,updated_at=now() WHERE account_id=$1 AND profile_id=$2 AND provider=$3", [accountId, profileId, provider, encrypt(next), new Date(expiresAt)]);
        const retry = await providerFetch(provider, cleanPath, verb, body, next.accessToken);
        return { status: retry.status, data: retry.data, headers: retry.headers };
      }
    }
    return { status: first.status, data: first.data, headers: first.headers };
  });
}
async function disconnect(provider, accountId, profileId) {
  return withCredential(accountId, profileId, provider, async (client, row) => {
    const secret = decrypt(row?.secret_ciphertext);
    await client.query("DELETE FROM public.arvio_provider_credentials WHERE account_id=$1 AND profile_id=$2 AND provider=$3", [accountId, profileId, provider]);
    if (secret?.refreshToken) {
      const path = provider === "simkl" ? "/oauth2/revoke" : "/oauth/logout";
      const body = provider === "simkl" ? { client_id: providerConfig(provider).clientId, token: secret.refreshToken } : { refresh_token: secret.refreshToken };
      // Revocation is best effort; local/cloud disconnect must succeed even if provider is down.
      await providerFetch(provider, path, "POST", body, secret.accessToken).catch(() => {});
    }
    return { disconnected: true };
  });
}
async function handle(event, backend) {
  const cors = backend.options(event); if (cors) return cors;
  try {
    const identity = await backend.resolveIdentity(event);
    const body = backend.parseBody(event);
    const q = event.queryStringParameters || {};
    const provider = String(body.provider || q.provider || "").toLowerCase();
    const action = String(body.action || q.action || "").toLowerCase();
    if (!["simkl", "wetrakr"].includes(provider)) return json(400, { error: "unsupported_provider" });
    const profileId = safeProfile(body.profileId || q.profileId);
    // The native ARVIO JWT subject is `arvio_accounts.supabase_user_id`, not
    // `arvio_accounts.id`. Provider credentials have an FK to the latter.
    // Reuse the same account resolver used by the account-sync handlers so
    // existing accounts and OIDC-linked users share the correct DB row.
    const accountClient = await getPool().connect();
    let accountId;
    try {
      const account = await backend.getOrCreateAccount(accountClient, identity);
      accountId = account.id;
    } finally {
      accountClient.release();
    }
    if (action === "status") {
      const result = await getPool().query("SELECT provider,status,provider_username,connected_at,expires_at,refresh_expires_at FROM public.arvio_provider_credentials WHERE account_id=$1 AND profile_id=$2 AND provider=$3", [accountId, profileId, provider]);
      return json(200, publicStatus(result.rows[0] || { provider, status: "disconnected" }));
    }
    if (action === "start") return json(200, await start(provider, accountId, profileId));
    if (action === "poll") return json(200, await poll(provider, accountId, profileId));
    if (action === "disconnect") return json(200, await disconnect(provider, accountId, profileId));
    if (action === "request") {
      const result = await request(provider, accountId, profileId, body.path, body.method || "GET", body.body);
      return json(result.status, result.data, { ...(result.headers.retryAfter ? { "retry-after": result.headers.retryAfter } : {}),
        ...(result.headers.pageCount ? { "x-pagination-page-count": result.headers.pageCount } : {}),
        ...(result.headers.page ? { "x-pagination-page": result.headers.page } : {}),
        ...(result.headers.limit ? { "x-pagination-limit": result.headers.limit } : {}),
        ...(result.headers.itemCount ? { "x-pagination-item-count": result.headers.itemCount } : {}) });
    }
    return json(400, { error: "unknown_action" });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    if (status >= 500) console.error("Provider coordinator request failed", { message: error.message, code: error.code });
    return json(status, { error: status >= 500 ? "provider_coordinator_unavailable" : error.message || "request_failed" }, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
  }
}
module.exports = { handle, encrypt, decrypt, _test: { isAllowedProviderPath } };

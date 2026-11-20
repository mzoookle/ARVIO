"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { PostgresBlobStore } = require("./postgres-blob-store");
const { _test } = require("../netlify/functions/_backend");

const ACCOUNT_PREFIX = "accounts/email/";
const ACCOUNT_SUFFIX = ".json";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let pool;
let stores;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.ARVIO_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("ARVIO_DATABASE_URL or DATABASE_URL is required");
  pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
    application_name: "arvio-private-cloud-admin" });
  return pool;
}

function getStores() {
  if (!stores) {
    const p = getPool();
    stores = {
      auth: new PostgresBlobStore(p, "arvio-auth"),
      sync: new PostgresBlobStore(p, "account-sync")
    };
  }
  return stores;
}

function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(String(raw).replace(/^\uFEFF/, ""));
}

function bearer(event) {
  const headers = event.headers || {};
  const value = headers.authorization || headers.Authorization || "";
  return /^Bearer\s+(.+)$/i.exec(value)?.[1]?.trim() || "";
}

function configuredAdmins() {
  return new Set(String(process.env.ARVIO_ADMIN_EMAILS || "")
    .split(/[;,\n]/).map((email) => email.trim().toLowerCase()).filter(Boolean));
}

async function requireAdmin(event) {
  const token = bearer(event);
  if (!token) return { error: json(401, { error: "unauthorized" }) };
  let identity;
  try {
    identity = _test.verifyArvioAccessToken(token);
  } catch {
    return { error: json(401, { error: "unauthorized" }) };
  }
  const admins = configuredAdmins();
  const allowlisted = admins.has(identity.email);
  const adminGroup = String(process.env.ARVIO_OIDC_ADMIN_GROUP || "").trim();
  try {
    // The explicit email allowlist is an independent break-glass path. Do not
    // query the OIDC group table for allowlisted admins: this keeps the fallback
    // usable even while OIDC migrations are being applied or repaired.
    let groupAuthorized = false;
    if (!allowlisted && adminGroup) {
      const issuer = String(process.env.ARVIO_OIDC_ISSUER || "").replace(/\/$/, "");
      if (issuer) {
        const membership = await getPool().query(
          `SELECT 1 FROM public.arvio_oidc_identities
           WHERE issuer=$1 AND account_id=$2 AND $3 = ANY(groups) LIMIT 1`,
          [issuer, identity.supabaseUserId, adminGroup]
        );
        groupAuthorized = membership.rows.length > 0;
      }
    }
    if (!allowlisted && !groupAuthorized) {
      if (!admins.size && !adminGroup) return { error: json(503, { error: "admin_access_not_configured" }) };
      return { error: json(403, { error: "admin_access_required" }) };
    }
    const key = accountKey(identity.email);
    const account = await getStores().auth.get(key, { type: "json" });
    if (!account || String(account.accountId) !== identity.supabaseUserId) {
      return { error: json(401, { error: "account_inactive" }) };
    }
    return { identity, account };
  } catch (error) {
    console.error("Admin authentication failed", error);
    return { error: json(503, { error: "admin_auth_unavailable" }) };
  }
}

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function accountKey(email) {
  const hash = crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
  return `${ACCOUNT_PREFIX}${hash}${ACCOUNT_SUFFIX}`;
}

async function listAccounts() {
  const store = getStores().auth;
  const keys = [];
  for await (const page of store.list({ prefix: ACCOUNT_PREFIX, paginate: true })) {
    for (const item of page.blobs || []) if (item.key.endsWith(ACCOUNT_SUFFIX)) keys.push(item.key);
  }
  const accounts = [];
  // Sequential reads keep admin listings gentle on the database connection pool.
  for (const key of keys) {
    const account = await store.get(key, { type: "json" });
    if (!account || typeof account !== "object" || !account.email || !account.accountId) continue;
    accounts.push({
      accountId: String(account.accountId),
      email: normalizeEmail(account.email),
      createdAt: account.createdAt || null,
      updatedAt: account.updatedAt || null,
      hasPassword: Boolean(account.passwordHash)
    });
  }
  const issuer = String(process.env.ARVIO_OIDC_ISSUER || "").replace(/\/$/, "");
  const identityByAccount = new Map();
  if (issuer && accounts.length) {
    const identities = await getPool().query(
      `SELECT account_id, email, groups, created_at, last_login_at
       FROM public.arvio_oidc_identities WHERE issuer=$1`, [issuer]
    );
    for (const row of identities.rows) {
      identityByAccount.set(String(row.account_id), {
        linked: true,
        provider: "Keycloak",
        email: normalizeEmail(row.email),
        groups: Array.isArray(row.groups) ? row.groups : [],
        linkedAt: row.created_at || null,
        lastLoginAt: row.last_login_at || null
      });
    }
  }
  for (const account of accounts) {
    account.oidc = identityByAccount.get(account.accountId) || { linked: false, provider: null, email: null, groups: [], linkedAt: null, lastLoginAt: null };
  }
  accounts.sort((a, b) => a.email.localeCompare(b.email));
  return accounts;
}

async function findAccount(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized) || normalized.length > 254) return null;
  const record = await getStores().auth.getWithMetadata(accountKey(normalized), { type: "json" });
  if (!record?.data || typeof record.data !== "object") return null;
  return { ...record, email: normalized };
}

function safeSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  let payload = snapshot.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  return {
    payloadVersion: Number(snapshot.payloadVersion ?? snapshot.payload_version ?? 1),
    profileCount: Number(snapshot.profileCount ?? snapshot.profile_count ?? profiles.length ?? 0),
    restoreRank: Number(snapshot.restoreRank ?? snapshot.restore_rank ?? 0),
    payloadUpdatedAt: snapshot.payloadUpdatedAt ?? snapshot.payload_updated_at ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    source: String(snapshot.source || "unknown"),
    profileNames: profiles.slice(0, 100).map((profile) => ({
      id: String(profile?.id || ""),
      name: String(profile?.name || profile?.displayName || "Unnamed profile").slice(0, 100)
    }))
  };
}

async function userDetails(email) {
  const record = await findAccount(email);
  if (!record) return null;
  const account = record.data;
  const syncKey = `supabase/${String(account.accountId)}.json`;
  const sync = await getStores().sync.get(syncKey, { type: "json" });
  const issuer = String(process.env.ARVIO_OIDC_ISSUER || "").replace(/\/$/, "");
  let oidc = { linked: false, provider: null, email: null, groups: [], linkedAt: null, lastLoginAt: null };
  if (issuer) {
    const identity = await getPool().query(
      `SELECT email, groups, created_at, last_login_at
       FROM public.arvio_oidc_identities WHERE issuer=$1 AND account_id=$2 LIMIT 1`,
      [issuer, String(account.accountId)]
    );
    if (identity.rows.length) {
      const row = identity.rows[0];
      oidc = { linked: true, provider: "Keycloak", email: normalizeEmail(row.email), groups: Array.isArray(row.groups) ? row.groups : [], linkedAt: row.created_at || null, lastLoginAt: row.last_login_at || null };
    }
  }
  return {
    oidc,
    account: {
      accountId: String(account.accountId),
      email: normalizeEmail(account.email),
      createdAt: account.createdAt || null,
      updatedAt: account.updatedAt || null,
      hasPassword: Boolean(account.passwordHash)
    },
    sync: safeSnapshotSummary(sync)
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const n = 16384, r = 8, p = 1;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: n, r, p }, (error, key) => {
      if (error) reject(error);
      else resolve(`scrypt:${n}:${r}:${p}:${salt}:${key.toString("base64url")}`);
    });
  });
}

function generateTemporaryPassword() {
  // Avoid visually ambiguous characters; return only once to the administrator.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(24);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function writeAudit(actorEmail, action, targetEmail, details = {}) {
  await getPool().query(
    `INSERT INTO public.arvio_admin_audit (actor_email, action, target_email, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [actorEmail, action, targetEmail, JSON.stringify(details)]
  );
}

module.exports = {
  json, parseBody, requireAdmin, listAccounts, userDetails, findAccount,
  hashPassword, generateTemporaryPassword, writeAudit, getStores, getPool
};

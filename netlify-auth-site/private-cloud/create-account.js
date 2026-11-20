"use strict";
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { PostgresBlobStore } = require("./postgres-blob-store");

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function accountKey(email) {
  const hash = crypto.createHash("sha256").update(email).digest("hex");
  return `accounts/email/${hash}.json`;
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const n = 16384, r = 8, p = 1;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: n, r, p }, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt:${n}:${r}:${p}:${salt}:${derived.toString("base64url")}`;
}

async function readHiddenPassword(prompt) {
  if (!process.stdin.isTTY) {
    const value = process.env.ARVIO_INITIAL_PASSWORD || "";
    if (!value) throw new Error("For non-interactive use, set ARVIO_INITIAL_PASSWORD");
    return value;
  }
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const email = normalizeEmail(process.argv[2]);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Usage: node private-cloud/create-account.js user@example.net");
  const password = await readHiddenPassword("New ARVIO Cloud password: ");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const connectionString = process.env.ARVIO_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("ARVIO_DATABASE_URL or DATABASE_URL is required");

  const pool = new Pool({ connectionString, max: 1, application_name: "arvio-private-cloud-account-setup" });
  try {
    const store = new PostgresBlobStore(pool, "arvio-auth");
    const key = accountKey(email);
    if (await store.get(key, { type: "json" })) throw new Error("An account with this email already exists");
    const account = {
      accountId: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const result = await store.setJSON(key, account, {
      onlyIfNew: true,
      metadata: { accountId: account.accountId, email, updatedAt: account.updatedAt }
    });
    if (!result.modified) throw new Error("Account already exists (concurrent creation)");
    console.log(`Created private ARVIO Cloud account ${email} (${account.accountId})`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

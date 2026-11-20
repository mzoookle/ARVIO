"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { PostgresBlobStore } = require("./postgres-blob-store");

// Incus `exec` starts a separate process and does not necessarily inherit the
// environment configured for the long-running API service. When running this
// CLI inside that same container, fill only missing values from PID 1. This
// keeps secrets out of command arguments and avoids asking operators to copy
// database URLs or the blob-encryption key into their shell.
function inheritApiEnvironment() {
  const required = [
    "ARVIO_DATABASE_URL",
    "DATABASE_URL",
    "ARVIO_BLOB_ENCRYPTION_KEY"
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length === 0) return;

  try {
    const entries = require("node:fs")
      .readFileSync("/proc/1/environ", "utf8")
      .split("\0");
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator < 1) continue;
      const name = entry.slice(0, separator);
      if (missing.includes(name) && !process.env[name]) {
        process.env[name] = entry.slice(separator + 1);
      }
    }
  } catch {
    // Keep the normal explicit-environment error below; do not expose secrets.
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function accountKey(email) {
  const hash = crypto.createHash("sha256").update(email).digest("hex");
  return `accounts/email/${hash}.json`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const n = 16384;
  const r = 8;
  const p = 1;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: n, r, p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return `scrypt:${n}:${r}:${p}:${salt}:${derived.toString("base64url")}`;
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal so passwords are not exposed in shell history or process listings.");
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
          process.stdout.write("\n");
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
  inheritApiEnvironment();
  const email = normalizeEmail(process.argv[2]);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Usage: node private-cloud/reset-password.js user@example.net");
  }

  const password = await readHidden("New ARVIO Cloud password: ");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  const confirmation = await readHidden("Confirm new password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const connectionString = process.env.ARVIO_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("ARVIO_DATABASE_URL or DATABASE_URL is required");

  const pool = new Pool({ connectionString, max: 1, application_name: "arvio-private-cloud-password-reset" });
  try {
    const store = new PostgresBlobStore(pool, "arvio-auth");
    const key = accountKey(email);
    const record = await store.getWithMetadata(key, { type: "json" });
    if (!record || !record.data || typeof record.data !== "object") {
      throw new Error(`No private ARVIO Cloud account found for ${email}`);
    }

    const account = {
      ...record.data,
      passwordHash: await hashPassword(password),
      updatedAt: new Date().toISOString()
    };
    const metadata = {
      ...(record.metadata && typeof record.metadata === "object" ? record.metadata : {}),
      accountId: account.accountId,
      email,
      updatedAt: account.updatedAt
    };
    const result = await store.setJSON(key, account, {
      onlyIfMatch: record.etag,
      metadata
    });
    if (!result.modified) {
      throw new Error("The account changed while the password was being reset. Re-run the command.");
    }

    console.log(`Password updated for ${email}. Account ID and cloud-synced profiles were preserved.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

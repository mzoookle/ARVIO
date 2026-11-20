"use strict";
const { Pool } = require("pg");
const { createBlobStoreFactory } = require("./postgres-blob-store");

let pool;
let factory;

function getRuntimePool() {
  if (pool) return pool;
  const connectionString = process.env.ARVIO_DATABASE_URL || process.env.DATABASE_URL ||
    process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL;
  if (!connectionString) throw new Error("ARVIO_DATABASE_URL or DATABASE_URL must be configured");
  pool = new Pool({
    connectionString,
    max: Number(process.env.ARVIO_DB_POOL_MAX || 6),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    application_name: "arvio-private-cloud"
  });
  return pool;
}

function runtimeStore() {
  if (!factory) factory = createBlobStoreFactory(getRuntimePool());
  return factory;
}

module.exports = {
  connectLambda: () => {},
  getStore: (name) => runtimeStore().getStore(name),
  close: async () => {
    if (pool) await pool.end();
    pool = undefined;
    factory = undefined;
  }
};

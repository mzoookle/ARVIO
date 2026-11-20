"use strict";
const http = require("node:http");
const path = require("node:path");

const FUNCTIONS_DIR = path.resolve(__dirname, "../netlify/functions");
const ROUTES = new Set([
  "config",
  "auth-login", "auth-refresh", "auth-password-start", "auth-password-complete",
  "cloud-auth-email", "cloud-auth-reset",
  "account-sync-pull", "account-sync-push", "account-sync-progress",
  "account-sync-cursor", "account-sync-delta",
  "account-delete-start", "account-delete-status", "account-delete-worker-background",
  "tv-auth-start", "tv-auth-status", "tv-auth-poll", "tv-auth-complete", "tv-auth-approve", "tv-auth-web",
  "discord-auth-start", "discord-auth-status", "discord-auth-callback",
  "app-usage-event",
  "admin-users", "admin-user", "admin-password-reset", "admin-profile-config", "admin-account-delete",
  "oidc-start", "oidc-callback", "oidc-link-start", "auth-password-set",
  "simkl-proxy", "trakt-proxy", "tmdb-proxy"
]);
const MAX_BODY_BYTES = Number(process.env.ARVIO_MAX_BODY_BYTES || 5 * 1024 * 1024);

function send(res, result) {
  const status = Number(result?.statusCode || 200);
  for (const [name, value] of Object.entries(result?.headers || {})) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  res.statusCode = status;
  res.end(result?.body ?? "");
}

function queryObject(url) {
  const values = {};
  for (const [key, value] of url.searchParams) values[key] = value;
  return values;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.split("/").filter(Boolean).pop() || "";
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "arvio-private-cloud" }));
    return;
  }
  if (!ROUTES.has(route)) {
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  let mod;
  try {
    mod = require(path.join(FUNCTIONS_DIR, `${route}.js`));
  } catch (error) {
    console.error(`Unable to load endpoint ${route}`, error);
    res.writeHead(501, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "endpoint_unavailable" }));
    return;
  }
  if (typeof mod.handler !== "function") {
    res.writeHead(501, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "endpoint_unavailable" }));
    return;
  }

  try {
    const event = {
      httpMethod: req.method,
      headers: req.headers,
      body: await readBody(req),
      isBase64Encoded: false,
      path: url.pathname,
      rawUrl: req.url,
      queryStringParameters: queryObject(url)
    };
    send(res, await mod.handler(event, {}));
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    console.error(`${route} request failed`, error);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: status === 413 ? "payload_too_large" : "internal_error" }));
  }
}

function start() {
  if (process.env.ARVIO_PRIVATE_CLOUD !== "true") {
    throw new Error("Set ARVIO_PRIVATE_CLOUD=true to start the private Cloud server");
  }
  const server = http.createServer((req, res) => { void dispatch(req, res); });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => console.log(`ARVIO Private Cloud listening on ${host}:${port}`));
  const shutdown = async () => {
    server.close(async () => {
      try { await require("./runtime-store").close(); } finally { process.exit(0); }
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

if (require.main === module) start();
module.exports = { start, dispatch, ROUTES };

"use strict";
const http = require("node:http");
const path = require("node:path");
const net = require("node:net");
const releaseAdmin = require("./admin-release");

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
  "admin-users", "admin-user", "admin-password-reset", "admin-account-delete", "admin-profile-config",
  "admin-devices", "device-heartbeat", "admin-release",
  "oidc-start", "oidc-callback", "oidc-link-start", "auth-password-set",
  "simkl-proxy", "trakt-proxy", "tmdb-proxy"
]);
const MAX_BODY_BYTES = Number(process.env.ARVIO_MAX_BODY_BYTES || 5 * 1024 * 1024);
const proxyAllowlist = new net.BlockList();
for (const item of String(process.env.ARVIO_TRUSTED_PROXY_CIDRS || "").split(",").map(x=>x.trim()).filter(Boolean)) {
  const [addr, prefix] = item.split("/");
  const family = net.isIP(addr);
  if (!family || (prefix !== undefined && !Number.isInteger(Number(prefix)))) throw new Error(`Bad trusted proxy CIDR: ${item}`);
  if (prefix === undefined) proxyAllowlist.addAddress(addr, family === 4 ? "ipv4" : "ipv6");
  else proxyAllowlist.addSubnet(addr,Number(prefix),family === 4 ? "ipv4" : "ipv6");
}
function normalizedIp(address) { return String(address || "").replace(/^::ffff:/, ""); }
function isTrusted(address) {
  const ip = normalizedIp(address), family=net.isIP(ip);
  return Boolean(family && proxyAllowlist.check(ip,family===4?"ipv4":"ipv6"));
}
function requestIp(req) {
  let address=normalizedIp(req.socket?.remoteAddress);
  if(!isTrusted(address)) return net.isIP(address)?address:null;
  // Work right-to-left, stopping at the nearest untrusted hop. Edge proxy must
  // append/replace X-Forwarded-For; never trust client-controlled header alone.
  const chain=String(req.headers["x-forwarded-for"]||"").split(",").map(x=>x.trim()).filter(Boolean);
  for(let i=chain.length-1;i>=0;i--) {
    const hop=normalizedIp(chain[i]);
    if(!net.isIP(hop))return net.isIP(address)?address:null;
    address=hop;
    if(!isTrusted(address))break;
  }
  return net.isIP(address)?address:null;
}


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
  if (route === "admin-release-upload") {
    await releaseAdmin.upload(req,res);
    return;
  }
  if (route === "admin-release") {
    send(res,await releaseAdmin.list({httpMethod:req.method,headers:req.headers}));
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
      queryStringParameters: queryObject(url),
      requestContext: { identity: { sourceIp: requestIp(req) } }
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

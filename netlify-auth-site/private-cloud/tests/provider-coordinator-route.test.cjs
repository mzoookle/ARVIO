"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const cloudRoot = path.resolve(__dirname, "..");
const serverPath = path.join(cloudRoot, "server.js");
const functionPath = path.resolve(cloudRoot, "..", "netlify", "functions", "provider-coordinator.js");
const coordinatorPath = path.join(cloudRoot, "provider-coordinator.js");

test("private-cloud router exposes provider-coordinator and its handler", () => {
  const server = fs.readFileSync(serverPath, "utf8");
  const routes = server.match(/const ROUTES\s*=\s*new Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(routes, "Expected an explicit ROUTES allowlist in private-cloud/server.js");
  assert.match(routes[1], /["']provider-coordinator["']/, "provider-coordinator is missing from ROUTES");
  assert.ok(fs.existsSync(functionPath), "Netlify-compatible provider-coordinator.js handler is missing");
  assert.ok(fs.existsSync(coordinatorPath), "Private-cloud provider-coordinator.js implementation is missing");
});

test("provider coordinator accepts CORS preflight before account authentication", () => {
  const source = fs.readFileSync(coordinatorPath, "utf8");
  assert.match(source, /backend\.options\(event\)/,
    "Provider coordinator must accept OPTIONS preflight before authenticating");
});

test("provider coordinator handler adds CORS headers to successful Web responses", async () => {
  // Isolated wrapper test: no database or provider credentials needed.
  const code = fs.readFileSync(functionPath, "utf8");
  const backend = { json: () => ({ headers: {
    "access-control-allow-origin": "https://web.example.net",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,apikey,content-type"
  } }) };
  const coordinator = { handle: async () => ({ statusCode: 200,
    headers: { "content-type": "application/json", "x-pagination-page": "2" }, body: "{}" }) };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name === "./_backend") return backend;
    if (name === "../../private-cloud/provider-coordinator") return coordinator;
    throw new Error(`Unexpected dependency: ${name}`);
  } }, { filename: functionPath });
  const result = await exports.handler({ httpMethod: "POST" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["access-control-allow-origin"], "https://web.example.net");
  assert.equal(result.headers["x-pagination-page"], "2");
});

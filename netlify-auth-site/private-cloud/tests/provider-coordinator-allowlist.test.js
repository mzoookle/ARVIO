"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../netlify/functions/_backend") return { getPool() { throw new Error("database not used by allowlist tests"); } };
  return originalLoad.call(this, request, parent, isMain);
};
const { _test } = require("../provider-coordinator");
Module._load = originalLoad;

test("allows the WeTrakr endpoints used by Android", () => {
  const allowed = [
    "/sync/tracking/watched/movies?limit=100&page=1",
    "/sync/tracking/watching/shows",
    "/sync/tracking/playing/all",
    "/sync/tracking",
    "/sync/tracking/remove",
    "/sync/tracking/remove/all",
    "/sync/lists",
    "/sync/lists/item/movie/123",
    "/sync/lists/123/items?limit=100&page=1",
    "/sync/lists/123/items/remove",
    "/discover/recommended?filter_type=movie",
    "/media/external/tmdb/123?type=movie",
    "/scrobble/playing",
    "/scrobble/start?min_progress=90",
    "/scrobble/pause",
    "/scrobble/stop"
  ];
  for (const path of allowed) assert.equal(_test.isAllowedProviderPath("wetrakr", path), true, path);
});

test("allows SIMKL sync, playback, lists, and scrobbling but rejects OAuth token injection", () => {
  const allowed = [
    "/users/settings",
    "/sync/activities",
    "/sync/all-items/movies?extended=full",
    "/sync/playback",
    "/sync/playback/123",
    "/sync/history",
    "/sync/history/remove",
    "/sync/add-to-list",
    "/lists/123",
    "/lists/user/456",
    "/scrobble/start"
  ];
  for (const path of allowed) assert.equal(_test.isAllowedProviderPath("simkl", path), true, path);
  assert.equal(_test.isAllowedProviderPath("simkl", "/oauth2/token"), false);
});

test("rejects absolute and protocol-relative paths", () => {
  assert.equal(_test.isAllowedProviderPath("wetrakr", "https://evil.example/"), false);
  assert.equal(_test.isAllowedProviderPath("wetrakr", "//evil.example/"), false);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const { PostgresBlobStore } = require("../postgres-blob-store");
const fs = require("node:fs");
const path = require("node:path");

process.env.ARVIO_BLOB_ENCRYPTION_KEY ||= "a".repeat(64);

async function fixture() {
  const db = new PGlite();
  const migrations = ["001_blob_store.sql", "002_blob_etag.sql"];
  for (const file of migrations) {
    await db.exec(fs.readFileSync(path.join(__dirname, "../migrations", file), "utf8"));
  }
  return { db, store: new PostgresBlobStore(db, "test-store") };
}

test("stores JSON values and metadata and returns opaque ETags", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  const first = await store.setJSON("accounts/a.json", { name: "A" }, { metadata: { owner: "a" } });
  assert.equal(first.modified, true);
  assert.match(first.etag, /^"[0-9a-f-]{36}"$/i);
  assert.deepEqual(await store.get("accounts/a.json", { type: "json" }), { name: "A" });
  assert.deepEqual(await store.getWithMetadata("accounts/a.json", { type: "json" }), {
    data: { name: "A" }, metadata: { owner: "a" }, etag: first.etag
  });
  assert.equal(await store.get("accounts/a.json"), '{"name":"A"}');
  const raw = await db.query(
    `SELECT data, metadata FROM public.arvio_blob_records WHERE store_name = $1 AND blob_key = $2`,
    ["test-store", "accounts/a.json"]
  );
  assert.equal(raw.rows[0].data.__arvioEncryptedBlob, "v1");
  assert.equal(raw.rows[0].metadata.__arvioEncryptedBlob, "v1");
  assert.equal(JSON.stringify(raw.rows[0].data).includes("name"), false);

  const second = await store.setJSON("accounts/a.json", { name: "B" });
  assert.equal(second.modified, true);
  assert.notEqual(second.etag, first.etag);
});

test("onlyIfNew is atomic and does not replace an existing value", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("k", { value: 1 });
  const result = await store.setJSON("k", { value: 2 }, { onlyIfNew: true });
  assert.deepEqual(result, { modified: false });
  assert.deepEqual(await store.get("k", { type: "json" }), { value: 1 });
});

test("onlyIfMatch provides compare-and-swap semantics", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  const created = await store.setJSON("k", { value: 1 });
  const stale = await store.setJSON("k", { value: 2 }, { onlyIfMatch: '"not-the-etag"' });
  assert.deepEqual(stale, { modified: false });
  const updated = await store.setJSON("k", { value: 3 }, { onlyIfMatch: created.etag });
  assert.equal(updated.modified, true);
  assert.notEqual(updated.etag, created.etag);
  assert.deepEqual(await store.get("k", { type: "json" }), { value: 3 });
});

test("ETags cannot be reused after delete and recreate", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  const first = await store.setJSON("k", { value: "first" });
  await store.delete("k");
  const recreated = await store.setJSON("k", { value: "new record" });
  const stale = await store.setJSON("k", { value: "stale overwrite" }, { onlyIfMatch: first.etag });
  assert.deepEqual(stale, { modified: false });
  assert.deepEqual(await store.get("k", { type: "json" }), { value: "new record" });
  assert.notEqual(first.etag, recreated.etag);
});

test("default list returns a Promise with all matching blobs", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("profiles/a", { id: "a" });
  await store.setJSON("profiles/b", { id: "b" });
  await store.setJSON("settings/a", { id: "settings" });
  const page = await store.list({ prefix: "profiles/", limit: 1 });
  assert.deepEqual(page.blobs.map((blob) => blob.key), ["profiles/a", "profiles/b"]);
  assert.deepEqual(page.directories, []);
});

test("paginate:true returns an AsyncIterable of cursor pages", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("profiles/a", { id: "a" });
  await store.setJSON("profiles/b", { id: "b" });
  await store.setJSON("settings/a", { id: "settings" });
  const pages = [];
  for await (const page of store.list({ prefix: "profiles/", paginate: true, limit: 1 })) {
    pages.push(page);
  }
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.flatMap((page) => page.blobs.map((blob) => blob.key)), ["profiles/a", "profiles/b"]);
});

test("directory listing separates child directories from direct blobs", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("root/a.json", {});
  await store.setJSON("root/nested/b.json", {});
  const page = await store.list({ prefix: "root/", directories: true });
  assert.deepEqual(page.blobs.map((blob) => blob.key), ["root/a.json"]);
  assert.deepEqual(page.directories, ["nested"]);
});

test("store namespaces are isolated", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  const other = new PostgresBlobStore(db, "other-store");
  await store.setJSON("profiles/a", { id: "a" });
  await other.setJSON("profiles/a", { id: "other" });
  assert.deepEqual(await other.get("profiles/a", { type: "json" }), { id: "other" });
  assert.deepEqual(await store.get("profiles/a", { type: "json" }), { id: "a" });
});

test("delete is idempotent and resolves like Netlify Blobs", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("k", { value: true });
  assert.equal(await store.delete("k"), undefined);
  assert.equal(await store.delete("k"), undefined);
  assert.equal(await store.get("k", { type: "json" }), null);
});


test("legacy plaintext rows remain readable during phase-1 upgrade", async (t) => {
  const { db } = await fixture();
  t.after(() => db.close());
  await db.query(
    `INSERT INTO public.arvio_blob_records
       (store_name, blob_key, data, metadata, version, etag)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 1, $5)`,
    ["legacy-store", "legacy/key", JSON.stringify({ value: "old" }), JSON.stringify({ old: true }), '"legacy-etag"']
  );
  const legacyStore = new PostgresBlobStore(db, "legacy-store");
  assert.deepEqual(await legacyStore.get("legacy/key", { type: "json" }), { value: "old" });
  assert.deepEqual(await legacyStore.getWithMetadata("legacy/key", { type: "json" }), {
    data: { value: "old" }, metadata: { old: true }, etag: '"legacy-etag"'
  });
});

test("a wrong encryption key cannot read encrypted records", async (t) => {
  const { db, store } = await fixture();
  t.after(() => db.close());
  await store.setJSON("secret", { token: "sensitive" });
  const previous = process.env.ARVIO_BLOB_ENCRYPTION_KEY;
  try {
    process.env.ARVIO_BLOB_ENCRYPTION_KEY = "b".repeat(64);
    const wrongKeyStore = new PostgresBlobStore(db, "test-store");
    await assert.rejects(() => wrongKeyStore.get("secret", { type: "json" }));
  } finally {
    process.env.ARVIO_BLOB_ENCRYPTION_KEY = previous;
  }
});

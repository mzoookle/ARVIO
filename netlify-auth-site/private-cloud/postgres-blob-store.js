"use strict";

const crypto = require("node:crypto");

/**
 * PostgreSQL implementation of the subset of @netlify/blobs used by ARVIO.
 *
 * API compatibility:
 * - get/list return Promises by default.
 * - list({ paginate: true }) returns an AsyncIterable of pages.
 * - setJSON preserves Netlify's conditional-write result shape.
 * - Blob values and metadata are encrypted at rest with AES-256-GCM.
 * - ETags are opaque, unique per write, and do not repeat after delete/recreate.
 */
class PostgresBlobStore {
  constructor(pool, storeName) {
    if (!pool || typeof pool.query !== "function") {
      throw new TypeError("A pg-compatible pool is required");
    }
    if (!storeName || typeof storeName !== "string") {
      throw new TypeError("storeName is required");
    }
    this.pool = pool;
    this.storeName = storeName;
    const configuredKey = String(process.env.ARVIO_BLOB_ENCRYPTION_KEY || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(configuredKey)) {
      throw new Error("ARVIO_BLOB_ENCRYPTION_KEY must be exactly 64 hexadecimal characters");
    }
    this.encryptionKey = Buffer.from(configuredKey, "hex");
  }

  encryptValue(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      __arvioEncryptedBlob: "v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  decryptValue(value) {
    // Permit reads of plaintext records created by the earlier phase-1 adapter.
    // Every new write is encrypted, so records become encrypted as they are touched.
    if (!value || typeof value !== "object" || value.__arvioEncryptedBlob !== "v1") {
      return value;
    }
    if (value.algorithm !== "aes-256-gcm" || !value.iv || !value.tag || !value.ciphertext) {
      throw new Error("Invalid encrypted ARVIO Blob envelope");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(value.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  async getWithMetadata(key, options = {}) {
    const result = await this.pool.query(
      `SELECT data, metadata, etag
         FROM public.arvio_blob_records
        WHERE store_name = $1 AND blob_key = $2`,
      [this.storeName, String(key)]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      data: this.formatValue(this.decryptValue(row.data), options.type),
      metadata: this.decryptValue(row.metadata || {}),
      etag: row.etag
    };
  }

  formatValue(value, type) {
    if (type === "json") return value;
    if (type === "arrayBuffer") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return Uint8Array.from(Buffer.from(text)).buffer;
    }
    if (type === "blob") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return new Blob([text]);
    }
    if (type === "stream") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return require("node:stream").Readable.from([text]);
    }
    // Netlify Blobs defaults to text.
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async get(key, options = {}) {
    const record = await this.getWithMetadata(key, { type: options.type || "text" });
    return record ? record.data : null;
  }

  async setJSON(key, value, options = {}) {
    const metadata = options.metadata && typeof options.metadata === "object"
      ? options.metadata
      : {};
    const etag = `"${crypto.randomUUID()}"`;
    const onlyIfNew = options.onlyIfNew === true;
    const expectedEtag = options.onlyIfMatch == null ? null : String(options.onlyIfMatch);
    const serialized = JSON.stringify(this.encryptValue(value));
    const serializedMetadata = JSON.stringify(this.encryptValue(metadata));

    if (onlyIfNew) {
      const inserted = await this.pool.query(
        `INSERT INTO public.arvio_blob_records
           (store_name, blob_key, data, metadata, version, etag)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, 1, $5)
         ON CONFLICT (store_name, blob_key) DO NOTHING
         RETURNING etag`,
        [this.storeName, String(key), serialized, serializedMetadata, etag]
      );
      return inserted.rows.length
        ? { modified: true, etag: inserted.rows[0].etag }
        : { modified: false };
    }

    if (expectedEtag !== null) {
      const updated = await this.pool.query(
        `UPDATE public.arvio_blob_records
            SET data = $4::jsonb,
                metadata = $5::jsonb,
                version = version + 1,
                etag = $6,
                updated_at = now()
          WHERE store_name = $1 AND blob_key = $2 AND etag = $3
          RETURNING etag`,
        [this.storeName, String(key), expectedEtag, serialized, serializedMetadata, etag]
      );
      return updated.rows.length
        ? { modified: true, etag: updated.rows[0].etag }
        : { modified: false };
    }

    const upserted = await this.pool.query(
      `INSERT INTO public.arvio_blob_records AS current_record
         (store_name, blob_key, data, metadata, version, etag)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 1, $5)
       ON CONFLICT (store_name, blob_key) DO UPDATE
         SET data = EXCLUDED.data,
             metadata = EXCLUDED.metadata,
             version = current_record.version + 1,
             etag = EXCLUDED.etag,
             updated_at = now()
       RETURNING etag`,
      [this.storeName, String(key), serialized, serializedMetadata, etag]
    );
    return { modified: true, etag: upserted.rows[0].etag };
  }

  async set(key, value, options = {}) {
    // All current ARVIO Cloud callers write JSON. Strings are preserved as
    // JSON strings so get({type:"text"}) and get({type:"json"}) remain useful.
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      throw new TypeError("Binary Blob writes are not used by ARVIO Cloud and are not supported");
    }
    return this.setJSON(key, value, options);
  }

  async delete(key) {
    await this.pool.query(
      `DELETE FROM public.arvio_blob_records WHERE store_name = $1 AND blob_key = $2`,
      [this.storeName, String(key)]
    );
    // Netlify Blobs resolves delete() with undefined.
  }

  list(options = {}) {
    if (options.paginate === true) return this.iteratePages(options);
    return this.listAll(options);
  }

  async listPage(options = {}) {
    const prefix = String(options.prefix || "");
    const pageSize = Math.max(1, Math.min(Number(options.limit) || 1000, 1000));
    const after = String(options.cursor || "");
    const result = await this.pool.query(
      `SELECT blob_key, etag
         FROM public.arvio_blob_records
        WHERE store_name = $1
          AND left(blob_key, char_length($2)) = $2
          AND blob_key > $3
        ORDER BY blob_key ASC
        LIMIT $4`,
      [this.storeName, prefix, after, pageSize + 1]
    );
    const hasMore = result.rows.length > pageSize;
    const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
    const blobs = [];
    const directories = new Set();

    for (const row of rows) {
      const relative = row.blob_key.slice(prefix.length);
      const slash = relative.indexOf("/");
      if (options.directories === true && slash >= 0) {
        directories.add(relative.slice(0, slash));
      } else {
        blobs.push({ key: row.blob_key, etag: row.etag });
      }
    }

    return {
      blobs,
      directories: [...directories].sort(),
      next_cursor: hasMore && rows.length ? rows[rows.length - 1].blob_key : null
    };
  }

  async listAll(options = {}) {
    const blobs = [];
    const directories = new Set();
    let cursor = String(options.cursor || "");
    while (true) {
      const page = await this.listPage({ ...options, cursor });
      blobs.push(...page.blobs);
      for (const directory of page.directories) directories.add(directory);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { blobs, directories: [...directories].sort() };
  }

  async *iteratePages(options = {}) {
    let cursor = String(options.cursor || "");
    while (true) {
      const page = await this.listPage({ ...options, cursor });
      yield { blobs: page.blobs, directories: page.directories };
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }
}

function createBlobStoreFactory(pool) {
  const stores = new Map();
  return {
    connectLambda() {},
    getStore(name) {
      if (!stores.has(name)) stores.set(name, new PostgresBlobStore(pool, name));
      return stores.get(name);
    }
  };
}

module.exports = { PostgresBlobStore, createBlobStoreFactory };

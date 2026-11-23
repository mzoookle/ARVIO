"use strict";

const {
  json, parseBody, requireAdmin, findAccount, writeAudit
} = require("../../private-cloud/admin-common");
const backend = require("./_backend");

const GLOBAL_KEYS = [
  "accentColor", "oledBlackBackground", "skipProfileSelection", "customUserAgent",
  "dnsProvider", "subtitleAiEnabled", "subtitleAiAutoSelect", "subtitleAiFindBestMatch",
  "subtitlePreloadEnabled", "dolbyVisionCompatEnabled", "subtitleAiApiKey",
  "subtitleAiModel", "subtitleRemoveHearingImpaired", "telegramSearchOnClickOnly",
  "subtitleHearingSyncV2"
];
const IPTV_FIELDS = [
  "m3uUrl", "epgUrl", "playlists", "stalkerPortals", "stalkerPortalUrl",
  "stalkerMacAddress", "favoriteGroups", "favoriteChannels", "hiddenGroups",
  "lockedGroups", "groupOrder", "groupOrderSchema", "sortOrder", "channelOrder", "groupNames"
];
const MAX_SECTION_BYTES = 750_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function object(value) { return isObject(value) ? value : {}; }
function asPayload(snapshot) {
  if (!snapshot) return {};
  if (typeof snapshot.payload === "string") {
    try { return JSON.parse(snapshot.payload); } catch { throw new Error("The account sync snapshot contains invalid JSON"); }
  }
  return object(snapshot.payload);
}
function profileExists(payload, profileId) {
  return Array.isArray(payload.profiles) && payload.profiles.some((profile) => String(profile?.id || "") === profileId);
}
function selectedConfig(payload, profileId, providerStatuses = {}) {
  const profileSettings = object(payload.profileSettingsById)[profileId] || {};
  const addonsMap = object(payload.addonsByProfile);
  const profileEnabled = object(profileSettings.streamProviderEnabledMap);
  const installed = Array.isArray(addonsMap[profileId]) ? addonsMap[profileId] : (Array.isArray(payload.addons) ? payload.addons : []);
  const effectiveAddons = installed.map((addon) => {
    const override = profileEnabled[`stremio:${addon.id}`];
    const enabled = typeof override === "boolean" ? override : (addon.enabled !== false && addon.isEnabled !== false);
    return { ...addon, enabled, ...(addon.isEnabled !== undefined ? { isEnabled: enabled } : {}) };
  });
  const catalogsMap = object(payload.catalogsByProfile);
  const iptvMap = object(payload.iptvByProfile);
  const tracking = { ...object(payload.mdbListSyncByProfile)[profileId] };
  // Credentials are never returned to the admin browser. Status is sufficient for operations.
  for (const key of ["simklAccessToken", "simklCredentialUpdatedAt", "mdbListApiKey", "mdbListAccessToken", "mdbListRefreshToken", "mdbListTokenExpiresAt", "mdbListCredentialUpdatedAt"]) delete tracking[key];
  const trakt = object(payload.traktTokens)[profileId] || {};
  return {
    profileSettings: object(profileSettings),
    addons: effectiveAddons,
    iptv: object(iptvMap[profileId]),
    catalogs: {
      items: Array.isArray(catalogsMap[profileId]) ? catalogsMap[profileId] : [],
      hiddenPreinstalled: arrayAt(payload.hiddenPreinstalledByProfile, profileId),
      hiddenAddons: arrayAt(payload.hiddenAddonByProfile, profileId),
      hiddenHomeServers: arrayAt(payload.hiddenHomeServerByProfile, profileId)
    },
    globalSettings: Object.fromEntries(GLOBAL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(payload, key)).map((key) => [key, payload[key]])),
    integrations: {
      traktStatus: { connected: Boolean(trakt.accessToken || trakt.access_token) },
      simklStatus: providerStatuses.simkl || { provider: "simkl", status: "disconnected", connected: false },
      wetrakrStatus: providerStatuses.wetrakr || { provider: "wetrakr", status: "disconnected", connected: false },
      mdbListStatus: { configured: Boolean(object(payload.mdbListSyncByProfile)[profileId]?.mdbListApiKey || object(payload.mdbListSyncByProfile)[profileId]?.mdbListAccessToken) },
      tracking
    }
  };
}
function arrayAt(value, profileId) {
  const result = object(value)[profileId];
  return Array.isArray(result) ? result : [];
}
function validateSize(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SECTION_BYTES) {
    const error = new Error("Configuration section is too large"); error.statusCode = 413; throw error;
  }
}
function validateAddons(value) {
  if (!Array.isArray(value) || value.length > 250) throw badRequest("addons_must_be_an_array_of_at_most_250_items");
  const seen = new Set();
  for (const addon of value) {
    if (!isObject(addon)) throw badRequest("invalid_addon_record");
    const id = String(addon.id || "").trim();
    const manifestUrl = String(addon.manifestUrl || addon.url || "").trim();
    if (!id || id.length > 256 || !manifestUrl || manifestUrl.length > 4096) throw badRequest("addon_requires_id_and_manifest_url");
    let parsedUrl;
    try { parsedUrl = new URL(manifestUrl); } catch { throw badRequest("addon_manifest_url_must_be_http_or_https"); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw badRequest("addon_manifest_url_must_be_http_or_https");
    if (seen.has(id)) throw badRequest("duplicate_addon_id");
    seen.add(id);
    if (addon.enabled !== undefined && typeof addon.enabled !== "boolean") throw badRequest("invalid_addon_enabled_value");
  }
}
function badRequest(message) { const error = new Error(message); error.statusCode = 400; return error; }
function assignProfileMap(payload, key, profileId, value) {
  payload[key] = { ...object(payload[key]), [profileId]: value };
}
function bump(payload, key, value) {
  payload.fieldUpdatedAt = { ...object(payload.fieldUpdatedAt), [key]: value };
}
function nextTimestamp(payload, prefix, keys, now) {
  const timestamps = object(payload.fieldUpdatedAt);
  const latest = keys.reduce((max, key) => Math.max(max, Number(timestamps[`${prefix}${key}`]) || 0), 0);
  return Math.max(now, latest + 1);
}
function applyProfileSettings(payload, profileId, value, now) {
  if (!isObject(value)) throw badRequest("profile_settings_must_be_an_object");
  const currentMap = object(payload.profileSettingsById);
  const previous = object(currentMap[profileId]);
  const next = { ...value };
  // Omitted keys are retained: the sync merge treats absence as "client did not
  // know this field", not as an explicit deletion. Use an empty/default value
  // supported by that setting when clearing it.
  for (const [field, oldValue] of Object.entries(previous)) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) next[field] = oldValue;
  }
  if (Object.prototype.hasOwnProperty.call(next, "homeServerConnectionJson") && next.homeServerConnectionJson) {
    if (typeof next.homeServerConnectionJson !== "string") throw badRequest("homeServerConnectionJson_must_be_a_JSON_string");
    let homeServers;
    try { homeServers = JSON.parse(next.homeServerConnectionJson); } catch { throw badRequest("homeServerConnectionJson_contains_invalid_JSON"); }
    const connections = Array.isArray(homeServers) ? homeServers : homeServers && Array.isArray(homeServers.connections) ? homeServers.connections : null;
    if (!connections || connections.length > 100) throw badRequest("homeServerConnectionJson_must_contain_at_most_100_connections");
  }
  const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((field) => field !== "defaultSubtitle" && field !== "subtitleSettingsUpdatedAt");
  const timestamp = nextTimestamp(payload, `p:${profileId}:`, changedFields, now);
  for (const field of changedFields) bump(payload, `p:${profileId}:${field}`, timestamp);
  // Legacy mirrors remain for older Android builds that predate profile-scoped settings.
  if (Object.prototype.hasOwnProperty.call(next, "defaultSubtitle")) payload.defaultSubtitle = next.defaultSubtitle;
  if (Object.prototype.hasOwnProperty.call(next, "defaultAudioLanguage")) payload.defaultAudioLanguage = next.defaultAudioLanguage;
  for (const field of ["cardLayoutMode", "frameRateMatchingMode", "autoPlayNext", "autoPlaySingleSource", "autoPlayMinQuality", "includeSpecials", "torrServerBaseUrl", "qualityFilters"]) {
    if (Object.prototype.hasOwnProperty.call(next, field)) payload[field] = next[field];
  }
  if (Object.prototype.hasOwnProperty.call(next, "defaultSubtitle")) {
    next.subtitleSettingsUpdatedAt = Math.max(now, (Number(previous.subtitleSettingsUpdatedAt) || 0) + 1);
  }
  assignProfileMap(payload, "profileSettingsById", profileId, next);
}
function applyIptv(payload, profileId, value, now) {
  if (!isObject(value)) throw badRequest("iptv_settings_must_be_an_object");
  if (value.playlists !== undefined) {
    if (!Array.isArray(value.playlists) || value.playlists.length > 100) throw badRequest("iptv_playlists_must_be_an_array_of_at_most_100_items");
    for (const playlist of value.playlists) {
      if (!isObject(playlist) || !String(playlist.id || "").trim()) throw badRequest("each_iptv_playlist_requires_an_id");
      for (const key of ["m3uUrl", "epgUrl"]) if (playlist[key] !== undefined && typeof playlist[key] !== "string") throw badRequest(`iptv_playlist_${key}_must_be_a_string`);
    }
  }
  if (value.stalkerPortals !== undefined) {
    if (!Array.isArray(value.stalkerPortals) || value.stalkerPortals.length > 100) throw badRequest("stalkerPortals_must_be_an_array_of_at_most_100_items");
    for (const portal of value.stalkerPortals) {
      if (!isObject(portal) || !String(portal.id || "").trim()) throw badRequest("each_stalker_portal_requires_an_id");
      for (const key of ["portalUrl", "macAddress"]) if (portal[key] !== undefined && typeof portal[key] !== "string") throw badRequest(`stalker_portal_${key}_must_be_a_string`);
    }
  }
  for (const key of ["favoriteChannels", "favoriteGroups", "hiddenGroups", "lockedGroups", "groupOrder"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 20000 || value[key].some((entry) => typeof entry !== "string"))) throw badRequest(`${key}_must_be_a_string_array`);
  }
  const timestamp = nextTimestamp(payload, `i:${profileId}:`, IPTV_FIELDS, now);
  for (const field of IPTV_FIELDS) bump(payload, `i:${profileId}:${field}`, timestamp);
  assignProfileMap(payload, "iptvByProfile", profileId, value);
  // Keep legacy single-source mirrors in step for older Android clients.
  const playlists = Array.isArray(value.playlists) ? value.playlists : [];
  const primary = playlists.find((entry) => entry && entry.enabled !== false) || playlists[0] || {};
  payload.iptvM3uUrl = String(primary.m3uUrl || value.m3uUrl || "");
  payload.iptvEpgUrl = String(primary.epgUrl || value.epgUrl || "");
  payload.iptvFavoriteChannels = Array.isArray(value.favoriteChannels) ? value.favoriteChannels : [];
  payload.iptvFavoriteGroups = Array.isArray(value.favoriteGroups) ? value.favoriteGroups : [];
  const portals = Array.isArray(value.stalkerPortals) ? value.stalkerPortals : [];
  const firstPortal = portals.find((entry) => entry && entry.enabled !== false) || portals[0] || {};
  payload.iptvStalkerUrl = String(firstPortal.portalUrl || value.stalkerPortalUrl || "");
  payload.iptvStalkerMac = String(firstPortal.macAddress || value.stalkerMacAddress || "");
}
function applyCatalogs(payload, profileId, value, now) {
  if (!isObject(value)) throw badRequest("catalog_settings_must_be_an_object");
  const definitions = [
    ["items", "catalogsByProfile"],
    ["hiddenPreinstalled", "hiddenPreinstalledByProfile"],
    ["hiddenAddons", "hiddenAddonByProfile"],
    ["hiddenHomeServers", "hiddenHomeServerByProfile"]
  ];
  const timestamp = nextTimestamp(payload, `c:${profileId}:`, definitions.map(([, map]) => map), now);
  for (const [field, map] of definitions) {
    const list = value[field];
    if (!Array.isArray(list)) throw badRequest(`${field}_must_be_an_array`);
    if (list.length > 2000) throw badRequest(`${field}_has_too_many_entries`);
    if (field === "items" && list.some((item) => !isObject(item) || !String(item.id || "").trim())) throw badRequest("each_catalog_item_requires_an_id");
    if (field !== "items" && list.some((entry) => typeof entry !== "string")) throw badRequest(`${field}_must_contain_only_strings`);
    assignProfileMap(payload, map, profileId, list);
    bump(payload, `c:${profileId}:${map}`, timestamp);
  }
  payload.catalogs = value.items;
  payload.hiddenPreinstalledCatalogs = value.hiddenPreinstalled;
}
function applyGlobalSettings(payload, value, now) {
  if (!isObject(value)) throw badRequest("global_settings_must_be_an_object");
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!GLOBAL_KEYS.includes(key)) throw badRequest(`unsupported_global_setting:${key}`);
    if (key === "customUserAgent" || key === "subtitleAiApiKey" || key === "subtitleAiModel" || key === "accentColor" || key === "dnsProvider") {
      if (typeof fieldValue !== "string" || fieldValue.length > 4096) throw badRequest(`invalid_${key}`);
    } else if (typeof fieldValue !== "boolean") throw badRequest(`invalid_${key}`);
    payload[key] = fieldValue;
    bump(payload, `g:${key}`, nextTimestamp(payload, "g:", [key], now));
    if (key === "accentColor") payload.focusBorderColor = fieldValue;
  }
}
function applyAddons(payload, profileId, value, now) {
  validateAddons(value);
  now = Math.max(now, (Number(payload.addonsUpdatedAt) || 0) + 1);
  const map = object(payload.addonsByProfile);
  const previous = Array.isArray(map[profileId]) ? map[profileId] : [];
  const oldCanonical = new Map((Array.isArray(payload.addons) ? payload.addons : [])
    .filter((addon) => addon && addon.id).map((addon) => [String(addon.id), addon]));
  const profileMap = { ...object(payload.profileSettingsById) };
  const profile = { ...object(profileMap[profileId]) };
  const overrides = { ...object(profile.streamProviderEnabledMap) };
  const incomingById = new Map();
  for (const addon of value) {
    const id = String(addon.id);
    // The submitted enabled bit is a per-profile preference, never a shared
    // installation update. The admin can enable a source in one profile even
    // when the legacy global record is disabled.
    // The JSON editor's `enabled` field is authoritative. Older Android
    // records also carry `isEnabled`, which may be stale when an admin edits
    // only `enabled` in the form.
    const enabled = typeof addon.enabled === "boolean" ? addon.enabled : addon.isEnabled !== false;
    overrides[`stremio:${id}`] = enabled;
    const { enabled: _enabled, isEnabled: _isEnabled, ...installation } = addon;
    const old = oldCanonical.get(id);
    const sharedEnabled = old ? old.enabled !== false && old.isEnabled !== false : true;
    incomingById.set(id, {
      ...installation,
      enabled: sharedEnabled,
      ...(old?.isEnabled !== undefined ? { isEnabled: sharedEnabled } : {}),
      setupUpdatedAt: now
    });
  }
  profile.streamProviderEnabledMap = overrides;
  profileMap[profileId] = profile;
  payload.profileSettingsById = profileMap;
  bump(payload, `p:${profileId}:streamProviderEnabledMap`,
    nextTimestamp(payload, `p:${profileId}:`, ["streamProviderEnabledMap"], now));

  const removedIds = previous.map((addon) => String(addon?.id || "")).filter((id) => id && !incomingById.has(id));
  const changes = { ...object(payload.addonChanges) };
  for (const id of removedIds) changes[id] = { removed: true, updatedAt: now };
  for (const id of incomingById.keys()) changes[id] = { removed: false, updatedAt: now };
  if (removedIds.length) {
    const removed = new Set(removedIds);
    payload.addons = (Array.isArray(payload.addons) ? payload.addons : []).filter((addon) => !removed.has(String(addon?.id || "")));
    const nextByProfile = {};
    for (const [id, list] of Object.entries(map)) {
      nextByProfile[id] = (Array.isArray(list) ? list : []).filter((addon) => !removed.has(String(addon?.id || "")));
    }
    payload.addonsByProfile = nextByProfile;
    // Clean up removed source overrides for all profiles as a courtesy.
    for (const settings of Object.values(profileMap)) {
      if (settings && typeof settings === "object") {
        const flags = object(settings.streamProviderEnabledMap);
        for (const id of removedIds) delete flags[`stremio:${id}`];
      }
    }
  }
  const canonical = new Map((Array.isArray(payload.addons) ? payload.addons : []).map((addon) => [String(addon?.id || ""), addon]));
  for (const [id, addon] of incomingById) canonical.set(id, { ...(canonical.get(id) || {}), ...addon });
  payload.addons = [...canonical.values()].filter((addon) => addon && addon.id);
  payload.addonsByProfile = { ...object(payload.addonsByProfile), [profileId]: [...incomingById.values()] };
  payload.addonChanges = changes;
  payload.addonsUpdatedAt = now;
}

function applyIntegrations(payload, profileId, value, now) {
  if (!isObject(value)) throw badRequest("integrations_must_be_an_object");
  const trackingMap = { ...object(payload.mdbListSyncByProfile) };
  const previousTracking = object(trackingMap[profileId]);
  const incomingTracking = value.tracking === undefined ? {} : value.tracking;
  if (!isObject(incomingTracking)) throw badRequest("integration_records_must_be_objects");
  const tracking = { ...previousTracking, ...incomingTracking };
  // SIMKL/WeTrakr credentials live in the encrypted provider table. MDBList's existing
  // credential fields are preserved server-side but never accepted from or returned to UI.
  for (const key of ["simklAccessToken", "simklCredentialUpdatedAt"]) delete tracking[key];
  for (const key of ["mdbListApiKey", "mdbListAccessToken", "mdbListRefreshToken", "mdbListTokenExpiresAt", "mdbListCredentialUpdatedAt"]) {
    if (Object.prototype.hasOwnProperty.call(previousTracking, key)) tracking[key] = previousTracking[key];
    else delete tracking[key];
  }
  const timestamp = Math.max(now, (Number(previousTracking.updatedAt) || 0) + 1);
  tracking.updatedAt = timestamp;
  trackingMap[profileId] = tracking;
  payload.mdbListSyncByProfile = trackingMap;
  if (object(payload.simklTokens)[profileId]) {
    const simklMap = { ...object(payload.simklTokens) };
    delete simklMap[profileId];
    payload.simklTokens = simklMap;
  }
}

async function loadTargetSnapshot(event, account) {
  const identity = { email: account.email, supabaseUserId: account.accountId };
  const result = await backend.loadSnapshotForUpdate(event, identity);
  return { identity, ...result };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST" && event.httpMethod !== "PUT") return json(405, { error: "method_not_allowed" });
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;

  try {
    if (event.httpMethod === "GET") {
      const email = String(event.queryStringParameters?.email || "").trim().toLowerCase();
      const accountRecord = await findAccount(email);
      if (!accountRecord) return json(404, { error: "user_not_found" });
      const { snapshot } = await loadTargetSnapshot(event, accountRecord.data);
      if (!snapshot) return json(404, { error: "sync_snapshot_not_found" });
      const payload = asPayload(snapshot);
      const profiles = Array.isArray(payload.profiles) ? payload.profiles.map((profile) => ({ id: String(profile?.id || ""), name: String(profile?.name || "Unnamed profile") })) : [];
      const profileId = String(event.queryStringParameters?.profileId || profiles[0]?.id || "");
      if (!profileId || !profileExists(payload, profileId)) return json(404, { error: "profile_not_found", profiles });
      const providerResult = await backend.getPool().query(
        `SELECT provider,status,provider_username,connected_at,expires_at,refresh_expires_at
           FROM public.arvio_provider_credentials
          WHERE account_id = (
            SELECT id FROM public.arvio_accounts
             WHERE supabase_user_id = $1::uuid OR email_normalized = $2
             ORDER BY CASE WHEN supabase_user_id = $1::uuid THEN 0 ELSE 1 END
             LIMIT 1
          ) AND profile_id = $3 AND provider IN ('simkl','wetrakr')`,
        [accountRecord.data.accountId, email, profileId]
      );
      const providerStatuses = Object.fromEntries(providerResult.rows.map((row) => [row.provider, {
        provider: row.provider, status: row.status, connected: row.status === "connected",
        username: row.provider_username || null, connectedAt: row.connected_at || null,
        expiresAt: row.expires_at || null, refreshExpiresAt: row.refresh_expires_at || null
      }]));
      return json(200, { email, profiles, profileId, config: selectedConfig(payload, profileId, providerStatuses), updatedAt: snapshot.updatedAt || snapshot.payloadUpdatedAt || null });
    }

    const body = parseBody(event);
    const email = String(body.email || "").trim().toLowerCase();
    const profileId = String(body.profileId || "").trim();
    const section = String(body.section || "").trim();
    if (!email || !profileId || body.value === undefined || !["profileSettings", "addons", "iptv", "catalogs", "globalSettings", "integrations"].includes(section)) {
      return json(400, { error: "invalid_request" });
    }
    validateSize(body.value);
    const accountRecord = await findAccount(email);
    if (!accountRecord) return json(404, { error: "user_not_found" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { identity, snapshot, etag } = await loadTargetSnapshot(event, accountRecord.data);
      if (!snapshot) return json(404, { error: "sync_snapshot_not_found" });
      const payload = asPayload(snapshot);
      if (!profileExists(payload, profileId)) return json(404, { error: "profile_not_found" });
      const now = Date.now();
      switch (section) {
        case "profileSettings": applyProfileSettings(payload, profileId, body.value, now); break;
        case "addons": applyAddons(payload, profileId, body.value, now); break;
        case "iptv": applyIptv(payload, profileId, body.value, now); break;
        case "catalogs": applyCatalogs(payload, profileId, body.value, now); break;
        case "globalSettings": applyGlobalSettings(payload, body.value, now); break;
        case "integrations": applyIntegrations(payload, profileId, body.value, now); break;
      }
      const serialized = JSON.stringify(payload);
      const updated = {
        ...snapshot,
        payload: serialized,
        payloadVersion: Number(snapshot.payloadVersion || snapshot.payload_version || 1),
        payloadUpdatedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        profileCount: Array.isArray(payload.profiles) ? payload.profiles.length : 0,
        source: "admin"
      };
      const saved = await backend.saveSnapshotToBlobs(event, identity, updated, { etag });
      if (!saved) continue;
      await backend.appendSnapshotEvent(event, identity, saved);
      await writeAudit(auth.identity.email, "profile_config_updated", email, {
        profileId, section,
        changedKeys: section === "profileSettings" || section === "globalSettings" ? Object.keys(body.value || {}).slice(0, 100) : undefined,
        entryCount: Array.isArray(body.value) ? body.value.length : undefined
      });
      return json(200, { ok: true, email, profileId, section, updatedAt: updated.updatedAt });
    }
    return json(409, { error: "sync_snapshot_write_conflict", message: "The account changed repeatedly while saving. Reload the configuration and try again." });
  } catch (error) {
    console.error("Admin profile configuration operation failed", error);
    return json(error.statusCode || 500, { error: error.statusCode === 400 ? error.message : "profile_config_operation_failed" });
  }
};

exports._test = { selectedConfig, applyProfileSettings, applyIptv, applyCatalogs, applyGlobalSettings, applyIntegrations, applyAddons, validateAddons };

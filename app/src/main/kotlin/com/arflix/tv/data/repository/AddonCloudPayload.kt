package com.arflix.tv.data.repository

import com.arflix.tv.data.model.Addon
import com.arflix.tv.data.model.AddonType
import com.arflix.tv.data.model.AddonInstallSource
import com.arflix.tv.data.model.RuntimeKind
import com.google.gson.Gson
import org.json.JSONArray
import org.json.JSONObject

/**
 * The cloud contains both Android Addon records and Web InstalledAddon records.
 * Normalize each record *before* Gson so one legacy manifest resource (a string
 * instead of an object), or a missing Kotlin enum, cannot abort the entire pull.
 * Never log entries: their manifest URLs may contain provider credentials.
 */
internal data class CloudAddonDecode(val addons: List<Addon>, val rejected: Int)

private fun JSONObject.nonBlank(key: String): String =
    if (isNull(key)) "" else optString(key, "").trim().takeUnless { it == "null" }.orEmpty()

private fun arrayValue(value: Any?): JSONArray? = when (value) {
    is JSONArray -> value
    is String -> runCatching { JSONArray(value) }.getOrNull()
    else -> null
}

private fun normalizeResources(raw: JSONArray?): JSONArray = JSONArray().also { out ->
    if (raw == null) return@also
    for (i in 0 until raw.length()) {
        val value = raw.opt(i)
        val item = when (value) {
            is String -> JSONObject().put("name", value).put("types", JSONArray())
            is JSONObject -> JSONObject(value.toString())
            else -> null
        } ?: continue
        if (item.nonBlank("name").isBlank()) continue
        if (item.optJSONArray("types") == null) item.put("types", JSONArray())
        out.put(item)
    }
}

private fun normalizeCatalogs(raw: JSONArray?): JSONArray = JSONArray().also { out ->
    if (raw == null) return@also
    for (i in 0 until raw.length()) {
        val value = raw.optJSONObject(i) ?: continue
        val id = value.nonBlank("id")
        if (id.isBlank()) continue
        val copy = JSONObject(value.toString())
        if (copy.nonBlank("type").isBlank()) copy.put("type", "movie")
        if (copy.nonBlank("name").isBlank()) copy.put("name", id)
        out.put(copy)
    }
}

/** Returns null only for an unusable record, never for another record's error. */
internal fun decodeCloudAddon(raw: JSONObject, gson: Gson): Addon? = runCatching {
    val record = JSONObject(raw.toString())
    val rawManifest = record.optJSONObject("manifest")
    val id = record.nonBlank("id").ifBlank { rawManifest?.nonBlank("id").orEmpty() }
        .ifBlank { record.nonBlank("manifestUrl") }.ifBlank { record.nonBlank("url") }
    if (id.isBlank()) return@runCatching null
    val name = record.nonBlank("name").ifBlank { rawManifest?.nonBlank("name").orEmpty() }.ifBlank { id }
    val version = record.nonBlank("version").ifBlank { rawManifest?.nonBlank("version").orEmpty() }.ifBlank { "1.0.0" }
    val url = record.nonBlank("url").ifBlank { record.nonBlank("manifestUrl") }
    val transportUrl = record.nonBlank("transportUrl")

    record.put("id", id)
    record.put("name", name)
    record.put("version", version)
    if (record.nonBlank("description").isBlank()) record.put("description", "")
    record.put("isInstalled", record.optBoolean("isInstalled", true))
    val enabled = if (!record.isNull("isEnabled")) record.optBoolean("isEnabled", true)
        else record.optBoolean("enabled", true)
    record.put("isEnabled", enabled)
    if (url.isNotBlank()) record.put("url", url)
    if (transportUrl.isNotBlank()) record.put("transportUrl", transportUrl)
    val kind = record.nonBlank("type").uppercase()
    if (AddonType.entries.none { it.name == kind }) record.put("type", "CUSTOM")
    else record.put("type", kind)
    val runtime = record.nonBlank("runtimeKind").uppercase()
    if (RuntimeKind.entries.none { it.name == runtime }) record.put("runtimeKind", "STREMIO")
    val source = record.nonBlank("installSource").uppercase()
    if (AddonInstallSource.entries.none { it.name == source }) record.put("installSource", "DIRECT_URL")

    // A web record may supply catalog/resource data only at its top level.
    val hasTopMetadata = record.optJSONArray("resources") != null || record.optJSONArray("catalogs") != null
    if (rawManifest != null || hasTopMetadata) {
        val manifest = JSONObject(rawManifest?.toString() ?: "{}")
        if (manifest.nonBlank("id").isBlank()) manifest.put("id", id)
        if (manifest.nonBlank("name").isBlank()) manifest.put("name", name)
        if (manifest.nonBlank("version").isBlank()) manifest.put("version", version)
        if (manifest.nonBlank("description").isBlank()) manifest.put("description", record.nonBlank("description"))
        manifest.put("resources", normalizeResources(
            arrayValue(manifest.opt("resources")) ?: arrayValue(record.opt("resources"))
        ))
        manifest.put("catalogs", normalizeCatalogs(
            arrayValue(manifest.opt("catalogs")) ?: arrayValue(record.opt("catalogs"))
        ))
        if (manifest.optJSONArray("types") == null) manifest.put("types", record.optJSONArray("types") ?: JSONArray())
        record.put("manifest", manifest)
    }
    // Prevent an unusable web placeholder from displacing an actual installation.
    if (url.isBlank() && transportUrl.isBlank() && record.optJSONObject("manifest") == null && id != "opensubtitles") {
        return@runCatching null
    }
    gson.fromJson(record.toString(), Addon::class.java)?.takeIf { it.id.isNotBlank() }
}.getOrNull()

internal fun decodeCloudAddonArray(value: Any?, gson: Gson): CloudAddonDecode {
    val array = arrayValue(value) ?: return CloudAddonDecode(emptyList(), 0)
    val result = ArrayList<Addon>(array.length())
    var rejected = 0
    for (i in 0 until array.length()) {
        val record = array.optJSONObject(i)
        val addon = record?.let { decodeCloudAddon(it, gson) }
        if (addon == null) rejected++ else result.add(addon)
    }
    return CloudAddonDecode(result, rejected)
}

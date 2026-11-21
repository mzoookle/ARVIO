package com.arflix.tv.data.repository.simkl

import com.google.gson.JsonObject
import java.io.IOException

class SimklListsException(val reason: String, val status: Int = 0) : IOException(when (reason) {
    "premium_only" -> "SIMKL custom lists require a SIMKL PRO or VIP account."
    "oauth2_token_required", "user_token_required", "invalid_grant", "user_token_failed", "expired_token" -> "Connect SIMKL Lists in Add catalogue to access custom lists."
    "invalid_client", "client_id_failed" -> "SIMKL Lists requires ARVIO's AUTH V2 client configuration."
    "private_list" -> "This SIMKL list is private. Connect an account that has access."
    "url_failed" -> "This SIMKL list could not be found."
    "rate_limit", "slow_down" -> "SIMKL is limiting requests. Please try again later."
    else -> "SIMKL could not load this list ($reason)."
})

data class SimklListItem(
    val title: String, val year: Int?, val type: String, val animeType: String?,
    val tmdb: Int?, val imdb: String?, val tvdb: Int?, val poster: String?
)

data class SimklCustomList(
    val id: Long, val name: String, val mediaType: String, val description: String?,
    val ownerId: Long?, val ownerName: String?, val slug: String?, val updatedAt: String?,
    val count: Int?, val likes: Int?, val auto: Boolean, val posters: List<String>,
    val items: List<SimklListItem> = emptyList()
) {
    val url: String get() = if (ownerId != null) "https://simkl.com/$ownerId/list/$id" else "https://simkl.com/lists/$id"
}

data class SimklListsDeviceCode(val deviceCode: String, val userCode: String, val url: String, val expiresIn: Int, val interval: Int, val verifier: String)
data class SimklListsGrant(val accessToken: String, val refreshToken: String, val expiresAt: Long, val userId: Long? = null,
    val connectionId: String = java.util.UUID.randomUUID().toString())

/** SIMKL custom-list API calls are proxied through the account-owned provider coordinator. */
class SimklListsClient(
    private val coordinator: com.arflix.tv.data.repository.provider.ProviderCoordinatorClient
) {
    suspend fun startDevice(profileId: String): SimklListsDeviceCode {
        val body = coordinator.action("simkl", "start", profileId)
        return SimklListsDeviceCode(
            deviceCode = "server-managed",
            userCode = body.get("userCode")?.asString ?: throw SimklListsException("invalid_response"),
            url = body.get("verificationUrl")?.asString ?: throw SimklListsException("invalid_response"),
            expiresIn = body.get("expiresIn")?.asInt ?: 900,
            interval = (body.get("interval")?.asInt ?: 5).coerceAtLeast(5),
            verifier = "server-managed"
        )
    }

    suspend fun poll(session: SimklListsDeviceCode, profileId: String): SimklListsGrant {
        val result = coordinator.action("simkl", "poll", profileId)
        if (result.get("connected")?.asBoolean != true) throw SimklListsException("authorization_pending", 400)
        return SimklListsGrant("arvio-coordinator", "server-managed", Long.MAX_VALUE, connectionId = "server-managed")
    }

    suspend fun userId(token: String, profileId: String): Long = request("users/settings", token, jsonPost = true, profileId = profileId)
        .getAsJsonObject("account")?.text("id")?.toLongOrNull()?.takeIf { it > 0 }
        ?: throw SimklListsException("invalid_response")

    suspend fun list(id: Long, token: String, profileId: String): SimklCustomList {
        require(id > 0)
        val first = request("lists/$id", token, query = mapOf("limit" to "500", "page" to "1"), profileId = profileId)
        val metadata = parseList(first)
        val items = parseItems(first)
        val pages = pages(first)
        if (pages > 20) throw SimklListsException("list_exceeds_api_limit")
        val all = items.toMutableList()
        for (page in 2..pages) all += parseItems(request("lists/$id", token,
            query = mapOf("limit" to "500", "page" to page.toString()), profileId = profileId))
        return metadata.copy(items = all.distinct())
    }

    suspend fun userLists(userId: Long, token: String, profileId: String, previewOnly: Boolean = false, sort: String = "updated"): List<SimklCustomList> {
        val result = mutableListOf<SimklCustomList>()
        var page = 1
        do {
            val query = mapOf("limit" to "500", "page" to page.toString()) + if (previewOnly)
                mapOf("sort" to sort, "direction" to "desc") else mapOf("followed" to "true", "collaborants" to "true")
            val body = request("lists/user/$userId", token, query = query, profileId = profileId)
            val lists = body.getAsJsonArray("lists") ?: throw SimklListsException("invalid_response")
            result += lists.map { parseList(it.asJsonObject) }
            val total = if (previewOnly) 1 else pages(body)
            if (total > 20) throw SimklListsException("list_exceeds_api_limit")
            page++
        } while (page <= total)
        return result.distinctBy { it.id }
    }

    suspend fun officialLists(token: String, profileId: String): List<SimklCustomList> =
        (userLists(5, token, profileId, previewOnly = true) + userLists(5, token, profileId, previewOnly = true, sort = "popularity")).distinctBy { it.id }

    private fun pages(body: JsonObject): Int = (body.getAsJsonObject("pagination")?.number("total_pages") ?: 1).coerceAtLeast(1)

    private fun parseList(body: JsonObject): SimklCustomList {
        val id = body.required("id").toLongOrNull()?.takeIf { it > 0 } ?: throw SimklListsException("invalid_response")
        val user = body.getAsJsonObject("user")
        val counts = body.getAsJsonObject("counts")
        return SimklCustomList(id, body.required("name"), body.text("media_type") ?: "movies", body.text("description"),
            user?.text("id")?.toLongOrNull(), user?.text("name") ?: user?.text("username"), body.text("slug"),
            body.text("updated_at"), counts?.number("items"), counts?.number("likes"), body.text("type") == "auto",
            body.getAsJsonArray("top_items")?.mapNotNull { poster(it.asJsonObject.text("poster")) }.orEmpty())
    }

    private fun parseItems(body: JsonObject): List<SimklListItem> {
        val type = body.text("media_type") ?: "movies"
        val items = body.getAsJsonArray("items") ?: throw SimklListsException("invalid_response")
        return items.mapNotNull { element ->
            val item = element.asJsonObject
            val title = item.text("title") ?: return@mapNotNull null
            val ids = item.getAsJsonObject("ids")
            SimklListItem(title, item.number("year"), item.text("type") ?: type, item.text("anime_type"),
                ids?.number("tmdb"), ids?.text("imdb"), ids?.number("tvdb"), poster(item.text("poster")))
        }
    }

    private suspend fun request(path: String, token: String? = null, query: Map<String, String> = emptyMap(),
        form: Map<String, String>? = null, jsonPost: Boolean = false, profileId: String): JsonObject {
        val queryString = query.entries.joinToString("&") { (key, value) ->
            java.net.URLEncoder.encode(key, "UTF-8") + "=" + java.net.URLEncoder.encode(value, "UTF-8")
        }
        val fullPath = "/$path" + if (queryString.isNotBlank()) "?$queryString" else ""
        val payload: Any? = when {
            form != null -> form
            jsonPost -> emptyMap<String, String>()
            else -> null
        }
        val result = coordinator.request("simkl", fullPath, if (payload != null) "POST" else "GET", payload, profileId)
        val body = result.data.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
        val error = body.text("error")
        if (result.status !in 200..299 || error != null) throw SimklListsException(error ?: "http_${result.status}", result.status)
        return body
    }

    companion object {
        fun poster(value: String?): String? = value?.takeIf { it.isNotBlank() }?.let {
            if (it.startsWith("https://simkl.in/")) it else if (!it.contains(":") && !it.contains("..")) "https://simkl.in/posters/${it}_m.webp" else null
        }
    }
}

private fun JsonObject.text(key: String): String? = get(key)?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() }
private fun JsonObject.number(key: String): Int? = text(key)?.toIntOrNull()
private fun JsonObject.required(key: String): String = text(key) ?: throw SimklListsException("invalid_response")

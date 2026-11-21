package com.arflix.tv.data.repository.wetrakr

import com.arflix.tv.data.repository.ProfileManager
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

internal fun JsonObject.text(key: String): String? = get(key)?.takeUnless { it.isJsonNull }?.runCatching { asString }?.getOrNull()
internal fun JsonObject.obj(key: String): JsonObject = get(key)?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
internal fun JsonObject.int(key: String): Int? = text(key)?.toIntOrNull()
internal fun JsonObject.tmdb(): Int? = obj("ids").int("tmdb")?.takeIf { it > 0 }

class WeTrakrError(val status: Int, val reason: String, val retrySeconds: Long = 5) : Exception(
    when {
        status == 429 -> "WeTrakr is limiting requests. Please try again later."
        reason == "expired_token" -> "The WeTrakr code expired. Request a new code."
        reason == "access_denied" -> "WeTrakr connection was declined."
        status == 401 -> "Please reconnect WeTrakr on this device."
        else -> "WeTrakr could not complete this request. Please try again."
    }
)

data class WeTrakrDeviceCode(val userCode: String, val verificationUrl: String, val expiresAt: Long, val interval: Long)

/** Server-owned WeTrakr connection. This repository never stores provider access or refresh tokens. */
@Singleton
class WeTrakrRepository @Inject constructor(
    private val profiles: ProfileManager,
    private val coordinator: com.arflix.tv.data.repository.provider.ProviderCoordinatorClient
) {
    private val connectedProfiles = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
    private val statusAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = mutableMapOf<String, Pair<WeTrakrDeviceCode, Long>>()
    private val cache = mutableMapOf<String, Pair<Long, List<JsonObject>>>()
    private var blockedUntil = 0L

    init { scope.launch { runCatching { refreshStatus(profileId()) } } }

    fun profileId(): String = profiles.getProfileIdSync()
    fun isConnected(profile: String = profileId()): Boolean = connectedProfiles[profile] == true

    suspend fun refreshStatus(profile: String = profileId(), force: Boolean = false): Boolean {
        val checkedAt = statusAt[profile] ?: 0L
        if (!force && System.currentTimeMillis() - checkedAt < 30_000L) return isConnected(profile)
        val status = coordinator.status("wetrakr", profile)
        val connected = status.get("connected")?.asBoolean == true
        connectedProfiles[profile] = connected
        statusAt[profile] = System.currentTimeMillis()
        return connected
    }

    suspend fun start(profile: String = profileId()): WeTrakrDeviceCode = mutex.withLock {
        pending[profile]?.first?.takeIf { it.expiresAt > System.currentTimeMillis() }?.let { return@withLock it }
        val data = coordinator.action("wetrakr", "start", profile)
        val url = data.get("verificationUrl")?.asString ?: error("Missing verification URL")
        require(url == "https://wetrakr.com/activate")
        val interval = (data.get("interval")?.asLong ?: 5L).coerceAtLeast(5L)
        val code = WeTrakrDeviceCode(
            data.get("userCode")?.asString ?: error("Missing user code"), url,
            System.currentTimeMillis() + (data.get("expiresIn")?.asLong ?: 600L).coerceIn(1L, 1800L) * 1000L,
            interval
        )
        pending[profile] = code to (System.currentTimeMillis() + interval * 1000L)
        code
    }

    suspend fun cancel(profile: String = profileId()) = mutex.withLock { pending.remove(profile); Unit }

    suspend fun poll(profile: String = profileId()): Boolean = mutex.withLock {
        val flow = pending[profile] ?: throw WeTrakrError(410, "expired_token")
        if (flow.first.expiresAt <= System.currentTimeMillis()) { pending.remove(profile); throw WeTrakrError(410, "expired_token") }
        if (System.currentTimeMillis() < flow.second) return@withLock false
        try {
            val data = coordinator.action("wetrakr", "poll", profile)
            val connected = data.get("connected")?.asBoolean == true
            if (connected) {
                connectedProfiles[profile] = true
                statusAt[profile] = System.currentTimeMillis()
                pending.remove(profile)
                cache.clear()
                true
            } else {
                val retry = data.get("retryAfter")?.asLong ?: 5L
                pending[profile] = flow.first to (System.currentTimeMillis() + retry.coerceAtLeast(5L) * 1000L)
                false
            }
        } catch (e: com.arflix.tv.data.repository.provider.ProviderCoordinatorException) {
            when {
                e.status == 429 -> { pending[profile] = flow.first to (System.currentTimeMillis() + (e.retryAfter ?: 10L).coerceAtLeast(5L) * 1000L); false }
                e.status == 410 -> { pending.remove(profile); throw WeTrakrError(410, "expired_token") }
                else -> throw WeTrakrError(e.status, e.reason, e.retryAfter ?: 5L)
            }
        }
    }

    suspend fun disconnect(profile: String = profileId()) = mutex.withLock {
        coordinator.action("wetrakr", "disconnect", profile)
        connectedProfiles.remove(profile)
        statusAt[profile] = System.currentTimeMillis()
        pending.remove(profile)
        cache.clear()
        Unit
    }

    suspend fun request(path: String, method: String = "GET", body: Any? = null, profile: String = profileId()): Pair<JsonElement, Map<String, String>> {
        refreshStatus(profile)
        if (!isConnected(profile)) throw WeTrakrError(401, "session_required")
        if (System.currentTimeMillis() < blockedUntil) throw WeTrakrError(429, "rate_limited", (blockedUntil - System.currentTimeMillis()) / 1000 + 1)
        val result = coordinator.request("wetrakr", path, method, body, profile)
        if (result.status !in 200..299) {
            val reason = result.data.takeIf { it.isJsonObject }?.asJsonObject?.text("error") ?: "provider_error"
            val retry = result.headers["retry-after"]?.toLongOrNull()?.coerceAtLeast(5) ?: 60
            if (result.status == 429) blockedUntil = System.currentTimeMillis() + retry * 1000
            if (result.status == 401 && reason == "reconnect_required") {
                connectedProfiles[profile] = false
                statusAt[profile] = System.currentTimeMillis()
            }
            throw WeTrakrError(result.status, reason, retry)
        }
        return result.data to result.headers
    }

    suspend fun list(status: String, target: String, force: Boolean = false, profile: String = profileId()): List<JsonObject> {
        refreshStatus(profile)
        if (!isConnected(profile)) throw WeTrakrError(401, "session_required")
        val key = "$profile:$status:$target"
        mutex.withLock { cache[key]?.takeIf { !force && System.currentTimeMillis() - it.first < 300000 }?.let { return it.second } }
        val rows = mutableListOf<JsonObject>()
        var page = 1
        do {
            val (data, headers) = request("/sync/tracking/$status/$target?limit=100&page=$page&extended=show_level_1,episode_level_1", profile = profile)
            check(data.isJsonArray) { "Invalid WeTrakr list" }
            rows += data.asJsonArray.map { it.asJsonObject }
            val count = headers["x-pagination-page-count"]?.toIntOrNull()
            if (count != null && page >= count || count == null && data.asJsonArray.size() < 100) break
            check(++page <= 10000) { "WeTrakr pagination did not finish" }
        } while (true)
        mutex.withLock { cache[key] = System.currentTimeMillis() to rows }
        return rows
    }

    suspend fun invalidate() = mutex.withLock { cache.clear() }
}

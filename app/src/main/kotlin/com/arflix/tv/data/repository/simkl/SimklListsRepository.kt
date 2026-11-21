package com.arflix.tv.data.repository.simkl

import com.arflix.tv.data.model.CatalogDiscoveryResult
import com.arflix.tv.data.model.CatalogSourceType
import com.arflix.tv.data.repository.ProfileManager
import com.arflix.tv.data.repository.provider.ProviderCoordinatorClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/** SIMKL credentials and refreshes are owned by the ARVIO server, never by this installation. */
@Singleton
class SimklListsRepository @Inject constructor(
    private val profileManager: ProfileManager,
    private val coordinator: ProviderCoordinatorClient
) {
    private val mutex = Mutex()
    private val client = SimklListsClient(coordinator)
    private val cache = mutableMapOf<String, Pair<Long, SimklCustomList>>()
    private val indexCache = mutableMapOf<String, Pair<Long, List<SimklCustomList>>>()
    private val status = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
    private val statusAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init { scope.launch { runCatching { refreshStatus(profileId()) } } }

    fun profileId(): String = profileManager.getProfileIdSync()
    fun isConnected(profile: String = profileId()): Boolean = status[profile] == true
    suspend fun refreshStatus(profile: String = profileId(), force: Boolean = false): Boolean {
        val checkedAt = statusAt[profile] ?: 0L
        if (!force && System.currentTimeMillis() - checkedAt < STATUS_CACHE_MS) return isConnected(profile)
        val connected = coordinator.status("simkl", profile).get("connected")?.asBoolean == true
        status[profile] = connected
        statusAt[profile] = System.currentTimeMillis()
        return connected
    }
    suspend fun accessToken(): String = if (isConnected()) COORDINATOR_TOKEN else throw SimklListsException("user_token_required", 401)
    fun connectionId(): String? = if (isConnected()) COORDINATOR_CONNECTION else null
    fun ownsAccessToken(token: String): Boolean = token == COORDINATOR_TOKEN
    suspend fun refreshRejectedToken(rejected: String, profile: String = profileId(), connection: String? = connectionId()): String {
        if (profile != profileId() || connection != COORDINATOR_CONNECTION || !refreshStatus(profile)) throw SimklListsException("user_token_required", 401)
        return COORDINATOR_TOKEN
    }

    suspend fun startDevice(): SimklListsDeviceCode = client.startDevice(profileId())

    suspend fun poll(session: SimklListsDeviceCode, profile: String): Boolean {
        if (profile != profileId()) throw kotlinx.coroutines.CancellationException("SIMKL profile changed")
        return try {
            client.poll(session, profile)
            status[profile] = true
            statusAt[profile] = System.currentTimeMillis()
            indexCache.remove(profile)
            cache.keys.removeAll { it.startsWith("$profile:") }
            true
        } catch (e: SimklListsException) {
            if (e.reason == "authorization_pending") return false
            throw e
        }
    }

    suspend fun disconnect(afterLocalDisconnect: suspend () -> Unit = {}) {
        val profile = profileId()
        coordinator.action("simkl", "disconnect", profile)
        status[profile] = false
        statusAt[profile] = System.currentTimeMillis()
        indexCache.remove(profile)
        cache.keys.removeAll { it.startsWith("$profile:") }
        afterLocalDisconnect()
    }

    suspend fun load(id: Long, force: Boolean = false): SimklCustomList = mutex.withLock {
        val profile = profileId()
        if (!refreshStatus(profile)) throw SimklListsException("user_token_required", 401)
        val key = "$profile:$id"
        val cached = cache[key]
        val ttl = if (cached?.second?.auto == true) 86_400_000 else 15 * 60_000
        if (!force && cached != null && System.currentTimeMillis() - cached.first < ttl) return@withLock cached.second
        val list = client.list(id, COORDINATOR_TOKEN, profile)
        cache[key] = System.currentTimeMillis() to list
        list
    }

    suspend fun search(query: String): List<CatalogDiscoveryResult> = mutex.withLock {
        val profile = profileManager.getProfileIdSync()
        if (!refreshStatus(profile)) return@withLock emptyList()
        val cached = indexCache[profile]
        val lists = if (cached != null && System.currentTimeMillis() - cached.first < 15 * 60_000) cached.second else {
            val userId = client.userId(COORDINATOR_TOKEN, profile)
            (client.userLists(userId, COORDINATOR_TOKEN, profile) + if (userId != 5L) client.officialLists(COORDINATOR_TOKEN, profile) else emptyList())
                .distinctBy { it.id }.also { fresh ->
                    fresh.forEach { entry ->
                        val key = "$profile:${entry.id}"
                        if (!entry.auto && cache[key]?.second?.updatedAt != entry.updatedAt) cache.remove(key)
                    }
                    indexCache[profile] = System.currentTimeMillis() to fresh
                }
        }
        lists.filter { it.name.contains(query, true) || it.description?.contains(query, true) == true }.map { list ->
            CatalogDiscoveryResult("simkl:${list.id}", list.name, list.description, CatalogSourceType.SIMKL,
                list.url, list.ownerName, list.ownerId?.toString(), list.updatedAt, list.count, list.likes, list.posters)
        }
    }

    companion object {
        const val COORDINATOR_TOKEN = "arvio-provider-coordinator"
        const val COORDINATOR_CONNECTION = "server-managed"
        private const val STATUS_CACHE_MS = 30_000L
    }
}

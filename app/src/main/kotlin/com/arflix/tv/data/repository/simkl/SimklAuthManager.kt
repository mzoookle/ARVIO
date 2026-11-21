package com.arflix.tv.data.repository.simkl

import com.arflix.tv.data.api.SimklApi
import com.arflix.tv.data.api.SimklPinResponse
import com.arflix.tv.data.repository.sync.SyncProvider
import com.arflix.tv.data.repository.sync.SyncProviderStore
import javax.inject.Inject
import javax.inject.Singleton

class SimklPinExpiredException(message: String) : Exception(message)

sealed class SimklPinAuthState {
    object Idle : SimklPinAuthState()
    data class CodeRequested(val userCode: String, val verificationUrl: String, val expiresIn: Int) : SimklPinAuthState()
    object Success : SimklPinAuthState()
    data class Error(val message: String) : SimklPinAuthState()
}

@Singleton
class SimklAuthManager @Inject constructor(
    private val simklApi: SimklApi,
    private val syncProviderStore: SyncProviderStore,
    private val v2: SimklListsRepository? = null
) {
    val effectiveClientId: String get() = "server-managed"
    fun isV2Connected(): Boolean = v2?.isConnected() == true
    fun cacheIdentity(token: String): String = v2?.connectionId() ?: token
    private var session: SimklListsDeviceCode? = null
    private var sessionProfile: String? = null
    private var nextPollAt = 0L
    private var pollInterval = 5
    fun cancelPinAuth() { session = null; sessionProfile = null }


    suspend fun getAccessToken(): String? {
        val coordinator = v2 ?: return null
        try { coordinator.refreshStatus() }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { /* Keep the last known connected state during an outage. */ }
        return if (coordinator.isConnected()) com.arflix.tv.data.repository.simkl.SimklListsRepository.COORDINATOR_TOKEN else null
    }

    suspend fun isConnected(): Boolean {
        val coordinator = v2 ?: return false
        try { coordinator.refreshStatus() }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { /* Keep the last known connected state during an outage. */ }
        return coordinator.isConnected()
    }

    suspend fun startPinAuth(): SimklPinResponse {
        if (v2 != null) {
            cancelPinAuth()
            val profile = v2.profileId()
            val code = v2.startDevice()
            if (profile != v2.profileId()) throw SimklPinExpiredException("SIMKL profile changed")
            session = code
            sessionProfile = profile
            pollInterval = code.interval
            nextPollAt = System.currentTimeMillis() + pollInterval * 1000L
            return SimklPinResponse(code.userCode, code.url, code.expiresIn, code.interval)
        }
        throw SimklPinExpiredException("SIMKL cloud coordinator is unavailable")
    }

    suspend fun pollPinAuth(userCode: String): Boolean {
        session?.let { code ->
            if (code.userCode != userCode || sessionProfile != v2?.profileId()) throw SimklPinExpiredException("SIMKL sign-in was cancelled")
            if (System.currentTimeMillis() < nextPollAt) return false
            nextPollAt = System.currentTimeMillis() + pollInterval * 1000L
            try {
                v2!!.poll(code, sessionProfile!!)
                cancelPinAuth()
                syncProviderStore.onProviderConnected(SyncProvider.SIMKL)
                return true
            } catch (e: SimklListsException) {
                when (e.reason) {
                    "authorization_pending" -> return false
                    "slow_down" -> { pollInterval += 5; nextPollAt = System.currentTimeMillis() + pollInterval * 1000L; return false }
                    else -> { cancelPinAuth(); throw SimklPinExpiredException(e.message.orEmpty()) }
                }
            }
        }
        if (v2 != null) throw SimklPinExpiredException("SIMKL sign-in was cancelled")
        throw SimklPinExpiredException("SIMKL sign-in was cancelled")
    }

    suspend fun fetchUsername(): String? {
        val token = getAccessToken() ?: return null
        val authHeader = "Bearer $token"
        val effectiveClientId = this.effectiveClientId.ifBlank { "simkl_proxy" }
        return try {
            val res = simklApi.getUserSettings(authHeader, effectiveClientId)
            res.user?.name ?: res.user?.username
        } catch (e: Exception) {
            null
        }
    }

    suspend fun disconnect() {
        cancelPinAuth()
        val profile = v2?.profileId()
        if (v2 != null && profile != null) {
            v2.disconnect {
                syncProviderStore.setSimklAccessToken(null, profile)
                syncProviderStore.onProviderDisconnected(SyncProvider.SIMKL, profile)
            }
        } else {
            syncProviderStore.setSimklAccessToken(null)
            syncProviderStore.onProviderDisconnected(SyncProvider.SIMKL)
        }
    }
}


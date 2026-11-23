package com.arflix.tv.updater

import android.content.Context
import android.os.Build
import com.arflix.tv.BuildConfig
import com.arflix.tv.data.repository.AuthRepository
import com.arflix.tv.util.Constants
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Optional, non-blocking, 12-hour inventory heartbeat for self-hosted private installations. */
@Singleton
class DeviceHeartbeatReporter @Inject constructor(
    @ApplicationContext private val context: Context,
    private val authRepository: AuthRepository,
    private val okHttpClient: OkHttpClient
) {
    private val lock = Mutex()
    suspend fun reportIfDue(): Unit = withContext(Dispatchers.IO) {
        if (BuildConfig.APPLICATION_ID != "com.arvio.tv.private" || !Constants.USE_NETLIFY_CLOUD_SYNC ||
            !Constants.NETLIFY_BACKEND_URL.startsWith("https://")) return@withContext
        lock.withLock {
            val preferences = context.getSharedPreferences("arvio_private_inventory", Context.MODE_PRIVATE)
            val now = System.currentTimeMillis()
            val accountId = authRepository.getCurrentUserIdForSync() ?: return@withLock
            if (accountId == preferences.getString("last_account_id", null) &&
                now - preferences.getLong("last_sent",0) < 12L * 60L * 60L * 1000L) return@withLock
            val token = authRepository.getAccessToken()?.takeIf { it.isNotBlank() } ?: return@withLock
            val id = preferences.getString("installation_id",null) ?: UUID.randomUUID().toString().also {
                preferences.edit().putString("installation_id",it).apply()
            }
            val data = JSONObject().apply {
                put("installationId",id)
                put("packageName",BuildConfig.APPLICATION_ID)
                put("deviceName",listOf(Build.MANUFACTURER,Build.MODEL).filterNotNull().joinToString(" ").take(100))
                put("manufacturer",Build.MANUFACTURER ?: "")
                put("model",Build.MODEL ?: "")
                put("androidRelease",Build.VERSION.RELEASE ?: "")
                put("androidSdk",Build.VERSION.SDK_INT)
                put("versionName",BuildConfig.VERSION_NAME)
                put("versionCode",BuildConfig.VERSION_CODE)
            }
            runCatching {
                val request = Request.Builder().url("${Constants.NETLIFY_BACKEND_URL}/device-heartbeat")
                    .header("Authorization","Bearer $token")
                    .post(data.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                okHttpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) preferences.edit().putLong("last_sent", now).putString("last_account_id", accountId).apply()
                }
            } // Inventory must never block playback or login.
        }
        Unit
    }
}

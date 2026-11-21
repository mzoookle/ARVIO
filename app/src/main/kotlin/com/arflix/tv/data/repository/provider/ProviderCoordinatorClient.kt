package com.arflix.tv.data.repository.provider

import com.arflix.tv.data.repository.AuthRepository
import com.arflix.tv.data.repository.ProfileManager
import com.arflix.tv.util.Constants
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

class ProviderCoordinatorException(val status: Int, val reason: String, val retryAfter: Long? = null) : IOException(
    when (reason) {
        "connection_required" -> "Connect this provider in ARVIO Settings."
        "reconnect_required" -> "Reconnect this provider in ARVIO Settings."
        "provider_coordinator_unavailable" -> "The provider service is temporarily unavailable. Please try again."
        else -> "Provider request failed ($reason)."
    }
)

data class ProviderCoordinatorResult(val data: JsonElement, val headers: Map<String, String>, val status: Int)

/** All SIMKL and WeTrakr grants remain on the ARVIO server; this client sends only ARVIO auth. */
@Singleton
class ProviderCoordinatorClient @Inject constructor(
    private val authRepository: AuthRepository,
    private val profiles: ProfileManager
) {
    private val gson = Gson()
    private val http = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(35, TimeUnit.SECONDS)
        .build()

    suspend fun action(provider: String, action: String, profileId: String = profiles.getProfileIdSync()): JsonObject =
        call(provider, action, profileId).data.asJsonObject

    suspend fun request(
        provider: String,
        path: String,
        method: String = "GET",
        body: Any? = null,
        profileId: String = profiles.getProfileIdSync()
    ): ProviderCoordinatorResult {
        val jsonBody = body?.let { JsonParser.parseString(gson.toJson(it)) }
        return call(provider, "request", profileId, mapOf(
            "path" to path,
            "method" to method.uppercase(),
            "body" to jsonBody
        ), allowHttpErrors = true)
    }

    suspend fun status(provider: String, profileId: String = profiles.getProfileIdSync()): JsonObject =
        action(provider, "status", profileId)

    private suspend fun call(
        provider: String,
        action: String,
        profileId: String,
        extra: Map<String, Any?> = emptyMap(),
        allowHttpErrors: Boolean = false
    ): ProviderCoordinatorResult = withContext(Dispatchers.IO) {
        if (!Constants.USE_NETLIFY_CLOUD_SYNC) throw ProviderCoordinatorException(503, "cloud_sync_unavailable")
        val token = authRepository.getAccessToken()?.takeIf { it.isNotBlank() }
            ?: throw ProviderCoordinatorException(401, "arvio_session_required")
        val payload = linkedMapOf<String, Any?>(
            "provider" to provider.lowercase(),
            "action" to action.lowercase(),
            "profileId" to profileId
        ).apply { putAll(extra) }
        val request = Request.Builder()
            .url("${Constants.NETLIFY_BACKEND_URL}/provider-coordinator")
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .post(gson.toJson(payload).toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val parsed = runCatching { JsonParser.parseString(raw) }.getOrNull()
                ?: JsonObject().apply { addProperty("error", "invalid_coordinator_response") }
            val headers = response.headers.names().associate { it.lowercase() to response.header(it).orEmpty() }
            if (!response.isSuccessful && !allowHttpErrors) {
                val error = parsed.takeIf { it.isJsonObject }?.asJsonObject?.get("error")?.asString ?: "request_failed"
                throw ProviderCoordinatorException(response.code, error, headers["retry-after"]?.toLongOrNull())
            }
            ProviderCoordinatorResult(parsed, headers, response.code)
        }
    }

    /** Blocking bridge for Retrofit's synchronous OkHttp interceptor. */
    fun executeProviderRequestBlocking(original: okhttp3.Request): okhttp3.Response =
        kotlinx.coroutines.runBlocking {
            val url = original.url
            val path = buildString {
                append(url.encodedPath)
                url.encodedQuery?.let { append('?').append(it) }
            }
            val rawBody = original.body?.let { body ->
                val buffer = okio.Buffer()
                body.writeTo(buffer)
                buffer.readUtf8().takeIf { it.isNotBlank() }?.let { runCatching { JsonParser.parseString(it) }.getOrNull() }
            }
            val result = call("simkl", "request", profiles.getProfileIdSync(), mapOf(
                "path" to path,
                "method" to original.method,
                "body" to rawBody
            ), allowHttpErrors = true)
            val contentType = "application/json; charset=utf-8".toMediaType()
            val responseHeaders = okhttp3.Headers.Builder()
                .add("content-type", "application/json; charset=utf-8")
                .add("cache-control", "private, no-store")
            listOf("retry-after", "x-pagination-page-count", "x-pagination-page", "x-pagination-limit", "x-pagination-item-count")
                .forEach { name -> result.headers[name]?.let { responseHeaders.add(name, it) } }
            okhttp3.Response.Builder()
                .request(original)
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(if (result.status == 204 || result.status == 205) 200 else result.status)
                .message("Provider coordinator")
                .headers(responseHeaders.build())
                .body(gson.toJson(result.data).toResponseBody(contentType))
                .build()
        }
}

package com.arflix.tv.updater

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.arflix.tv.BuildConfig
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import javax.inject.Inject
import javax.inject.Singleton

/** Versioned public HTTPS manifest served by the operator, never the upstream vendor. */
private data class PrivateReleaseDto(
    @SerializedName("versionCode") val versionCode: Long?,
    @SerializedName("versionName") val versionName: String?,
    @SerializedName("title") val title: String?,
    @SerializedName("notes") val notes: String?,
    @SerializedName("apkUrl") val apkUrl: String?,
    @SerializedName("apkSizeBytes") val apkSizeBytes: Long?,
    @SerializedName("sha256") val sha256: String?,
    @SerializedName("packageName") val packageName: String?
)

@Singleton
class AppUpdateRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val okHttpClient: OkHttpClient
) {
    private val gson = Gson()

    fun isPlayStoreInstall(): Boolean = getInstallerPackageName() == "com.android.vending"

    fun supportsSelfUpdate(): Boolean =
        BuildConfig.SELF_UPDATE_ENABLED && !isPlayStoreInstall() &&
            BuildConfig.PRIVATE_UPDATE_MANIFEST_URL.startsWith("https://")

    fun getInstalledVersionName(): String = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        info.versionName ?: BuildConfig.VERSION_NAME
    } catch (_: Exception) {
        BuildConfig.VERSION_NAME
    }

    fun isNewer(update: AppUpdate): Boolean =
        if (update.versionCode != null) update.versionCode > BuildConfig.VERSION_CODE.toLong()
        else VersionUtils.isRemoteNewer(update.tag, getInstalledVersionName())

    suspend fun getLatestUpdate(): Result<AppUpdate> = withContext(Dispatchers.IO) {
        runCatching {
            check(supportsSelfUpdate()) { "The private update endpoint is not configured or this is a Play installation" }
            val manifestUrl = BuildConfig.PRIVATE_UPDATE_MANIFEST_URL.toHttpUrlOrNull()
                ?: error("Invalid private release manifest URL")
            require(manifestUrl.isHttps) { "The update manifest must use HTTPS" }
            val request = Request.Builder()
                .url(manifestUrl)
                .header("Accept", "application/json")
                .header("User-Agent", "ARVIO-Private/${BuildConfig.VERSION_NAME}")
                .build()
            okHttpClient.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Private update server returned HTTP ${response.code}" }
                // Do not accept a redirected manifest from an untrusted host.
                require(response.request.url.isHttps && response.request.url.host == manifestUrl.host) {
                    "Update manifest redirected outside the trusted HTTPS host"
                }
                val body = response.body ?: error("Empty private update manifest")
                require(body.contentLength() <= 128 * 1024L) { "Release manifest is too large" }
                val json = body.byteStream().use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(4096)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(out.size() + count <= 128 * 1024) { "Release manifest is too large" }
                        out.write(buffer, 0, count)
                    }
                    out.toString("UTF-8")
                }
                val dto = gson.fromJson(json, PrivateReleaseDto::class.java)
                    ?: error("Invalid private update manifest")
                val version = dto.versionName?.takeIf { it.isNotBlank() }
                    ?: error("Missing versionName")
                val code = dto.versionCode?.takeIf { it > 0L }
                    ?: error("Missing positive versionCode")
                require(dto.packageName == context.packageName) { "Release targets a different Android package" }
                val sha = dto.sha256?.lowercase()?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
                    ?: error("Missing or invalid APK SHA-256")
                val url = dto.apkUrl?.toHttpUrlOrNull() ?: error("Invalid APK URL")
                require(url.isHttps && url.host == manifestUrl.host) {
                    "APK must be hosted over HTTPS on the manifest host"
                }
                require(url.encodedPath.endsWith(".apk")) { "Release asset must be an APK" }
                AppUpdate(
                    tag = version,
                    title = dto.title?.takeIf { it.isNotBlank() } ?: version,
                    notes = dto.notes.orEmpty(),
                    releaseUrl = null,
                    assetName = url.pathSegments.last(),
                    assetUrl = url.toString(),
                    assetSizeBytes = dto.apkSizeBytes?.takeIf { it > 0L },
                    versionCode = code,
                    sha256 = sha
                )
            }
        }
    }

    private fun getInstallerPackageName(): String? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getInstallerPackageName(context.packageName)
        }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: Exception) {
        null
    }
}

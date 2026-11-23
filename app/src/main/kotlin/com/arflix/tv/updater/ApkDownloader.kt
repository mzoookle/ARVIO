package com.arflix.tv.updater

import android.content.Context
import com.arflix.tv.R
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ApkDownloader @Inject constructor(
    @ApplicationContext private val context: Context,
    private val okHttpClient: OkHttpClient
) {
    suspend fun download(
        url: String,
        destinationFile: File,
        expectedSha256: String? = null,
        onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit
    ): Result<File> {
        return runCatching {
            destinationFile.parentFile?.mkdirs()
            // Never leave a partially downloaded APK available to the package installer.
            val part = File(destinationFile.parentFile, destinationFile.name + ".part")
            if (part.exists()) part.delete()
            require(expectedSha256 != null && expectedSha256.matches(Regex("[a-fA-F0-9]{64}"))) {
                "A signed release manifest with a SHA-256 checksum is required"
            }
            try {

            // Use a dedicated client with longer timeouts for large APK downloads
            val downloadClient = okHttpClient.newBuilder()
                .connectTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
                .build()

            val apkUrl = url.toHttpUrlOrNull() ?: error("Invalid release APK URL")
            require(apkUrl.isHttps) { "APK downloads must use HTTPS" }
            val request = Request.Builder().url(apkUrl).build()
            downloadClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    error(context.getString(R.string.update_error_download_http, response.code))
                }

                require(response.request.url.isHttps && response.request.url.host == apkUrl.host) {
                    "APK redirected outside the trusted HTTPS host"
                }
                val body = response.body ?: error(context.getString(R.string.update_error_empty_download_body))
                val total = body.contentLength().takeIf { it > 0L }
                require(total == null || total <= 1024L * 1024 * 1024) { "APK exceeds 1 GiB" }
                val sha256 = MessageDigest.getInstance("SHA-256")
                body.byteStream().use { input ->
                    FileOutputStream(part).use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        var downloaded = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            if (read == 0) continue
                            downloaded += read
                            require(downloaded <= 1024L * 1024 * 1024) { "APK exceeds 1 GiB" }
                            output.write(buffer, 0, read)
                            sha256.update(buffer, 0, read)
                            onProgress(downloaded, total)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                }
                require(total == null || part.length() == total) { "APK download incomplete" }
                val actual = sha256.digest().joinToString("") { "%02x".format(it) }
                require(actual.equals(expectedSha256, ignoreCase = true)) { "APK SHA-256 mismatch" }
            }
            if (destinationFile.exists()) require(destinationFile.delete()) { "Cannot replace cached APK" }
            require(part.renameTo(destinationFile)) { "Cannot finalize APK download" }
            destinationFile
            } finally {
                part.delete()
            }
        }
    }
}

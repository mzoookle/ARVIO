package com.arflix.tv.updater

data class AppUpdate(
    val tag: String,
    val title: String,
    val notes: String,
    val releaseUrl: String?,
    val assetName: String,
    val assetUrl: String,
    val assetSizeBytes: Long?,
    // Non-null for self-hosted releases. Unlike a version name, versionCode is monotonic.
    val versionCode: Long? = null,
    val sha256: String? = null
)

package com.arflix.tv.player

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.datastore.preferences.core.booleanPreferencesKey

/**
 * Device-local workaround for vendor audio effect / playback-clock problems.
 * Never sync this setting to other profiles or devices: audio hardware differs.
 */
object AudioEffectCompatibility {
    val PREF_KEY = booleanPreferencesKey("device_audio_effect_compatibility_enabled")

    /** Default ON for Sony Android TV / BRAVIA, OFF on other hardware. */
    fun defaultEnabled(context: Context): Boolean {
        val sony = Build.MANUFACTURER.startsWith("sony", ignoreCase = true) ||
            Build.BRAND.startsWith("sony", ignoreCase = true) ||
            Build.MODEL.contains("bravia", ignoreCase = true)
        val tv = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEVISION)
        return sony && tv
    }
}

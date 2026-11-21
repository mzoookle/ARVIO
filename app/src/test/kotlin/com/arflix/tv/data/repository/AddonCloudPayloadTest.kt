package com.arflix.tv.data.repository

import com.google.gson.Gson
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class AddonCloudPayloadTest {
    private val gson = Gson()

    @Test fun `web-only record becomes usable Android addon`() {
        val raw = JSONObject().apply {
            put("id", "test-addon")
            put("name", "Web Addon")
            put("version", "1.2.3")
            put("manifestUrl", "https://addons.example.test/p/config/manifest.json")
            put("enabled", false)
            put("resources", JSONArray().put("stream").put("catalog"))
            put("catalogs", JSONArray().put(JSONObject().put("id", "films").put("type", "movie")))
        }
        val parsed = decodeCloudAddon(raw, gson)!!
        assertEquals("https://addons.example.test/p/config/manifest.json", parsed.url)
        assertFalse(parsed.isEnabled)
        assertEquals("CUSTOM", parsed.type.name)
        assertEquals(listOf("stream", "catalog"), parsed.manifest!!.resources.map { it.name })
        assertEquals("films", parsed.manifest!!.catalogs.single().id)
    }

    @Test fun `single malformed addon does not discard valid neighbor`() {
        val records = JSONArray().put(JSONObject().put("name", "Invalid no id"))
            .put(JSONObject().put("id", "good").put("name", "Good")
                .put("manifestUrl", "https://addons.example.test/manifest.json"))
        val decoded = decodeCloudAddonArray(records, gson)
        assertEquals(1, decoded.rejected)
        assertEquals(listOf("good"), decoded.addons.map { it.id })
    }

    @Test fun `android manifest and configured URL survive web import`() {
        val raw = JSONObject().put("id", "configured").put("name", "Configured")
            .put("version", "3").put("type", "CUSTOM").put("isInstalled", true)
            .put("isEnabled", true).put("url", "https://addons.example.test/key/manifest.json")
            .put("manifest", JSONObject().put("id", "configured").put("name", "Configured")
                .put("version", "3").put("resources", JSONArray().put(JSONObject().put("name", "stream"))))
        val parsed = decodeCloudAddon(raw, gson)!!
        assertTrue(parsed.isEnabled)
        assertEquals("https://addons.example.test/key/manifest.json", parsed.url)
        assertEquals("stream", parsed.manifest!!.resources.first().name)
    }
}

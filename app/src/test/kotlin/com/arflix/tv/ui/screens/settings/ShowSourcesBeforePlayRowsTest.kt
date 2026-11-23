package com.arflix.tv.ui.screens.settings

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
class ShowSourcesBeforePlayRowsTest {
    @Test
    fun `source picker toggle has a distinct TV playback row`() {
        val rows = tvGeneralRowsForSection("playback")
        assertEquals(1, rows.count { it == 62 })
        assertEquals(rows.indexOf(11) + 1, rows.indexOf(62))
        assertTrue(rows.indexOf(62) < rows.indexOf(12))
        val all = listOf("language", "subtitles", "ai_subtitles", "playback", "appearance", "profiles", "network")
            .flatMap(::tvGeneralRowsForSection)
        assertEquals(all.size, all.distinct().size)
    }
}

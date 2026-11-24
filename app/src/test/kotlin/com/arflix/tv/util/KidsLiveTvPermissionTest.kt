package com.arflix.tv.util

import com.arflix.tv.data.model.Profile
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KidsLiveTvPermissionTest {
    @Test fun `regular profiles retain Live TV access`() {
        assertTrue(Profile(name = "Adult").canOpenLiveTv)
    }

    @Test fun `legacy kids profiles cannot open Live TV`() {
        assertFalse(Profile(name = "Child", isKidsProfile = true).canOpenLiveTv)
        assertFalse(Profile(name = "Child", isKidsProfile = true, allowKidsLiveTv = null).canOpenLiveTv)
        assertFalse(Profile(name = "Child", isKidsProfile = true, allowKidsLiveTv = false).canOpenLiveTv)
    }

    @Test fun `parent can enable Live TV only for an opted-in kids profile`() {
        val child = Profile(name = "Child", isKidsProfile = true, allowKidsLiveTv = true)
        assertTrue(child.canOpenLiveTv)
        assertFalse(child.copy(allowKidsLiveTv = false).canOpenLiveTv)
        assertFalse(child.copy(allowKidsLiveTv = null).canOpenLiveTv)
    }
}

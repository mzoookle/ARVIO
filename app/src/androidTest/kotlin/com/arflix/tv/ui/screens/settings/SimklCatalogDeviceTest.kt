package com.arflix.tv.ui.screens.settings

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import coil.ImageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.arflix.tv.ArflixApplication
import com.arflix.tv.data.model.CatalogDiscoveryResult
import com.arflix.tv.data.model.CatalogSourceType
import com.arflix.tv.data.repository.provider.ProviderCoordinatorClient
import com.arflix.tv.data.repository.simkl.SimklListsRepository
import com.arflix.tv.util.DeviceType
import com.arflix.tv.util.LocalDeviceType
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Optional live coordinator tests. Unlike the retired device-token tests these
 * use the signed-in ARVIO account and never read/write local SIMKL grants.
 *
 * simklLive=true: read-only list and UI check; SIMKL must already be connected.
 * simklDeviceAuth=true: manual PIN flow; changes the current account's connection.
 */
@RunWith(AndroidJUnit4::class)
class SimklCatalogDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun liveRepository(): SimklListsRepository {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as ArflixApplication
        val coordinator = ProviderCoordinatorClient(app.authRepository, app.profileManager)
        return SimklListsRepository(app.profileManager, coordinator)
    }

    @Test fun liveSimklListSearchRendersRealArtAndTvActions(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("simklLive") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val listsRepository = liveRepository()
        assertTrue("Sign into ARVIO and connect SIMKL in Settings before running the live test",
            listsRepository.refreshStatus(force = true))
        val list = listsRepository.load(14462, force = true)
        assertTrue("SIMKL list 14462 returned no items", list.items.isNotEmpty())
        assertTrue("SIMKL list search returned no matching results", listsRepository.search("mindfuck").isNotEmpty())

        val imageLoader = ImageLoader.Builder(context).build()
        try {
            val poster = list.items.firstOrNull { it.poster != null }?.poster
            assertNotNull("SIMKL list has no poster to test", poster)
            assertTrue(imageLoader.execute(ImageRequest.Builder(context).data(poster).size(180, 270).build()) is SuccessResult)
            val results = listOf(CatalogDiscoveryResult("simkl:${list.id}", list.name, list.description,
                CatalogSourceType.SIMKL, list.url, list.ownerName, list.ownerId?.toString(), list.updatedAt,
                list.count, list.likes, list.posters))
            var added: String? = null
            var submitted = false
            compose.setContent {
                CompositionLocalProvider(LocalDeviceType provides DeviceType.TV) {
                    CatalogDiscoveryModal("mindfuck", results, false, null, "https://simkl.com/5/list/14462",
                        emptySet(), {}, { submitted = true }, { added = it.sourceUrl }, {}, { submitted = true }, {},
                        simklConnected = true)
                }
            }
            compose.waitForIdle()
            compose.onAllNodesWithText("SIMKL", substring = false).onFirst().assertIsDisplayed()
            compose.onAllNodesWithText("Add", substring = false).onFirst().performClick()
            compose.runOnIdle { assertNotNull(added) }
            compose.onNodeWithText("Add URL").performClick()
            compose.runOnIdle { assertTrue(submitted) }
            val folder = File(context.getExternalFilesDir(null), "simkl-catalog-qa").apply { mkdirs() }
            File(folder, "simkl-catalog-search-tv.png").outputStream().use {
                compose.onNode(isDialog()).captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        } finally {
            imageLoader.shutdown()
        }
    }

    @Test fun mobileSimklConnectionAndListUrlControlsFit() {
        var connect = false
        compose.setContent {
            CompositionLocalProvider(LocalDeviceType provides DeviceType.PHONE) {
                CatalogDiscoveryModal("", emptyList(), false, null, "", emptySet(), {}, {}, {}, {}, {}, {},
                    onConnectSimkl = { connect = true })
            }
        }
        compose.onNodeWithText("Connect SIMKL").assertIsDisplayed().performClick()
        compose.runOnIdle { assertTrue(connect) }
        compose.onNodeWithText("Search Lists").assertIsDisplayed()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val folder = File(context.getExternalFilesDir(null), "simkl-catalog-qa").apply { mkdirs() }
        File(folder, "simkl-catalog-phone.png").outputStream().use {
            compose.onNode(isDialog()).captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun liveCoordinatorDeviceSignInPersistsServerConnection(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("simklDeviceAuth") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val repository = liveRepository()
        val session = repository.startDevice()
        assertEquals("server-managed", session.deviceCode)
        assertTrue(session.userCode.isNotBlank())
        val folder = File(context.getExternalFilesDir(null), "simkl-catalog-qa").apply { mkdirs() }
        val urlFile = File(folder, "device-auth-url.txt")
        urlFile.writeText(session.url)
        try {
            var connected = false
            repeat(48) {
                if (!connected) {
                    delay(session.interval.coerceAtLeast(5) * 1_000L)
                    connected = repository.poll(session, repository.profileId())
                }
            }
            assertTrue("Live coordinator PIN authorization timed out", connected)
            assertTrue(repository.refreshStatus(force = true))
            assertTrue(repository.isConnected())
            assertEquals(SimklListsRepository.COORDINATOR_CONNECTION, repository.connectionId())
        } finally {
            urlFile.delete()
            // Deliberately do NOT disconnect SIMKL; this test uses the real ARVIO account.
        }
    }
}

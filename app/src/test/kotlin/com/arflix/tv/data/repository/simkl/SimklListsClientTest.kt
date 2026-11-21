package com.arflix.tv.data.repository.simkl

import com.arflix.tv.data.api.SimklApi
import com.arflix.tv.data.api.SimklScrobbleBody
import com.arflix.tv.data.model.CatalogSourceType
import com.arflix.tv.data.repository.ProfileManager
import com.arflix.tv.data.repository.provider.ProviderCoordinatorClient
import com.arflix.tv.data.repository.provider.ProviderCoordinatorResult
import com.arflix.tv.util.CatalogUrlParser
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * SIMKL V2 now runs through ARVIO's private-cloud provider coordinator.
 * Tests deliberately avoid the retired on-device token/refresh/revoke API.
 */
class SimklListsClientTest {
    private val profileId = "coordinator-test-profile"

    @Test fun `SIMKL links accept real owner URLs and canonical numeric links only`() {
        for (url in listOf("https://simkl.com/5/list/14462/best-mindfucks-tv-shows/?sort=position", "simkl.com/lists/14462", "https://www.simkl.com/5/list/14462")) {
            assertEquals(14462L, CatalogUrlParser.parseSimkl(url)?.id)
            assertEquals(CatalogSourceType.SIMKL, CatalogUrlParser.detectSource(url))
        }
        for (url in listOf("https://simkl.com/5/tv/", "https://simkl.com/lists/official", "https://simkl.com/lists/0", "https://simkl.com.evil.test/5/list/14462", "https://evil.simkl.com/5/list/14462", "https://simkl.com@evil.test/5/list/14462")) {
            assertNull(url, CatalogUrlParser.parseSimkl(url))
        }
    }

    @Test fun `device authorization is initiated and polled by the coordinator`() = runTest {
        val coordinator = mockk<ProviderCoordinatorClient>()
        coEvery { coordinator.action("simkl", "start", profileId) } returns jsonObject(
            """{"userCode":"ABCD-EFGH","verificationUrl":"https://simkl.com/pin","expiresIn":900,"interval":5}"""
        )
        coEvery { coordinator.action("simkl", "poll", profileId) } returns jsonObject("""{"connected":true}""")
        val client = SimklListsClient(coordinator)
        val code = client.startDevice(profileId)
        assertEquals("ABCD-EFGH", code.userCode)
        assertEquals("https://simkl.com/pin", code.url)
        assertEquals("server-managed", code.deviceCode)
        assertEquals("server-managed", code.verifier)
        val grant = client.poll(code, profileId)
        assertEquals("server-managed", grant.connectionId)
        assertEquals("arvio-coordinator", grant.accessToken)
        coVerify(exactly = 1) { coordinator.action("simkl", "start", profileId) }
        coVerify(exactly = 1) { coordinator.action("simkl", "poll", profileId) }
    }

    @Test fun `pending device authorization stays pending`() = runTest {
        val coordinator = mockk<ProviderCoordinatorClient>()
        coEvery { coordinator.action("simkl", "poll", profileId) } returns jsonObject("""{"connected":false}""")
        val client = SimklListsClient(coordinator)
        val code = SimklListsDeviceCode("server-managed", "ABCD-EFGH", "https://simkl.com/pin", 900, 5, "server-managed")
        val error = runCatching { client.poll(code, profileId) }.exceptionOrNull() as SimklListsException
        assertEquals("authorization_pending", error.reason)
        assertEquals(400, error.status)
    }

    @Test fun `upstream premium auth privacy and rate errors never become empty success`() = runTest {
        for ((status, reason) in listOf(200 to "premium_only", 403 to "oauth2_token_required", 403 to "private_list", 404 to "url_failed", 401 to "user_token_required", 429 to "user_limit_exceeded")) {
            val (client, _) = withGet { providerResponse("""{"error":"$reason","item":{"title":"Upgrade"}}""", status) }
            val error = runCatching { client.list(14462, "not-a-secret", profileId) }.exceptionOrNull() as SimklListsException
            assertEquals(reason, error.reason)
            assertEquals(status, error.status)
        }
    }

    @Test fun `list pagination preserves owner order and maps movie TV and anime string IDs`() = runTest {
        val paths = mutableListOf<String>()
        val (client, coordinator) = withGet { path ->
            paths += path
            when {
                path.contains("page=1") -> providerResponse(list(
                    """{"title":"Dark","type":"tv","ids":{"tmdb":"70523","imdb":"tt5753856"}},{"title":"Perfect Blue","type":"anime","anime_type":"movie","ids":{"tmdb":10494}}""", 2))
                path.contains("page=2") -> providerResponse(list("""{"title":"Inception","type":"movie","ids":{"tmdb":"27205"}}""", 2))
                else -> error("Unexpected coordinator path: $path")
            }
        }
        val result = client.list(14462, "not-a-secret", profileId)
        assertEquals(listOf("Dark", "Perfect Blue", "Inception"), result.items.map { it.title })
        assertEquals(listOf(70523, 10494, 27205), result.items.map { it.tmdb })
        assertEquals("movie", result.items[1].animeType)
        assertEquals("https://simkl.com/5/list/14462", result.url)
        assertEquals(2, paths.size)
        assertTrue(paths[0].contains("page=1"))
        assertTrue(paths[1].contains("page=2"))
        assertTrue(paths.all { it.startsWith("/lists/14462?") && !it.contains("sort=") })
        coVerify(exactly = 2) { coordinator.request("simkl", any(), "GET", null, profileId) }
    }

    @Test fun `list index requests followed and shared lists and preserves preview posters`() = runTest {
        val paths = mutableListOf<String>()
        val (client, _) = withGet { path ->
            paths += path
            providerResponse("""{"pagination":{"total_pages":1},"lists":[{"id":14462,"name":"Mindfucks","media_type":"tv","user":{"id":5},"counts":{"items":333,"likes":123},"top_items":[{"poster":"63/6339166c5664ac055"}]}]}""")
        }
        val lists = client.userLists(5, "not-a-secret", profileId)
        assertEquals(333, lists.single().count)
        assertEquals("https://simkl.in/posters/63/6339166c5664ac055_m.webp", lists.single().posters.single())
        assertEquals(1, paths.size)
        assertTrue(paths.single().contains("followed=true"))
        assertTrue(paths.single().contains("collaborants=true"))
    }

    @Test fun `official discovery previews avoid fetching 22 page index`() = runTest {
        val paths = mutableListOf<String>()
        val (client, _) = withGet { path ->
            paths += path
            providerResponse("""{"pagination":{"total_pages":22},"lists":[{"id":14462,"name":"Mindfucks","media_type":"tv","user":{"id":5}}]}""")
        }
        assertEquals(1, client.officialLists("not-a-secret", profileId).size)
        assertEquals(2, paths.size)
        assertTrue(paths[0].contains("sort=updated"))
        assertTrue(paths[1].contains("sort=popularity"))
    }

    @Test fun `coordinator handles SIMKL identity lookup through POST`() = runTest {
        val coordinator = mockk<ProviderCoordinatorClient>()
        coEvery { coordinator.request("simkl", "/users/settings", "POST", any(), profileId) } returns
            providerResponse("""{"account":{"id":5}}""")
        assertEquals(5L, SimklListsClient(coordinator).userId("not-a-secret", profileId))
        coVerify(exactly = 1) { coordinator.request("simkl", "/users/settings", "POST", any(), profileId) }
    }

    @Test fun `disconnect is account owned and invalidates local connected status`() = runTest {
        val coordinator = mockk<ProviderCoordinatorClient>()
        val profile = mockk<ProfileManager>()
        every { profile.getProfileIdSync() } returns profileId
        coEvery { coordinator.status("simkl", profileId) } returns jsonObject("""{"connected":true}""")
        coEvery { coordinator.action("simkl", "disconnect", profileId) } returns jsonObject("""{"connected":false}""")
        val repository = SimklListsRepository(profile, coordinator)
        assertTrue(repository.refreshStatus(profileId, force = true))
        assertEquals(SimklListsRepository.COORDINATOR_TOKEN, repository.accessToken())
        repository.disconnect()
        assertFalse(repository.isConnected(profileId))
        assertNull(repository.connectionId())
        coVerify(exactly = 1) { coordinator.action("simkl", "disconnect", profileId) }
    }

    @Test fun `scrobble start and stop use the app 90 percent watched threshold but pause is unchanged`() = runTest {
        MockWebServer().use { server ->
            server.start()
            val api = Retrofit.Builder().baseUrl(server.url("/"))
                .addConverterFactory(GsonConverterFactory.create()).build().create(SimklApi::class.java)
            val body = SimklScrobbleBody(progress = 85f)
            repeat(3) { server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{}")) }
            api.scrobbleStart("Bearer test", "client", body)
            api.scrobbleStop("Bearer test", "client", body)
            api.scrobblePause("Bearer test", "client", body)
            assertEquals("90", server.takeRequest().requestUrl!!.queryParameter("min_progress"))
            assertEquals("90", server.takeRequest().requestUrl!!.queryParameter("min_progress"))
            assertNull(server.takeRequest().requestUrl!!.queryParameter("min_progress"))
        }
    }

    private fun providerResponse(json: String, status: Int = 200): ProviderCoordinatorResult =
        ProviderCoordinatorResult(JsonParser.parseString(json), emptyMap(), status)

    private fun jsonObject(json: String): JsonObject = JsonParser.parseString(json).asJsonObject

    private fun list(items: String, pages: Int) =
        """{"id":14462,"name":"Mindfucks","media_type":"tv","user":{"id":5},"counts":{"items":3},"pagination":{"total_pages":$pages},"items":[$items]}"""

    private fun withGet(respond: (String) -> ProviderCoordinatorResult): Pair<SimklListsClient, ProviderCoordinatorClient> {
        val coordinator = mockk<ProviderCoordinatorClient>()
        coEvery { coordinator.request("simkl", any(), "GET", null, profileId) } coAnswers {
            respond(secondArg())
        }
        return SimklListsClient(coordinator) to coordinator
    }
}

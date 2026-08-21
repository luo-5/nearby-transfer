package io.github.nearbytransfer.android.core.publication

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2PublicationRuntimeTest {
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTransferJobRepository

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = RoomTransferJobRepository(database)
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun verifiesPublicationPreconditionsAndRejectsPrematurePublish() {
        val taskId = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { 2.toByte() })
        val peerId = "0123456789abcdef"
        val manifestJson = "{\"type\":\"transfer-manifest\",\"totalFiles\":1,\"entries\":[" +
            "{\"sha256\":\"${"00".repeat(32)}\",\"size\":10,\"path\":\"file.bin\",\"kind\":\"file\"}]," +
            "\"conflictStrategy\":\"auto-rename\",\"taskId\":\"$taskId\",\"protocolVersion\":2," +
            "\"totalBytes\":10,\"app\":\"nearby-transfer\"}"

        runBlocking {
            repository.createIncoming(
                taskId = taskId,
                peerId = peerId,
                manifestJson = manifestJson,
                recoverable = true,
                nowEpochMillis = 100,
            )
            repository.transition(taskId, TransferJobState.QUEUED, 101)
            repository.transition(taskId, TransferJobState.TRANSFERRING, 102)
        }

        val runtime = V2PublicationRuntime(
            context = ApplicationProvider.getApplicationContext(),
            database = database,
            ownsDatabase = false,
        )
        try {
            // Cannot publish before transferredBytes == totalBytes (0 vs 10)
            assertThrows(IllegalArgumentException::class.java) {
                runtime.publish(taskId = taskId, nowEpochMillis = 102)
            }
        } finally {
            runtime.close()
        }
    }
}

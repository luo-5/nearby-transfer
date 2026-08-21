package io.github.nearbytransfer.android

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2ReceiveRuntimePersistenceTest {
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTransferJobRepository
    private lateinit var persistence: V2ReceiveRuntimePersistence

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = RoomTransferJobRepository(database)
        persistence = V2ReceiveRuntimePersistence(database, ownsDatabase = false)
    }

    @After
    fun tearDown() {
        persistence.close()
        database.close()
    }

    @Test
    fun loadsInitialCheckpointAndAdvancesMonotonically() {
        runBlocking {
            val taskId = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { 1.toByte() })
            val peerId = "0123456789abcdef"
            val manifestJson = "{\"type\":\"transfer-manifest\",\"totalFiles\":2,\"entries\":[" +
                "{\"sha256\":\"${"00".repeat(32)}\",\"size\":40,\"path\":\"file1.txt\",\"kind\":\"file\"}," +
                "{\"sha256\":\"${"00".repeat(32)}\",\"size\":60,\"path\":\"file2.txt\",\"kind\":\"file\"}]," +
                "\"conflictStrategy\":\"auto-rename\",\"taskId\":\"$taskId\",\"protocolVersion\":2," +
                "\"totalBytes\":100,\"app\":\"nearby-transfer\"}"

            repository.createIncoming(
                taskId = taskId,
                peerId = peerId,
                manifestJson = manifestJson,
                recoverable = true,
                nowEpochMillis = 100,
            )
            repository.transition(taskId, TransferJobState.QUEUED, 101)
            repository.transition(taskId, TransferJobState.TRANSFERRING, 102)

            val initial = persistence.loadCheckpoint(taskId)
            assertEquals(0L, initial.nextSequence)
            assertEquals(2, initial.files.size)
            assertEquals(0L, initial.files[0].committedOffset)
            assertEquals(false, initial.files[0].completed)

            // Advance progress
            val progressStore = persistence.asProgressStore(taskId) { 103 }
            val advanced = V2EncryptedChunkWriter.Progress(
                1,
                listOf(
                    V2EncryptedChunkWriter.FileProgress("file1.txt", 40, true),
                    V2EncryptedChunkWriter.FileProgress("file2.txt", 0, false),
                ),
            )
            progressStore.commit(advanced)

            val reloaded = persistence.loadCheckpoint(taskId)
            assertEquals(1L, reloaded.nextSequence)
            assertEquals(40L, reloaded.files[0].committedOffset)
            assertTrue(reloaded.files[0].completed)

            val job = persistence.find(taskId)
            assertNotNull(job)
            assertEquals(40L, job!!.transferredBytes)
        }
    }
}

package io.github.nearbytransfer.android

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.V2TransferPeerAccess
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.charset.StandardCharsets
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2IncomingTransferRuntimeTest {
    private val taskId = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { 3.toByte() })
    private val sessionId = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { 4.toByte() })
    private val senderId = "696d52f50efd19bf"
    private val receiverId = "428997b2c1f7c6ec"
    private val now = 1_760_000_001_000L

    private lateinit var context: Context
    private lateinit var localDevice: DeviceConfig
    private lateinit var authorizedPeer: V2TransferPeerAccess.AuthorizedPeer
    private lateinit var verifiedManifest: V2TransferBootstrap.VerifiedManifest
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTransferJobRepository

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()

        val senderSign = CryptoUtil.generateEd25519KeyPair()
        val senderEnc = CryptoUtil.generateX25519KeyPair()
        val receiverSign = CryptoUtil.generateEd25519KeyPair()
        val receiverEnc = CryptoUtil.generateX25519KeyPair()

        val senderSignPrivate = CryptoUtil.toPrivatePem(senderSign.private)
        val senderSignPublic = CryptoUtil.toPublicPem(senderSign.public)
        val receiverSignPrivate = CryptoUtil.toPrivatePem(receiverSign.private)
        val receiverSignPublic = CryptoUtil.toPublicPem(receiverSign.public)
        val receiverEncPrivate = CryptoUtil.toPrivatePem(receiverEnc.private)
        val receiverEncPublic = CryptoUtil.toPublicPem(receiverEnc.public)

        localDevice = DeviceConfig(
            receiverId,
            "Local Android Receiver",
            CryptoUtil.fingerprintFor(receiverSignPublic),
            receiverSignPublic,
            receiverSignPrivate,
            receiverEncPublic,
            receiverEncPrivate,
        )

        authorizedPeer = V2TransferPeerAccess.AuthorizedPeer(
            senderId,
            senderSignPublic,
            CryptoUtil.toPublicPem(senderEnc.public),
        )

        val file = JSONObject()
        file.put("kind", "file")
        file.put("path", "hello.txt")
        file.put("size", 12)
        file.put("sha256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

        val manifest = JSONObject()
        manifest.put("app", ProtocolV2.APP_ID)
        manifest.put("protocolVersion", ProtocolV2.VERSION)
        manifest.put("type", V2TransferMessage.TYPE_MANIFEST)
        manifest.put("taskId", taskId)
        manifest.put("conflictStrategy", "auto-rename")
        manifest.put("entries", JSONArray().put(file))
        manifest.put("totalFiles", 1)
        manifest.put("totalBytes", 12)

        val envelope = JSONObject()
        envelope.put("app", ProtocolV2.APP_ID)
        envelope.put("protocolVersion", ProtocolV2.VERSION)
        envelope.put("type", V2TransferMessage.TYPE_MANIFEST)
        envelope.put("manifest", manifest)
        envelope.put("sessionId", sessionId)
        envelope.put("senderDeviceId", senderId)
        envelope.put("receiverDeviceId", receiverId)
        envelope.put(
            "senderEphemeralPublicKey",
            V2TransferCrypto.encodeSenderEphemeralPublicKey(CryptoUtil.toPublicPem(senderEnc.public)),
        )
        envelope.put("issuedAt", now)
        envelope.put("expiresAt", now + 120_000L)

        val signed: JSONObject
        val frame: V2WireFrame.Frame
        try {
            signed = V2TransferMessageAuth.signedCopy(
                V2TransferMessage.TYPE_MANIFEST,
                envelope,
                senderSignPrivate,
            )
            val header = JSONObject()
            header.put("app", ProtocolV2.APP_ID)
            header.put("protocolVersion", ProtocolV2.VERSION)
            header.put("type", V2TransferMessage.TYPE_MANIFEST)
            frame = V2WireFrame.Frame(
                header,
                ProtocolV2.canonicalJson(signed).toByteArray(StandardCharsets.UTF_8),
            )

            verifiedManifest = V2TransferBootstrap.verifyIncomingManifestFrame(
                frame,
                senderSignPublic,
                receiverId,
                senderId,
                now,
            )
        } catch (e: Throwable) {
            System.err.println("SETUP_DEBUG_ERROR: ${e.javaClass.name}: ${e.message}")
            e.printStackTrace()
            throw e
        }

        database = NearbyTransferDatabase.build(context)
        repository = RoomTransferJobRepository(database)

        runBlocking {
            repository.createIncoming(
                taskId = taskId,
                peerId = senderId,
                manifestJson = manifest.toString(),
                recoverable = true,
                nowEpochMillis = now,
            )
            repository.transition(
                taskId = taskId,
                newState = TransferJobState.QUEUED,
                nowEpochMillis = now + 1,
                failureReason = null,
                recoverable = true,
            )
            repository.transition(
                taskId = taskId,
                newState = TransferJobState.TRANSFERRING,
                nowEpochMillis = now + 2,
                failureReason = null,
                recoverable = true,
            )
        }
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun preparesRuntimeAndCreatesValidResumeFrame() {
        try {
            val runtime = V2IncomingTransferRuntime.prepare(
                context,
                localDevice,
                verifiedManifest,
                authorizedPeer,
                null,
                null,
            )
            try {
                val resumeFrame = runtime.createResumeFrame()
                assertNotNull(resumeFrame)
                assertEquals("transfer-resume", resumeFrame.header.getString("type"))
                assertEquals(ProtocolV2.APP_ID, resumeFrame.header.getString("app"))
                assertEquals(ProtocolV2.VERSION, resumeFrame.header.getInt("protocolVersion"))
                val payloadJson = JSONObject(String(resumeFrame.payload, StandardCharsets.UTF_8))
                assertEquals(taskId, payloadJson.getString("taskId"))
                assertEquals(sessionId, payloadJson.getString("sessionId"))
                assertNotNull(payloadJson.getJSONArray("files"))
            } finally {
                runtime.close()
            }
        } catch (e: Throwable) {
            System.err.println("DEBUG_ERROR: ${e.javaClass.name}: ${e.message}")
            e.printStackTrace()
            throw e
        }
    }
}

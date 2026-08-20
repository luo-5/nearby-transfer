package io.github.nearbytransfer.android.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiveCheckpointCodecTest {
    private val taskId = "AQIDBAUGBwgJCgsMDQ4PEA"
    private val manifestHash = "da7f9108fa201f2ae381c3c9a2f722cbd4604f862f83572528b00eddfbb69160"

    @Test
    fun createsBoundCanonicalInitialCheckpoint() {
        val checkpoint = ReceiveCheckpointCodec.createInitial(manifest())

        assertEquals(taskId, checkpoint.taskId)
        assertEquals(manifestHash, checkpoint.manifestHash)
        assertEquals(0, checkpoint.nextSequence)
        assertEquals(0, checkpoint.transferredBytes)
        assertEquals(listOf("a.txt", "b.txt", "c.txt"), checkpoint.files.map { it.path })
        assertTrue(checkpoint.files.all { it.committedOffset == 0L && !it.completed })
        assertEquals(
            "{\"files\":[" +
                "{\"committedOffset\":0,\"completed\":false,\"path\":\"a.txt\"}," +
                "{\"committedOffset\":0,\"completed\":false,\"path\":\"b.txt\"}," +
                "{\"committedOffset\":0,\"completed\":false,\"path\":\"c.txt\"}" +
                "],\"formatVersion\":1,\"manifestHash\":\"$manifestHash\",\"nextSequence\":0," +
                "\"taskId\":\"$taskId\",\"transferredBytes\":0}",
            checkpoint.json,
        )
    }

    @Test
    fun normalizesFieldOrderAndRoundTripsStably() {
        val source = """
            {
              "transferredBytes":6,
              "taskId":"$taskId",
              "nextSequence":17,
              "manifestHash":"$manifestHash",
              "formatVersion":1,
              "files":[
                {"path":"a.txt","completed":true,"committedOffset":4},
                {"completed":false,"committedOffset":2,"path":"b.txt"},
                {"committedOffset":0,"path":"c.txt","completed":false}
              ]
            }
        """.trimIndent()

        val first = ReceiveCheckpointCodec.normalize(manifest(), source)
        val second = ReceiveCheckpointCodec.normalize(manifest(), first.json)

        assertEquals(6, first.transferredBytes)
        assertEquals(17, first.nextSequence)
        assertEquals(first, second)
        assertEquals(first.json, second.json)
        assertEquals(
            "{\"files\":[" +
                "{\"committedOffset\":4,\"completed\":true,\"path\":\"a.txt\"}," +
                "{\"committedOffset\":2,\"completed\":false,\"path\":\"b.txt\"}," +
                "{\"committedOffset\":0,\"completed\":false,\"path\":\"c.txt\"}" +
                "],\"formatVersion\":1,\"manifestHash\":\"$manifestHash\",\"nextSequence\":17," +
                "\"taskId\":\"$taskId\",\"transferredBytes\":6}",
            first.json,
        )
    }

    @Test
    fun buildsCanonicalCheckpointFromTypedReceiverProgress() {
        val checkpoint = ReceiveCheckpointCodec.fromProgress(
            manifestJson = manifest(),
            files = listOf(
                ReceiveCheckpointCodec.FileCheckpoint("a.txt", 4, true),
                ReceiveCheckpointCodec.FileCheckpoint("b.txt", 2, false),
                ReceiveCheckpointCodec.FileCheckpoint("c.txt", 0, false),
            ),
            nextSequence = 7,
        )

        assertEquals(6, checkpoint.transferredBytes)
        assertEquals(7, checkpoint.nextSequence)
        assertEquals(checkpoint, ReceiveCheckpointCodec.normalize(manifest(), checkpoint.json))

        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.fromProgress(
                manifestJson = manifest(),
                files = listOf(
                    ReceiveCheckpointCodec.FileCheckpoint("a.txt", 2, false),
                    ReceiveCheckpointCodec.FileCheckpoint("b.txt", 1, false),
                    ReceiveCheckpointCodec.FileCheckpoint("c.txt", 0, false),
                ),
                nextSequence = 8,
            )
        }
    }

    @Test
    fun acceptsCompletedPrefixAndOneCurrentPartialFile() {
        ReceiveCheckpointCodec.normalize(
            manifest(),
            checkpoint(
                files = listOf(file("a.txt", 4, true), file("b.txt", 3, true), file("c.txt", 1, false)),
                nextSequence = "9",
                transferredBytes = "8",
            ),
        )
        val completed = ReceiveCheckpointCodec.normalize(
            manifest(),
            checkpoint(
                files = listOf(file("a.txt", 4, true), file("b.txt", 3, true), file("c.txt", 2, true)),
                nextSequence = "10",
                transferredBytes = "9",
            ),
        )
        assertTrue(completed.files.all { it.completed })
    }

    @Test
    fun rejectsInvalidCompletionAndFileProgressShapes() {
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 3, true), file("b.txt", 0, false), file("c.txt", 0, false)),
                transferredBytes = "3",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 4, false), file("b.txt", 0, false), file("c.txt", 0, false)),
                transferredBytes = "4",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 2, false), file("b.txt", 1, false), file("c.txt", 0, false)),
                transferredBytes = "3",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 0, false), file("b.txt", 1, false), file("c.txt", 0, false)),
                transferredBytes = "1",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 2, false), file("b.txt", 3, true), file("c.txt", 0, false)),
                transferredBytes = "5",
            ),
        )
    }

    @Test
    fun rejectsOffsetBoundsAndTransferredByteMismatch() {
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 5, true), file("b.txt", 0, false), file("c.txt", 0, false)),
                transferredBytes = "5",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 4, true), file("b.txt", 1, false), file("c.txt", 0, false)),
                transferredBytes = "4",
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", -1, false), file("b.txt", 0, false), file("c.txt", 0, false)),
                transferredBytes = "0",
            ),
        )
    }

    @Test
    fun rejectsStringDecimalPseudoIntegerAndOverflowNumbers() {
        val validFiles = listOf(file("a.txt", 0, false), file("b.txt", 0, false), file("c.txt", 0, false))
        assertInvalid(checkpoint(validFiles, nextSequence = "\"1\""))
        assertInvalid(checkpoint(validFiles, nextSequence = "1.0"))
        assertInvalid(checkpoint(validFiles, nextSequence = "1.000000000000000000000000000000"))
        assertInvalid(checkpoint(validFiles, nextSequence = "9007199254740992"))
        assertInvalid(checkpoint(validFiles, nextSequence = "9223372036854775808"))
        assertInvalid(
            checkpoint(
                listOf(fileRaw("a.txt", "1.0", false), file("b.txt", 0, false), file("c.txt", 0, false)),
                transferredBytes = "1",
            ),
        )
        assertInvalid(checkpoint(validFiles, transferredBytes = "0.0"))
    }

    @Test
    fun enforcesProtocolSequenceBoundary() {
        val initial = ReceiveCheckpointCodec.createInitial(manifest(), 9_007_199_254_740_991L)
        assertEquals(9_007_199_254_740_991L, initial.nextSequence)
        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.createInitial(manifest(), -1)
        }
    }

    @Test
    fun rejectsExtraMissingAndWrongTypedFields() {
        val files = listOf(file("a.txt", 0, false), file("b.txt", 0, false), file("c.txt", 0, false))
        assertInvalid(checkpoint(files).dropLast(1) + ",\"extra\":true}")
        assertInvalid(checkpoint(files).replace("\"path\":\"a.txt\"", "\"path\":\"a.txt\",\"size\":4"))
        assertInvalid(checkpoint(files).replace("\"completed\":false", "\"completed\":0"))
        assertInvalid(checkpoint(files).replace("\"formatVersion\":1,", ""))
        assertInvalid(checkpoint(files).replace("\"files\":[", "\"files\":{} , \"unused\":["))
    }

    @Test
    fun rejectsWrongCountOrderDuplicateCollisionAndUnsafePaths() {
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 0, false), file("b.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("b.txt", 0, false), file("a.txt", 0, false), file("c.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 0, false), file("a.txt", 0, false), file("c.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 0, false), file("A.TXT", 0, false), file("c.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("../a.txt", 0, false), file("b.txt", 0, false), file("c.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("CON", 0, false), file("b.txt", 0, false), file("c.txt", 0, false)),
            ),
        )
    }

    @Test
    fun rejectsMalformedUnicodeInCheckpointPath() {
        val malformed = "\uD800"
        assertFalse(malformed.toByteArray().isEmpty())
        assertInvalid(
            checkpoint(
                listOf(file(malformed, 0, false), file("b.txt", 0, false), file("c.txt", 0, false)),
            ),
        )
        assertInvalid(
            checkpoint(
                listOf(file("a.txt", 0, false), file("b.txt", 0, false), file("c.txt", 0, false)),
            ).replace("\"a.txt\"", "\"\\ud800\""),
        )
    }

    @Test
    fun bindsTaskAndCanonicalManifestHashIncludingFileSizes() {
        val initial = ReceiveCheckpointCodec.createInitial(manifest())
        assertInvalid(initial.json.replace(taskId, "AgMEBQYHCAkKCwwNDg8QEQ"))
        assertInvalid(initial.json.replace(manifestHash, "A".repeat(64)))

        val resizedManifest = manifest().replace("\"size\":4", "\"size\":3").replace("\"totalBytes\":9", "\"totalBytes\":8")
        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.normalize(resizedManifest, initial.json)
        }
    }

    @Test
    fun advanceRejectsCrossFileRollbackEvenWhenAggregateCouldAppearNewer() {
        val previous = checkpoint(
            files = listOf(file("a.txt", 4, true), file("b.txt", 2, false), file("c.txt", 0, false)),
            nextSequence = "20",
            transferredBytes = "6",
        )
        val staleAAfterB = checkpoint(
            files = listOf(file("a.txt", 3, false), file("b.txt", 3, true), file("c.txt", 1, false)),
            nextSequence = "21",
            transferredBytes = "7",
        )

        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.advance(manifest(), previous, staleAAfterB)
        }

        val before = ReceiveCheckpointCodec.normalize(manifest(), previous)
        val interleaved = ReceiveCheckpointCodec.NormalizedCheckpoint(
            taskId = before.taskId,
            manifestHash = before.manifestHash,
            files = listOf(
                ReceiveCheckpointCodec.FileCheckpoint("a.txt", 3, false),
                ReceiveCheckpointCodec.FileCheckpoint("b.txt", 3, true),
                ReceiveCheckpointCodec.FileCheckpoint("c.txt", 1, false),
            ),
            nextSequence = 21,
            transferredBytes = 7,
            json = staleAAfterB,
        )
        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.requireMonotonic(before, interleaved)
        }
    }

    @Test
    fun advanceAllowsForwardMovementAndRejectsSequenceOrTotalRegression() {
        val previous = checkpoint(
            files = listOf(file("a.txt", 4, true), file("b.txt", 1, false), file("c.txt", 0, false)),
            nextSequence = "8",
            transferredBytes = "5",
        )
        val forward = checkpoint(
            files = listOf(file("a.txt", 4, true), file("b.txt", 3, true), file("c.txt", 1, false)),
            nextSequence = "10",
            transferredBytes = "8",
        )
        val advanced = ReceiveCheckpointCodec.advance(manifest(), previous, forward)
        assertEquals(8, advanced.transferredBytes)

        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.advance(manifest(), previous, forward.replace("\"nextSequence\":10", "\"nextSequence\":7"))
        }

        val parsedPrevious = ReceiveCheckpointCodec.normalize(manifest(), previous)
        val forgedLowerTotal = ReceiveCheckpointCodec.NormalizedCheckpoint(
            taskId = parsedPrevious.taskId,
            manifestHash = parsedPrevious.manifestHash,
            files = parsedPrevious.files,
            nextSequence = parsedPrevious.nextSequence,
            transferredBytes = parsedPrevious.transferredBytes - 1,
            json = parsedPrevious.json,
        )
        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.requireMonotonic(parsedPrevious, forgedLowerTotal)
        }
    }

    private fun assertInvalid(json: String) {
        assertThrows(IllegalArgumentException::class.java) {
            ReceiveCheckpointCodec.normalize(manifest(), json)
        }
    }

    private fun checkpoint(
        files: List<String>,
        nextSequence: String = "0",
        transferredBytes: String = "0",
    ): String = "{" +
        "\"files\":[${files.joinToString(",")}]," +
        "\"formatVersion\":1," +
        "\"manifestHash\":\"$manifestHash\"," +
        "\"nextSequence\":$nextSequence," +
        "\"taskId\":\"$taskId\"," +
        "\"transferredBytes\":$transferredBytes}"

    private fun file(path: String, committedOffset: Long, completed: Boolean): String =
        fileRaw(path, committedOffset.toString(), completed)

    private fun fileRaw(path: String, committedOffset: String, completed: Boolean): String =
        "{\"committedOffset\":$committedOffset,\"completed\":$completed,\"path\":${quote(path)}}"

    private fun quote(value: String): String = buildString {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                else -> append(character)
            }
        }
        append('"')
    }

    private fun manifest(): String = """
        {
          "totalBytes":9,
          "entries":[
            {"sha256":"${"c".repeat(64)}","size":2,"path":"c.txt","kind":"file"},
            {"kind":"file","path":"a.txt","size":4,"sha256":"${"a".repeat(64)}"},
            {"path":"b.txt","kind":"file","sha256":"${"b".repeat(64)}","size":3}
          ],
          "app":"nearby-transfer",
          "type":"transfer-manifest",
          "totalFiles":3,
          "taskId":"$taskId",
          "protocolVersion":2,
          "conflictStrategy":"auto-rename"
        }
    """.trimIndent()
}

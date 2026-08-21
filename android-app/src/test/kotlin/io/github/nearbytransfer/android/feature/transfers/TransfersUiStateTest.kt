package io.github.nearbytransfer.android.feature.transfers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TransfersUiStateTest {
    @Test
    fun formatsByteSizesAccurately() {
        assertEquals("500 B", SelectedFileItem.formatBytes(500L))
        assertEquals("1.5 KB", SelectedFileItem.formatBytes(1536L))
        assertEquals("10.0 MB", SelectedFileItem.formatBytes(10L * 1024L * 1024L))
        assertEquals("2.50 GB", SelectedFileItem.formatBytes((2.5 * 1024.0 * 1024.0 * 1024.0).toLong()))
    }

    @Test
    fun activeTransferItemCalculatesProgressFractionAndPercentage() {
        val transfer = ActiveTransferItem(
            taskId = "task-abc",
            title = "document.pdf",
            peerName = "Laptop",
            currentBytes = 500L,
            totalBytes = 1000L,
            status = TransferUiStatus.TRANSFERRING,
            speedBytesPerSec = 1024L,
        )

        assertEquals(0.5f, transfer.progressFraction, 0.001f)
        assertEquals(50, transfer.percentage)
        assertEquals("500 B / 1000 B", transfer.formattedProgress)
    }

    @Test
    fun transfersUiStateDefaultsAreSane() {
        val state = TransfersUiState()
        assertNull(state.selectedFile)
        assertNull(state.activeTransfer)
        assertTrue(state.transferHistory.isEmpty())
        assertEquals(false, state.isTransferring)
    }
}

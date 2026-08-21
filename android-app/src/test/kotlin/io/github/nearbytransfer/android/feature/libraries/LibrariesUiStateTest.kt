package io.github.nearbytransfer.android.feature.libraries

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LibrariesUiStateTest {
    @Test
    fun defaultStateHasSensibleDefaults() {
        val state = LibrariesUiState()
        assertNull(state.connectedPeerName)
        assertTrue(state.shares.isEmpty())
        assertNull(state.selectedShareId)
        assertEquals("/", state.currentPath)
        assertTrue(state.items.isEmpty())
        assertFalse(state.isBusy)
        assertFalse(state.isUploadPermitted)
    }

    @Test
    fun resolvesCurrentShareById() {
        val share1 = LibraryShare("share-1", "Photos", isReadOnly = true)
        val share2 = LibraryShare("share-2", "Documents", isReadOnly = false)
        val state = LibrariesUiState(
            shares = listOf(share1, share2),
            selectedShareId = "share-2",
        )

        val current = state.currentShare
        assertNotNull(current)
        assertEquals("Documents", current?.name)
        assertFalse(current?.isReadOnly ?: true)
    }

    @Test
    fun libraryItemFormatsSizeCorrectly() {
        val dir = LibraryItem(
            name = "MyFolder",
            path = "/docs/MyFolder",
            isDirectory = true,
            sizeBytes = 0L,
        )
        assertEquals("", dir.formattedSize)

        val file = LibraryItem(
            name = "report.pdf",
            path = "/docs/report.pdf",
            isDirectory = false,
            sizeBytes = 2048L,
        )
        assertEquals("2.0 KB", file.formattedSize)
    }
}

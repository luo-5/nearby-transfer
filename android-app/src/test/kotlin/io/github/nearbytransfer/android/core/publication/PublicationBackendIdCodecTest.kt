package io.github.nearbytransfer.android.core.publication

import io.github.nearbytransfer.android.core.data.PublicationBackend
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class PublicationBackendIdCodecTest {
    @Test
    fun mediaStoreLegacyNameAndCanonicalIdResolveToTheRuntimeBackendId() {
        val expected = MediaStorePublicationBackend.BACKEND_ID
        assertEquals(expected, PublicationBackendIdCodec.backendIdFor(PublicationBackend.MEDIA_STORE, null))
        assertEquals(PublicationBackend.MEDIA_STORE, PublicationBackendIdCodec.publicationBackendFor("MEDIA_STORE", null))
        assertEquals(PublicationBackend.MEDIA_STORE, PublicationBackendIdCodec.publicationBackendFor(expected, null))
        assertEquals(expected, PublicationBackendIdCodec.canonicalBackendId("MEDIA_STORE", null))
        assertEquals(expected, PublicationBackendIdCodec.canonicalBackendId(expected, null))
        assertTrue(PublicationBackendIdCodec.backendIdsMatch("MEDIA_STORE", expected, null))
        assertTrue(PublicationBackendIdCodec.backendIdsMatch(expected, expected, null))
    }

    @Test
    fun safTreeCanonicalizationDependsOnThePublicationRootToken() {
        val publicationRootToken = "content://provider/tree/root"
        val expected = PublicationBackendIdCodec.backendIdFor(PublicationBackend.SAF_TREE, publicationRootToken)

        assertEquals(PublicationBackend.SAF_TREE, PublicationBackendIdCodec.publicationBackendFor("SAF_TREE", publicationRootToken))
        assertEquals(PublicationBackend.SAF_TREE, PublicationBackendIdCodec.publicationBackendFor(expected, publicationRootToken))
        assertEquals(expected, PublicationBackendIdCodec.canonicalBackendId("SAF_TREE", publicationRootToken))
        assertEquals(expected, PublicationBackendIdCodec.canonicalBackendId(expected, publicationRootToken))
        assertTrue(PublicationBackendIdCodec.backendIdsMatch("SAF_TREE", expected, publicationRootToken))
        assertTrue(PublicationBackendIdCodec.backendIdsMatch(expected, expected, publicationRootToken))
    }

    @Test
    fun unknownBackendIdsPassThroughForCustomBackends() {
        assertEquals("test-backend", PublicationBackendIdCodec.canonicalBackendId("test-backend", null))
        assertNull(PublicationBackendIdCodec.publicationBackendFor("test-backend", null))
        assertTrue(PublicationBackendIdCodec.backendIdsMatch("test-backend", "test-backend", null))
        assertFalse(PublicationBackendIdCodec.backendIdsMatch(null, "test-backend", null))
    }

    @Test
    fun mismatchedSafTreeFingerprintIsRejected() {
        val rootToken = "content://provider/tree/root"
        assertThrows(IllegalArgumentException::class.java) {
            PublicationBackendIdCodec.canonicalBackendId("saf-tree-v1:deadbeefdeadbeefdeadbeef", rootToken)
        }
    }
}

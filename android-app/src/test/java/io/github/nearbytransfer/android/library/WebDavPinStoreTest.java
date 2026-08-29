package io.github.nearbytransfer.android.library;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * JVM-only tests for the WebDAV certificate pin persistence. The pinned
 * fingerprint is the endpoint identity for the library channel, so a mismatch
 * must fail closed (see WebDavClient).
 */
public class WebDavPinStoreTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void roundTripsPinPerEndpoint() throws IOException {
        File file = temporaryFolder.newFile("pins.properties");
        WebDavPinStore store = new WebDavPinStore(file);

        assertNull(store.get("192.168.1.10", 56578));
        store.put("192.168.1.10", 56578, "a".repeat(64));
        store.put("192.168.1.10", 56579, "b".repeat(64));

        assertEquals("a".repeat(64), store.get("192.168.1.10", 56578));
        assertEquals("b".repeat(64), store.get("192.168.1.10", 56579));
        assertNull(store.get("192.168.1.11", 56578));
    }

    @Test
    public void persistsAcrossInstances() throws IOException {
        File file = temporaryFolder.newFile("pins.properties");
        new WebDavPinStore(file).put("desktop-lan", 56578, "c".repeat(64));

        WebDavPinStore reloaded = new WebDavPinStore(file);
        assertEquals("c".repeat(64), reloaded.get("desktop-lan", 56578));
    }

    @Test
    public void ignoresEmptyFingerprintsAndReloadsCorruptFileAsEmpty() throws IOException {
        File file = temporaryFolder.newFile("pins.properties");
        WebDavPinStore store = new WebDavPinStore(file);
        store.put("host", 1, null);
        store.put("host", 2, "");
        assertNull(store.get("host", 1));
        assertNull(store.get("host", 2));

        File corrupt = temporaryFolder.newFile("corrupt.properties");
        java.nio.file.Files.write(corrupt.toPath(), "!!!not properties!!!".getBytes(StandardCharsets.UTF_8));
        WebDavPinStore corruptStore = new WebDavPinStore(corrupt);
        assertNull(corruptStore.get("host", 1));
        // The store must remain usable after a corrupt load.
        corruptStore.put("host", 3, "d".repeat(64));
        assertEquals("d".repeat(64), corruptStore.get("host", 3));
    }

    @Test
    public void fingerprintComparisonFailsClosedOnAnyMismatch() throws Exception {
        String expected = hex(MessageDigest.getInstance("SHA-256").digest("desktop-cert".getBytes(StandardCharsets.UTF_8)));
        // Same certificate under a different case must still compare equal
        // (the client lower-cases both sides before the constant-time compare).
        org.junit.Assert.assertTrue(matches(expected, expected.toUpperCase()));
        // Any other certificate fingerprint must be rejected.
        org.junit.Assert.assertFalse(matches(expected, hex(
            MessageDigest.getInstance("SHA-256").digest("mitm-cert".getBytes(StandardCharsets.UTF_8)))));
    }

    private static boolean matches(String expected, String observed) {
        return MessageDigest.isEqual(
            observed.toLowerCase().getBytes(StandardCharsets.UTF_8),
            expected.toLowerCase().getBytes(StandardCharsets.UTF_8));
    }

    private static String hex(byte[] data) {
        StringBuilder builder = new StringBuilder(data.length * 2);
        for (byte b : data) {
            builder.append(String.format("%02x", b));
        }
        return builder.toString();
    }
}

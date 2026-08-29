package io.github.nearbytransfer.android.library;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Properties;

/**
 * Persists the pinned SHA-256 certificate fingerprint per library endpoint.
 *
 * <p>The first connection to a paired desktop records the certificate it
 * presented (trust-on-first-use). Every later connection must present the
 * exact same certificate or the request fails closed, so a renamed or
 * substituted certificate can only ever be trusted once, by an explicit
 * re-pair.</p>
 */
public final class WebDavPinStore {

    private final File file;
    private final Properties pins = new Properties();

    public WebDavPinStore(File file) {
        this.file = file;
        load();
    }

    public synchronized String get(String host, int port) {
        return pins.getProperty(key(host, port));
    }

    public synchronized void put(String host, int port, String fingerprint) {
        if (fingerprint == null || fingerprint.isEmpty()) {
            return;
        }
        pins.setProperty(key(host, port), fingerprint);
        save();
    }

    private static String key(String host, int port) {
        return host + ":" + port;
    }

    private void load() {
        if (!file.exists()) {
            return;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            pins.load(in);
        } catch (IOException error) {
            System.err.println("WebDavPinStore: unable to read pins, starting empty: " + error.getMessage());
        }
    }

    private void save() {
        try (FileOutputStream out = new FileOutputStream(file)) {
            pins.store(out, null);
        } catch (IOException error) {
            // Persistence is best-effort; in-memory pinning still protects the
            // current process and the pin is re-captured on the next run.
            System.err.println("WebDavPinStore: unable to persist pins: " + error.getMessage());
        }
    }
}

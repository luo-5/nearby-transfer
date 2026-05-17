package io.github.nearbytransfer.android;

import java.io.OutputStream;

interface SaveTarget {
    String displayName();
    String displayPathFor(String fileName);
    PendingSave prepare(String fileName) throws Exception;

    interface PendingSave {
        String displayPath();
        OutputStream openOutputStream() throws Exception;
        void commit() throws Exception;
        void abort();
    }
}

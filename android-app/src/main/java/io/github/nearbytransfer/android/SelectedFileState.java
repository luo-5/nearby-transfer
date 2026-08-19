package io.github.nearbytransfer.android;

import android.net.Uri;
import android.os.Bundle;

final class SelectedFileState {
    private static final String KEY_URI = "selectedFile.uri";
    private static final String KEY_NAME = "selectedFile.name";
    private static final String KEY_SIZE = "selectedFile.size";

    private SelectedFileState() {
    }

    static void save(Bundle state, SelectedFile file) {
        if (state == null) {
            return;
        }
        if (file == null) {
            state.remove(KEY_URI);
            state.remove(KEY_NAME);
            state.remove(KEY_SIZE);
            return;
        }
        state.putString(KEY_URI, file.uri.toString());
        state.putString(KEY_NAME, file.name);
        state.putLong(KEY_SIZE, file.size);
    }

    static SelectedFile restore(Bundle state) {
        if (state == null) {
            return null;
        }
        String uriValue = state.getString(KEY_URI);
        if (uriValue == null || uriValue.trim().isEmpty()) {
            return null;
        }
        String name = state.getString(KEY_NAME);
        if (name == null || name.trim().isEmpty()) {
            name = "file";
        }
        long size = state.getLong(KEY_SIZE, -1L);
        if (size < -1L) {
            size = -1L;
        }
        return new SelectedFile(Uri.parse(uriValue), name, size);
    }
}

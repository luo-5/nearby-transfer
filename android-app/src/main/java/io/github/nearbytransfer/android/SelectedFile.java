package io.github.nearbytransfer.android;

import android.net.Uri;

final class SelectedFile {
    final Uri uri;
    final String name;
    final long size;

    SelectedFile(Uri uri, String name, long size) {
        this.uri = uri;
        this.name = name;
        this.size = size;
    }
}

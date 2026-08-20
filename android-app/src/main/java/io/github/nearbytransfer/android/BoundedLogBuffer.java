package io.github.nearbytransfer.android;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class BoundedLogBuffer {
    private final int maxEntries;
    private final ArrayDeque<String> entries = new ArrayDeque<>();

    BoundedLogBuffer(int maxEntries) {
        if (maxEntries <= 0) {
            throw new IllegalArgumentException("maxEntries must be greater than zero");
        }
        this.maxEntries = maxEntries;
    }

    synchronized boolean add(String message) {
        String normalized = normalize(message);
        if (normalized.isEmpty()) {
            return false;
        }

        while (entries.size() >= maxEntries) {
            entries.removeFirst();
        }
        entries.addLast(normalized);
        return true;
    }

    synchronized List<String> snapshot() {
        return Collections.unmodifiableList(new ArrayList<>(entries));
    }

    synchronized String render() {
        return String.join("\n", entries);
    }

    synchronized int size() {
        return entries.size();
    }

    synchronized void clear() {
        entries.clear();
    }

    private static String normalize(String message) {
        if (message == null) {
            return "";
        }
        return message.replace("\r\n", "\n").replace('\r', '\n').strip();
    }
}

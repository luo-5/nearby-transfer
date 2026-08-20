package io.github.nearbytransfer.android;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class BoundedLogBufferTest {
    @Test
    public void requiresPositiveCapacity() {
        assertThrows(IllegalArgumentException.class, () -> new BoundedLogBuffer(0));
        assertThrows(IllegalArgumentException.class, () -> new BoundedLogBuffer(-1));
    }

    @Test
    public void ignoresBlankMessagesAndNormalizesAcceptedMessages() {
        BoundedLogBuffer buffer = new BoundedLogBuffer(3);

        assertFalse(buffer.add(null));
        assertFalse(buffer.add(" \t\r\n "));
        assertTrue(buffer.add("  first line\r\nsecond line  "));

        assertEquals(1, buffer.size());
        assertEquals(List.of("first line\nsecond line"), buffer.snapshot());
        assertEquals("first line\nsecond line", buffer.render());
    }

    @Test
    public void evictsOldestEntriesAndRendersInOrder() {
        BoundedLogBuffer buffer = new BoundedLogBuffer(3);

        buffer.add("one");
        buffer.add("two");
        buffer.add("three");
        buffer.add("four");

        assertEquals(List.of("two", "three", "four"), buffer.snapshot());
        assertEquals("two\nthree\nfour", buffer.render());
    }

    @Test
    public void snapshotIsDetachedAndImmutable() {
        BoundedLogBuffer buffer = new BoundedLogBuffer(2);
        buffer.add("one");
        List<String> snapshot = buffer.snapshot();

        buffer.add("two");

        assertEquals(List.of("one"), snapshot);
        assertThrows(UnsupportedOperationException.class, () -> snapshot.add("three"));
        assertEquals(List.of("one", "two"), buffer.snapshot());
    }

    @Test
    public void clearRestoresEmptyState() {
        BoundedLogBuffer buffer = new BoundedLogBuffer(2);
        buffer.add("one");

        buffer.clear();

        assertEquals(0, buffer.size());
        assertTrue(buffer.snapshot().isEmpty());
        assertEquals("", buffer.render());
    }
}

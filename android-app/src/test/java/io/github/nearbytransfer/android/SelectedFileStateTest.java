package io.github.nearbytransfer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.net.Uri;
import android.os.Bundle;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class SelectedFileStateTest {
    @Test
    public void roundTripsSelectedFile() {
        Bundle state = new Bundle();
        SelectedFile original = new SelectedFile(
                Uri.parse("content://downloads/public_downloads/42"),
                "测试文件.txt",
                1234L
        );

        SelectedFileState.save(state, original);
        SelectedFile restored = SelectedFileState.restore(state);

        assertEquals(original.uri, restored.uri);
        assertEquals(original.name, restored.name);
        assertEquals(original.size, restored.size);
    }

    @Test
    public void missingUriDoesNotRestoreSelection() {
        Bundle state = new Bundle();
        state.putString("selectedFile.name", "orphan.txt");

        assertNull(SelectedFileState.restore(state));
    }

    @Test
    public void malformedMetadataUsesSafeFallbacks() {
        Bundle state = new Bundle();
        state.putString("selectedFile.uri", "content://downloads/public_downloads/7");
        state.putString("selectedFile.name", "   ");
        state.putLong("selectedFile.size", -99L);

        SelectedFile restored = SelectedFileState.restore(state);

        assertEquals("file", restored.name);
        assertEquals(-1L, restored.size);
    }

    @Test
    public void savingNullClearsPreviousSelection() {
        Bundle state = new Bundle();
        SelectedFileState.save(state, new SelectedFile(Uri.parse("content://example/file"), "file", 1L));

        SelectedFileState.save(state, null);

        assertNull(SelectedFileState.restore(state));
    }
}

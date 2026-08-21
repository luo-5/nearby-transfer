package io.github.nearbytransfer.android.feature.libraries

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nearbytransfer.android.R

@Composable
fun LibrariesScreen(
    state: LibrariesUiState,
    onSelectShare: (LibraryShare) -> Unit = {},
    onNavigateItem: (LibraryItem) -> Unit = {},
    onNavigateUp: () -> Unit = {},
    onUploadFile: () -> Unit = {},
    onDownloadFile: (LibraryItem) -> Unit = {},
    contentPadding: PaddingValues = PaddingValues(0.dp),
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.section_shared_libraries),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            state.connectedPeerName?.let { peerName ->
                Text(
                    text = "Connected Peer: $peerName",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }

        if (state.shares.isEmpty()) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    ),
                ) {
                    Text(
                        text = stringResource(R.string.no_libraries_available),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        } else {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.shares.forEach { share ->
                        FilterChip(
                            selected = share.id == state.selectedShareId,
                            onClick = { onSelectShare(share) },
                            label = { Text(share.name) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        )
                    }
                }
            }

            state.currentShare?.let { share ->
                item {
                    ShareHeaderCard(
                        share = share,
                        currentPath = state.currentPath,
                        isUploadAllowed = !share.isReadOnly && state.isUploadPermitted,
                        onNavigateUp = onNavigateUp,
                        onUpload = onUploadFile,
                    )
                }

                if (state.items.isEmpty()) {
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
                            ),
                        ) {
                            Text(
                                text = stringResource(R.string.empty_folder_message),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(16.dp),
                            )
                        }
                    }
                } else {
                    items(state.items, key = { it.path }) { item ->
                        LibraryItemRow(
                            item = item,
                            onClick = {
                                if (item.isDirectory) {
                                    onNavigateItem(item)
                                } else {
                                    onDownloadFile(item)
                                }
                            },
                            onDownload = { onDownloadFile(item) },
                        )
                    }
                }
            }
        }

        item {
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ShareHeaderCard(
    share: LibraryShare,
    currentPath: String,
    isUploadAllowed: Boolean,
    onNavigateUp: () -> Unit,
    onUpload: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = share.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = if (share.isReadOnly) {
                        MaterialTheme.colorScheme.outline.copy(alpha = 0.14f)
                    } else {
                        MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
                    },
                ) {
                    Text(
                        text = if (share.isReadOnly) stringResource(R.string.library_readonly_badge) else stringResource(R.string.library_upload_badge),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (share.isReadOnly) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }

            Text(
                text = "Path: $currentPath",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (currentPath != "/" && currentPath.isNotEmpty()) {
                    OutlinedButton(
                        onClick = onNavigateUp,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) {
                        Text(stringResource(R.string.action_go_up))
                    }
                }
                if (isUploadAllowed) {
                    Button(
                        onClick = onUpload,
                        modifier = Modifier
                            .weight(1f)
                            .defaultMinSize(minHeight = 48.dp),
                    ) {
                        Text(stringResource(R.string.action_upload_to_library))
                    }
                }
            }
        }
    }
}

@Composable
private fun LibraryItemRow(
    item: LibraryItem,
    onClick: () -> Unit,
    onDownload: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "${if (item.isDirectory) "📁 " else "📄 "}${item.name}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!item.isDirectory) {
                    Text(
                        text = item.formattedSize,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!item.isDirectory) {
                Spacer(modifier = Modifier.width(8.dp))
                OutlinedButton(
                    onClick = onDownload,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.action_download_file))
                }
            }
        }
    }
}

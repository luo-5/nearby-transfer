package io.github.nearbytransfer.android.feature.transfers

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
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
fun TransfersScreen(
    state: TransfersUiState,
    onPickFile: () -> Unit = {},
    onSendFile: () -> Unit = {},
    onCancelTransfer: (ActiveTransferItem) -> Unit = {},
    onRetryTransfer: (ActiveTransferItem) -> Unit = {},
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
                text = stringResource(R.string.section_select_file),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = state.selectedFile?.name ?: stringResource(R.string.no_file_selected),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (state.selectedFile != null) FontWeight.SemiBold else FontWeight.Normal,
                    )
                    state.selectedFile?.let { file ->
                        Text(
                            text = file.formattedSize,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedButton(
                            onClick = onPickFile,
                            modifier = Modifier
                                .weight(1f)
                                .defaultMinSize(minHeight = 48.dp),
                        ) {
                            Text(stringResource(R.string.action_choose_file))
                        }
                        Button(
                            onClick = onSendFile,
                            enabled = state.selectedFile != null && !state.isTransferring,
                            modifier = Modifier
                                .weight(1f)
                                .defaultMinSize(minHeight = 48.dp),
                        ) {
                            Text(stringResource(R.string.action_send))
                        }
                    }
                }
            }
        }

        state.activeTransfer?.let { transfer ->
            item {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.section_transfer_progress),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            item {
                ActiveTransferCard(
                    transfer = transfer,
                    onCancel = { onCancelTransfer(transfer) },
                    onRetry = { onRetryTransfer(transfer) },
                )
            }
        }

        if (state.transferHistory.isNotEmpty()) {
            item {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.section_transfer_history),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            items(state.transferHistory, key = { it.taskId }) { item ->
                TransferHistoryRow(item = item)
            }
        }

        item {
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ActiveTransferCard(
    transfer: ActiveTransferItem,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = transfer.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                StatusBadge(status = transfer.status)
            }
            Text(
                text = "${if (transfer.isIncoming) "From: " else "To: "}${transfer.peerName}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
            LinearProgressIndicator(
                progress = { transfer.progressFraction },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(8.dp)
                    .padding(vertical = 8.dp),
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = transfer.formattedProgress,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "${transfer.percentage}%",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            if (transfer.status == TransferUiStatus.FAILED || transfer.status == TransferUiStatus.CANCELLED) {
                Button(
                    onClick = onRetry,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp)
                        .defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.action_retry))
                }
            } else if (transfer.status == TransferUiStatus.TRANSFERRING || transfer.status == TransferUiStatus.QUEUED) {
                OutlinedButton(
                    onClick = onCancel,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp)
                        .defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        }
    }
}

@Composable
private fun TransferHistoryRow(item: ActiveTransferItem) {
    Card(
        modifier = Modifier.fillMaxWidth(),
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
                    text = item.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "${item.peerName} • ${SelectedFileItem.formatBytes(item.totalBytes)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            StatusBadge(status = item.status)
        }
    }
}

@Composable
private fun StatusBadge(status: TransferUiStatus) {
    val labelRes = when (status) {
        TransferUiStatus.IDLE -> R.string.status_ready
        TransferUiStatus.AWAITING_APPROVAL -> R.string.status_awaiting_approval
        TransferUiStatus.QUEUED -> R.string.status_queued
        TransferUiStatus.TRANSFERRING -> R.string.status_transferring
        TransferUiStatus.PAUSED -> R.string.status_paused
        TransferUiStatus.COMPLETED -> R.string.status_completed
        TransferUiStatus.FAILED -> R.string.status_failed
        TransferUiStatus.CANCELLED -> R.string.status_cancelled
    }
    val color = when (status) {
        TransferUiStatus.IDLE, TransferUiStatus.CANCELLED -> MaterialTheme.colorScheme.outline
        TransferUiStatus.AWAITING_APPROVAL, TransferUiStatus.PAUSED -> MaterialTheme.colorScheme.tertiary
        TransferUiStatus.QUEUED -> MaterialTheme.colorScheme.secondary
        TransferUiStatus.TRANSFERRING, TransferUiStatus.COMPLETED -> MaterialTheme.colorScheme.primary
        TransferUiStatus.FAILED -> MaterialTheme.colorScheme.error
    }

    Surface(
        shape = RoundedCornerShape(4.dp),
        color = color.copy(alpha = 0.14f),
    ) {
        Text(
            text = stringResource(labelRes),
            style = MaterialTheme.typography.labelSmall,
            color = color,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

package io.github.nearbytransfer.android;

import java.util.Locale;

final class TransferEvent {
    final String transferId;
    final String direction;
    final String status;
    final String fileName;
    final long bytes;
    final long total;
    final String detail;

    TransferEvent(String transferId, String direction, String status, String fileName, long bytes, long total, String detail) {
        this.transferId = transferId;
        this.direction = direction;
        this.status = status;
        this.fileName = fileName;
        this.bytes = bytes;
        this.total = total;
        this.detail = detail;
    }

    String toDisplayText() {
        String prefix = "send".equals(direction) ? "发送" : "receive".equals(direction) ? "接收" : "系统";
        String translated = translateStatus(status);
        String progress = total > 0 ? " " + formatBytes(bytes) + " / " + formatBytes(total) : "";
        String suffix = detail == null || detail.isEmpty() ? "" : "：" + detail;
        return prefix + " | " + translated + " | " + fileName + progress + suffix;
    }

    private static String translateStatus(String status) {
        switch (status) {
            case "preparing": return "准备中";
            case "requesting": return "等待确认";
            case "accepted": return "已接受";
            case "rejected": return "已拒绝";
            case "sending": return "发送中";
            case "receiving": return "接收中";
            case "completed": return "已完成";
            case "failed": return "失败";
            default: return status;
        }
    }

    private static String formatBytes(long bytes) {
        String[] units = { "B", "KB", "MB", "GB", "TB" };
        double value = bytes;
        int unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        return String.format(Locale.ROOT, unit == 0 ? "%.0f %s" : "%.1f %s", value, units[unit]);
    }
}

package io.github.nearbytransfer.android.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import io.github.nearbytransfer.android.MainActivity;
import io.github.nearbytransfer.android.R;

public class TransferForegroundService extends Service {

    public static final String ACTION_START_TRANSFER = "io.github.nearbytransfer.action.START_TRANSFER";
    public static final String ACTION_UPDATE_PROGRESS = "io.github.nearbytransfer.action.UPDATE_PROGRESS";
    public static final String ACTION_STOP_TRANSFER = "io.github.nearbytransfer.action.STOP_TRANSFER";

    public static final String EXTRA_FILENAME = "extra_filename";
    public static final String EXTRA_TITLE = "extra_title";
    public static final String EXTRA_PROGRESS = "extra_progress";
    public static final String EXTRA_SPEED = "extra_speed";

    private static final String CHANNEL_ID = "nearby_transfer_progress_channel";
    private static final int NOTIFICATION_ID = 7701;

    private NotificationManager notificationManager;

    public static void startTransfer(Context context, String filename, String title, int progressPercent, String speed) {
        if (context == null) return;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_START_TRANSFER);
        intent.putExtra(EXTRA_FILENAME, filename);
        intent.putExtra(EXTRA_TITLE, title != null ? title : "正在传输文件");
        intent.putExtra(EXTRA_PROGRESS, progressPercent);
        intent.putExtra(EXTRA_SPEED, speed != null ? speed : "-");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {}
    }

    public static void updateProgress(Context context, String filename, String title, int progressPercent, String speed) {
        if (context == null) return;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_UPDATE_PROGRESS);
        intent.putExtra(EXTRA_FILENAME, filename);
        intent.putExtra(EXTRA_TITLE, title != null ? title : "正在传输文件");
        intent.putExtra(EXTRA_PROGRESS, progressPercent);
        intent.putExtra(EXTRA_SPEED, speed != null ? speed : "-");
        try {
            context.startService(intent);
        } catch (Exception ignored) {}
    }

    public static void stopTransfer(Context context) {
        if (context == null) return;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_STOP_TRANSFER);
        try {
            context.startService(intent);
        } catch (Exception ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP_TRANSFER.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        String filename = intent.getStringExtra(EXTRA_FILENAME);
        String title = intent.getStringExtra(EXTRA_TITLE);
        int progress = intent.getIntExtra(EXTRA_PROGRESS, 0);
        String speed = intent.getStringExtra(EXTRA_SPEED);

        Notification notification = buildNotification(filename, title, progress, speed);

        if (ACTION_START_TRANSFER.equals(intent.getAction())) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } else if (ACTION_UPDATE_PROGRESS.equals(intent.getAction())) {
            if (notificationManager != null) {
                notificationManager.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_NOT_STICKY;
    }

    private Notification buildNotification(String filename, String title, int progressPercent, String speed) {
        Intent contentIntent = new Intent(this, MainActivity.class);
        contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT
        );

        String contentText = (filename != null ? filename : "文件传输中") + (speed != null && !speed.isEmpty() ? " · " + speed : "");

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.app_icon)
            .setContentTitle(title != null ? title : "Nearby Transfer")
            .setContentText(contentText)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        if (progressPercent >= 0 && progressPercent <= 100) {
            builder.setProgress(100, progressPercent, false);
        } else {
            builder.setProgress(0, 0, true);
        }

        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "文件传输进度与保活",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("用于在后台和锁屏期间显示文件传输进度并防止传输被系统杀死");
            channel.enableVibration(false);
            channel.enableLights(false);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

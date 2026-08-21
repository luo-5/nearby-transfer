package io.github.nearbytransfer.android.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

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
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

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
        
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NearbyTransfer::TransferWakeLock");
            wakeLock.acquire(10 * 60 * 1000L /*10 minutes max*/);
        }
        
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager != null) {
            wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "NearbyTransfer::TransferWifiLock");
            wifiLock.acquire();
        }
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

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
            wifiLock = null;
        }
    }

    private Notification buildNotification(String filename, String title, int progressPercent, String speed) {
        Intent contentIntent = new Intent(this, MainActivity.class);
        contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT
        );

        String defaultContent = getString(R.string.notification_in_progress);
        String defaultTitle = getString(R.string.notification_transferring);
        String contentText = (filename != null ? filename : defaultContent) + (speed != null && !speed.isEmpty() ? " · " + speed : "");

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.app_icon)
            .setContentTitle(title != null ? title : defaultTitle)
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
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(getString(R.string.notification_channel_desc));
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

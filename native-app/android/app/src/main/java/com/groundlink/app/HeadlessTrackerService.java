package com.groundlink.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.NotificationCompat;

/**
 * Keeps location fixes flowing to Firebase (for Favorites/Crews/tracked quick-join rooms) in the
 * two cases the normal in-app tracking can't cover: right after a device reboot, before the app
 * has been manually reopened, and after the visible app has been swiped away from Recents.
 *
 * Neither case is handled by the vendored @capacitor-community/background-geolocation plugin,
 * which deliberately stops itself the moment MainActivity/the Capacitor bridge is destroyed (see
 * BackgroundGeolocationService.onUnbind / BackgroundGeolocation.handleOnDestroy — confirmed by
 * reading the plugin source directly). Its addWatcher/removeWatcher API is a Capacitor PluginCall
 * channel back to one specific live Activity instance, so there's no way to keep IT running
 * independent of that Activity.
 *
 * This service instead hosts its OWN bare WebView (no Capacitor bridge at all) loading
 * public/headless.html — a minimal, UI-less page that reads the SAME shared localStorage the
 * main app already writes to (gl_uid, gl_favs, gl_circles, gl_joined) and reports fixes via the
 * plain Firebase JS SDK + Web Geolocation API, neither of which needs an Activity to keep working.
 *
 * Two modes, so the app is never showing two redundant "GroundLink is tracking" notifications
 * at once:
 *  - STANDBY: MainActivity is alive and already tracking via the normal in-app path. This service
 *    just exists as a plain (non-foreground, no notification) started Service so it's associated
 *    with that task and will receive onTaskRemoved() if the task is later swiped away. No
 *    WebView, no notification, no duplicate tracking.
 *  - ACTIVE: MainActivity is gone (task removed) or never existed yet (fresh boot). Promotes to
 *    a real foreground service with its own notification, loads the headless WebView, and starts
 *    reporting fixes — until MainActivity starts back up and demotes it to standby again.
 */
public class HeadlessTrackerService extends Service {
    private static final String TAG = "GLHeadlessSvc";
    private static final String CHAN_ID = "groundlink_headless";
    private static final int NOTIF_ID = 44;
    private static final String HEADLESS_URL = "https://tracker-production-3b03.up.railway.app/headless.html";

    private WebView webView;
    private boolean active = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean retryScheduled = false;

    // Called from MainActivity.onCreate() — every time the visible app starts up (fresh launch,
    // or reopened after having been swiped away), it re-asserts standby so a service left in
    // ACTIVE mode from a prior task removal gets demoted (its WebView/tracking torn down) now
    // that the normal in-app path is covering location again.
    public static void startStandby(Context ctx) {
        try {
            Intent i = new Intent(ctx, HeadlessTrackerService.class);
            i.putExtra("standby", true);
            ctx.startService(i); // plain (non-foreground) — no notification while the app is open
        } catch (Exception e) {
            Log.e(TAG, "startStandby failed", e);
        }
    }

    // Called from BootReceiver (fresh boot, no MainActivity involved at all) and internally via
    // the onTaskRemoved restart alarm. No "standby" extra — defaults to active.
    public static void startActive(Context ctx) {
        try {
            Intent i = new Intent(ctx, HeadlessTrackerService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            Log.e(TAG, "startActive failed", e);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A null intent means Android restarted this STICKY service itself after killing it
        // (e.g. low memory) — resume whatever mode it was last in rather than defaulting away
        // from active tracking. Only an explicit standby request should ever demote it.
        boolean standby = intent != null && intent.getBooleanExtra("standby", false);
        try {
            if (standby) {
                demoteToStandby();
            } else {
                promoteToActive();
            }
        } catch (Exception e) {
            Log.e(TAG, "onStartCommand failed", e);
        }
        return START_STICKY;
    }

    private void promoteToActive() {
        if (active) return;
        active = true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, buildNotification());
            }
        } catch (Exception e) {
            // Location foreground-service type can be refused in some background-start edge
            // cases — fall back to an untyped notification rather than crash. Worse case here is
            // a less-precise OS classification, not a failure to track.
            Log.w(TAG, "typed startForeground failed, falling back", e);
            try { startForeground(NOTIF_ID, buildNotification()); } catch (Exception e2) {
                Log.e(TAG, "startForeground failed entirely", e2);
            }
        }
        try { ensureWebView(); } catch (Exception e) { Log.e(TAG, "ensureWebView failed", e); }
    }

    private void demoteToStandby() {
        active = false;
        try { stopForeground(true); } catch (Exception e) {}
        destroyWebView();
    }

    private void ensureWebView() {
        if (webView != null) return;
        WebView wv = new WebView(getApplicationContext());
        // Never attached to a Window — this WebView is never shown. Software rendering avoids
        // needing a real hardware-accelerated surface, which a headless WebView never gets.
        wv.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);   // headless.html reads/writes localStorage
        ws.setDatabaseEnabled(true);
        ws.setGeolocationEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // The OS-level ACCESS_FINE_LOCATION/ACCESS_BACKGROUND_LOCATION permission was
                // already granted through the main app — there's no UI here to show a prompt
                // through anyway, so just grant WebView's own internal per-origin check.
                callback.invoke(origin, true, false);
            }
        });
        // A boot-triggered load can easily race ahead of the network actually being up yet, and
        // there's no human here to notice a blank/error page and manually retry. Detect a failed
        // MAIN-FRAME load and retry after a short delay instead of silently sitting on a dead
        // page forever — retryScheduled guards against piling up overlapping retries if multiple
        // sub-resource errors fire for the same failed navigation.
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && !request.isForMainFrame()) return;
                scheduleRetry();
            }
        });
        // Lets headless.html tell us there's genuinely nothing to do (no saved session at all —
        // e.g. a fresh install that reboots before ever being opened once — or every fan-out
        // target has since expired/been removed), so the notification doesn't linger forever for
        // a device that was never really using this feature.
        wv.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void stopSelf() {
                try { HeadlessTrackerService.this.stopSelf(); } catch (Exception e) {}
            }
        }, "AndroidHeadless");
        wv.loadUrl(HEADLESS_URL);
        webView = wv;
    }

    private void scheduleRetry() {
        if (retryScheduled || !active) return;
        retryScheduled = true;
        mainHandler.postDelayed(() -> {
            retryScheduled = false;
            try { if (active && webView != null) webView.loadUrl(HEADLESS_URL); } catch (Exception e) {}
        }, 10000);
    }

    private void destroyWebView() {
        WebView wv = webView;
        webView = null;
        if (wv == null) return;
        try { wv.stopLoading(); wv.destroy(); } catch (Exception e) {}
    }

    // Fires when the visible app's task is swiped away from Recents while this service is
    // running in ACTIVE mode (boot-started, or previously promoted by an earlier task removal).
    // Android sometimes tears a service down shortly after this callback regardless of what's
    // done here; scheduling a near-immediate restart via AlarmManager (rather than trying to
    // call startForegroundService synchronously inside this callback, which some OEM/Android
    // version combinations refuse) is the standard, reliable pattern for surviving it.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        try {
            Intent restart = new Intent(getApplicationContext(), HeadlessTrackerService.class);
            restart.setPackage(getPackageName());
            int piFlags = PendingIntent.FLAG_ONE_SHOT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getService(getApplicationContext(), 91, restart, piFlags);
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 1000, pi);
        } catch (Exception e) {
            Log.e(TAG, "onTaskRemoved restart schedule failed", e);
        }
    }

    @Override
    public void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHAN_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHAN_ID, "Background location", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        PendingIntent pi = null;
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            pi = PendingIntent.getActivity(this, 0, launch, piFlags);
        } catch (Exception e) { /* notification still works without a tap target */ }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHAN_ID)
            .setContentTitle("GroundLink")
            .setContentText("Sharing your location in the background")
            .setSmallIcon(R.drawable.ic_stat_groundlink)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }
}

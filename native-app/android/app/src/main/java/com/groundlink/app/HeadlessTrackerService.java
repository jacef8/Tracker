package com.groundlink.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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
    // Two FIXED channel IDs instead of one channel whose importance we'd try to change in
    // place — channel importance is locked once created, and deleting+recreating the SAME
    // channel ID races the OS's handling of an already-posted notification (this exact crash
    // was already hit and fixed for VoiceForegroundService; mirrored here). Toggling just
    // switches which channel ID the notification is posted under.
    private static final String CHAN_VISIBLE = "groundlink_headless_visible";
    private static final String CHAN_HIDDEN = "groundlink_headless_quiet";
    private static final int NOTIF_ID = 44;
    private static final String PREFS = "groundlink_headless_svc";
    private static final String PREF_ICON_VISIBLE = "icon_visible";
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

    // The foreground service itself can't be hidden entirely (that notification is the whole
    // OS-level trade-off for staying alive unthrottled), but its status-bar ICON specifically
    // can be removed by lowering the channel's importance to MIN — same mechanism as the voice
    // notification icon toggle. Default HIDDEN (unlike voice's default-visible): background
    // location runs essentially all the time, so a persistent status-bar icon for it is exactly
    // the always-on clutter Life360-style apps avoid.
    //
    // Deliberately does NOT nudge the service the way VoiceForegroundService.setIconVisible()
    // does — this setting can only be toggled from the open app's Settings page, which means
    // MainActivity is alive and this service is necessarily in STANDBY (no notification posted
    // at all right now — see the class doc). Calling startActive() here would wrongly force a
    // full promotion out of standby (duplicate tracking) just to change a preference. The new
    // value is simply picked up the next time the service actually promotes to active (reboot,
    // or the app getting swiped from Recents).
    public static void setIconVisible(Context ctx, boolean visible) {
        try { prefs(ctx).edit().putBoolean(PREF_ICON_VISIBLE, visible).apply(); }
        catch (Exception e) { Log.e(TAG, "setIconVisible() failed", e); }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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
        Log.i(TAG, "onStartCommand: intent=" + (intent == null ? "null" : "present") + " standby=" + standby + " currentActive=" + active);
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
        if (active) { Log.i(TAG, "promoteToActive: already active, no-op"); return; }
        active = true;
        Log.i(TAG, "promoteToActive: starting foreground + webview");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, buildNotification());
            }
            Log.i(TAG, "promoteToActive: startForeground succeeded");
        } catch (Exception e) {
            // Location foreground-service type can be refused in some background-start edge
            // cases — fall back to an untyped notification rather than crash. Worse case here is
            // a less-precise OS classification, not a failure to track.
            Log.w(TAG, "typed startForeground failed, falling back", e);
            try {
                startForeground(NOTIF_ID, buildNotification());
                Log.i(TAG, "promoteToActive: fallback startForeground succeeded");
            } catch (Exception e2) {
                Log.e(TAG, "startForeground failed entirely — service will likely be killed by the OS", e2);
            }
        }
        try { ensureWebView(); } catch (Exception e) { Log.e(TAG, "ensureWebView failed", e); }
    }

    private void demoteToStandby() {
        Log.i(TAG, "demoteToStandby: was active=" + active);
        active = false;
        try { stopForeground(true); } catch (Exception e) {}
        destroyWebView();
        // Closes a narrow race: swipe-away schedules a ~1s-delayed restart (see onTaskRemoved);
        // if the app is reopened (re-asserting standby) inside that window, cancel the pending
        // alarm too, or it would still fire afterward and wrongly promote back to active while
        // the app is open (duplicate tracking, a surprise notification the user didn't expect).
        try {
            PendingIntent pi = restartPendingIntent(PendingIntent.FLAG_NO_CREATE);
            if (pi != null) {
                AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
                if (am != null) am.cancel(pi);
                pi.cancel();
            }
        } catch (Exception e) {}
    }

    // FLAG_NO_CREATE returns null instead of creating a new PendingIntent if a matching one
    // isn't already pending — used to look up (for cancellation) vs. create (in onTaskRemoved)
    // the exact same PendingIntent, matched by request code + explicit component.
    private PendingIntent restartPendingIntent(int extraFlags) {
        Intent restart = new Intent(getApplicationContext(), HeadlessTrackerService.class);
        restart.setPackage(getPackageName());
        int flags = extraFlags | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(getApplicationContext(), 91, restart, flags);
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

            // Surfaces headless.html's own console.log/[GL-headless] lines into logcat under this
            // service's tag — otherwise they're silently swallowed since nobody's ever looking at
            // devtools for a WebView nobody can see.
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                Log.i(TAG, "JS console: " + cm.message() + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
                return true;
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
                boolean mainFrame = request == null || request.isForMainFrame();
                Log.w(TAG, "onReceivedError: mainFrame=" + mainFrame + " url=" + (request != null ? request.getUrl() : "?")
                    + " code=" + (error != null ? error.getErrorCode() : "?") + " desc=" + (error != null ? error.getDescription() : "?"));
                if (!mainFrame) return;
                scheduleRetry();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i(TAG, "onPageFinished: " + url);
            }
        });
        // Lets headless.html tell us there's genuinely nothing to do (no saved session at all —
        // e.g. a fresh install that reboots before ever being opened once — or every fan-out
        // target has since expired/been removed), so the notification doesn't linger forever for
        // a device that was never really using this feature.
        wv.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void stopSelf() {
                Log.i(TAG, "AndroidHeadless.stopSelf() called from headless.html — nothing to track");
                try { HeadlessTrackerService.this.stopSelf(); } catch (Exception e) {}
            }
        }, "AndroidHeadless");
        Log.i(TAG, "ensureWebView: loading " + HEADLESS_URL);
        wv.loadUrl(HEADLESS_URL);
        webView = wv;
    }

    private void scheduleRetry() {
        if (retryScheduled || !active) return;
        retryScheduled = true;
        Log.i(TAG, "scheduleRetry: will reload headless.html in 10s");
        mainHandler.postDelayed(() -> {
            retryScheduled = false;
            try { if (active && webView != null) { Log.i(TAG, "scheduleRetry: reloading now"); webView.loadUrl(HEADLESS_URL); } } catch (Exception e) {}
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
        Log.i(TAG, "onTaskRemoved fired — scheduling restart in 1s");
        try {
            PendingIntent pi = restartPendingIntent(PendingIntent.FLAG_ONE_SHOT);
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
        boolean iconVisible = prefs(this).getBoolean(PREF_ICON_VISIBLE, false);
        String chanId = iconVisible ? CHAN_VISIBLE : CHAN_HIDDEN;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(chanId) == null) {
                int importance = iconVisible ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_MIN;
                NotificationChannel ch = new NotificationChannel(chanId, "Background location", importance);
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
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, chanId)
            .setContentTitle("GroundLink")
            .setContentText("Sharing your location in the background")
            .setSmallIcon(R.drawable.ic_stat_groundlink)
            .setOngoing(true)
            .setPriority(iconVisible ? NotificationCompat.PRIORITY_LOW : NotificationCompat.PRIORITY_MIN);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }
}

package com.groundlink.app;

import android.util.Log;
import org.json.JSONObject;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Truck-map diagnostics (Android 1.5.3). The first try in Jace's truck ended in Android Auto's
 * "has encountered an unexpected error" with no way to see why, and this phone is never on a
 * cable to this PC. So the car code reports its start-up steps and any crash to the server's
 * /api/car-log, which only writes them to the server log. No location or names are sent.
 */
final class CarLog {
    private CarLog() {}
    static final String TAG = "GLCarMap";
    static volatile String app = "?";   // set by CarMapService from the package info

    static void step(String msg) { send("step", msg); }

    static void error(String where, Throwable t) { send("error", where + ": " + stack(t)); }

    static String stack(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String s = sw.toString();
        return s.length() > 3500 ? s.substring(0, 3500) : s;
    }

    static void send(String kind, String msg) {
        Log.i(TAG, kind + " " + msg);
        Thread th = new Thread(() -> {
            try {
                JSONObject b = new JSONObject().put("kind", kind).put("msg", msg)
                    .put("app", app)
                    .put("sdk", android.os.Build.VERSION.SDK_INT).put("model", android.os.Build.MODEL);
                HttpURLConnection c = (HttpURLConnection) new URL(CarChat.SITE + "/api/car-log").openConnection();
                c.setRequestMethod("POST"); c.setDoOutput(true);
                c.setConnectTimeout(8000); c.setReadTimeout(8000);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(b.toString().getBytes(StandardCharsets.UTF_8)); }
                c.getResponseCode(); c.disconnect();
            } catch (Exception e) {}
        });
        th.start();
        if ("crash".equals(kind)) { try { th.join(3000); } catch (InterruptedException e) {} }
    }

    /** Report an uncaught crash from any thread, then let Android handle it as usual. */
    static void installCrashHook() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        if (prev instanceof Hook) return;
        Thread.setDefaultUncaughtExceptionHandler(new Hook(prev));
    }
    private static final class Hook implements Thread.UncaughtExceptionHandler {
        final Thread.UncaughtExceptionHandler prev;
        Hook(Thread.UncaughtExceptionHandler p) { prev = p; }
        @Override public void uncaughtException(Thread t, Throwable e) {
            try { send("crash", t.getName() + ": " + stack(e)); } catch (Throwable x) {}
            if (prev != null) prev.uncaughtException(t, e);
        }
    }
}

package com.groundlink.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

/**
 * window.GLCar: how the phone app hands the truck map what it needs (Android 1.5.0, 2026-11-25).
 *
 * The truck screen (CarMapScreen) runs with no WebView and no database sign-in, so the page gives
 * it a small config whenever it changes: this phone's uid, the crew it is in, a car key per crew
 * (from the server's /api/car-keys, which only issues keys for crews the account belongs to), the
 * Follow-my-picks list per crew, people hidden on this phone, and Rename-for-me names.
 */
public class GLCarBridge {
    static final String PREFS = "gl_car";
    private final Context ctx;

    GLCarBridge(Context c) { ctx = c.getApplicationContext(); }

    @JavascriptInterface
    public void setConfig(String json) {
        if (json == null || json.length() > 200000) return;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("cfg", json).apply();
    }

    @JavascriptInterface
    public int version() { return 1; }
}

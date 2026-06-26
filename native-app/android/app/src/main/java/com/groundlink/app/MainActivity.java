package com.groundlink.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebSettings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Never let the Android WebView serve a stale copy of the app page from its own
        // HTTP cache. Freshness/offline are handled by the service worker (network-first
        // with a timeout fallback), so the WebView itself should always go to the network.
        try {
            WebSettings settings = this.getBridge().getWebView().getSettings();
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        } catch (Exception e) {
            // If anything is unavailable, fall back to default behavior.
        }
        // Push-to-talk voice uses the WebView's getUserMedia, which needs the RECORD_AUDIO
        // *runtime* permission — declaring it in the manifest is not enough on Android 6+.
        // Nothing was requesting it, so the mic was silently blocked with no system prompt.
        // Ask for it up front; Android only shows the dialog if it isn't already granted.
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO }, 4731);
            }
        } catch (Exception e) {
            // Non-fatal — voice just won't have mic access until granted in app settings.
        }
        hideNavBar();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-hide after the bar transiently returns (dialogs, swipe-to-reveal, app resume).
        if (hasFocus) hideNavBar();
    }

    // Immersive: hide the bottom Android navigation bar so the map uses the full screen.
    // The status bar (clock/battery) stays. Swipe up from the bottom edge reveals the nav
    // bar briefly, then it auto-hides again (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE).
    private void hideNavBar() {
        try {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (c != null) {
                c.hide(WindowInsetsCompat.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } catch (Exception e) {
            // Older devices / unexpected state — just leave the bars as they are.
        }
    }
}

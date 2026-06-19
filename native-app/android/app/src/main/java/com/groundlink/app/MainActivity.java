package com.groundlink.app;

import android.os.Bundle;
import android.webkit.WebSettings;
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
    }
}

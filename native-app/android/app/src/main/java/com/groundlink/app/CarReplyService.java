package com.groundlink.app;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.RemoteInput;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Handles the two Android Auto conversation actions from CarChat, with no screen.
 *
 * Reply: the spoken (or typed) answer arrives as RemoteInput text. It is posted to the server's
 * /api/aa-reply with the crew's reply key from the last chat push, and the server writes it into
 * the crew chat as this person and notifies the rest of the crew. The app needs no database
 * sign-in for this, which matters because Android Auto can fire it with the app closed.
 *
 * Mark as read: forget the unread messages and take the notification down.
 */
public class CarReplyService extends Service {
    private static final String TAG = "GLCarReply";
    static final String ACTION_REPLY = "com.groundlink.app.CAR_REPLY";
    static final String ACTION_READ = "com.groundlink.app.CAR_READ";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final String group = intent != null ? intent.getStringExtra("group") : null;
        final String action = intent != null ? intent.getAction() : null;
        if (group == null) { stopSelf(startId); return START_NOT_STICKY; }
        if (ACTION_READ.equals(action)) {
            CarChat.clear(this, group);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        CharSequence said = null;
        try {
            Bundle r = RemoteInput.getResultsFromIntent(intent);
            if (r != null) said = r.getCharSequence(CarChat.REPLY_KEY);
        } catch (Exception e) {}
        final String text = said == null ? "" : said.toString().trim();
        if (text.isEmpty()) { stopSelf(startId); return START_NOT_STICKY; }
        final JSONObject conv = CarChat.load(this, group);
        final int id = startId;
        new Thread(() -> {
            boolean ok = false;
            try {
                JSONObject body = new JSONObject();
                body.put("group", group);
                body.put("uid", conv.optString("me", ""));
                body.put("tok", conv.optString("rtok", ""));
                body.put("text", text);
                HttpURLConnection c = (HttpURLConnection) new URL(CarChat.SITE + "/api/aa-reply").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                int code = c.getResponseCode();
                ok = code >= 200 && code < 300;
                Log.i(TAG, "reply to " + group + " -> HTTP " + code);
                c.disconnect();
            } catch (Exception e) {
                Log.w(TAG, "reply failed", e);
            }
            try {
                if (ok) {
                    CarChat.clear(this, group);
                } else {
                    // Leave the conversation up (no new sound) so it can be answered again.
                    JSONObject now = CarChat.load(this, group);
                    CarChat.show(this, group, now, false);
                }
            } catch (Exception e) {}
            stopSelf(id);
        }).start();
        return START_NOT_STICKY;
    }
}

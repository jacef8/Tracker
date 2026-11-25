package com.groundlink.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Map;

/**
 * Crew chat as an Android Auto conversation (Android 1.4.9, 2026-11-24).
 *
 * Android Auto shows a phone app's messages in the car only when the notification is a
 * MessagingStyle conversation with a Reply action (one RemoteInput, SEMANTIC_ACTION_REPLY, no UI)
 * and a Mark-as-read action (SEMANTIC_ACTION_MARK_AS_READ, no UI). The car reads the messages
 * aloud and turns a spoken answer into the RemoteInput text, which CarReplyService posts.
 *
 * The server sends chat to this phone as DATA ONLY (no notification block) once the web layer has
 * marked the subscription "aa", so this class is the only thing that shows it. One conversation
 * per crew, holding the last few unread messages, cleared when read or answered.
 */
public class CarChat {
    private static final String TAG = "GLCarChat";
    static final String CHANNEL = "groundlink_chat";
    static final String REPLY_KEY = "gl_reply";
    private static final String PREFS = "gl_car_chat";
    private static final int KEEP = 6;
    static final String SITE = "https://tracker-production-3b03.up.railway.app";

    static int notifId(String group) { return 0x6C000000 | (group.hashCode() & 0x00FFFFFF); }

    /** A chat push arrived. Adds it to the crew's conversation and shows the conversation. */
    static void onChat(Context ctx, Map<String, String> d) {
        try {
            String group = d.get("group");
            if (group == null || group.isEmpty()) return;
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject conv = new JSONObject(sp.getString(group, "{}"));
            JSONArray msgs = conv.optJSONArray("m");
            if (msgs == null) msgs = new JSONArray();
            JSONObject m = new JSONObject();
            m.put("s", str(d.get("sender"), "Someone"));
            m.put("u", str(d.get("fromUid"), ""));
            m.put("t", str(d.get("text"), ""));
            long ts = System.currentTimeMillis();
            try { ts = Long.parseLong(str(d.get("ts"), "")); } catch (Exception e) {}
            m.put("ts", ts);
            msgs.put(m);
            while (msgs.length() > KEEP) msgs.remove(0);
            conv.put("m", msgs);
            conv.put("title", pretty(str(d.get("title"), group)));
            conv.put("me", str(d.get("me"), ""));
            conv.put("rtok", str(d.get("rtok"), ""));
            sp.edit().putString(group, conv.toString()).apply();
            show(ctx, group, conv, true);
        } catch (Exception e) {
            Log.w(TAG, "chat notification failed", e);
        }
    }

    /** Draw (or redraw) one crew's conversation. alert=false updates it without a new sound. */
    static void show(Context ctx, String group, JSONObject conv, boolean alert) throws Exception {
        ensureChannel(ctx);
        JSONArray msgs = conv.optJSONArray("m");
        if (msgs == null || msgs.length() == 0) { NotificationManagerCompat.from(ctx).cancel(notifId(group)); return; }
        Person me = new Person.Builder().setName("You").setKey("me").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        style.setConversationTitle(conv.optString("title", group));
        style.setGroupConversation(true);
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            Person who = "me".equals(m.optString("u")) ? null
                : new Person.Builder().setName(m.optString("s", "Someone")).setKey(m.optString("u", "x" + i)).build();
            style.addMessage(m.optString("t", ""), m.optLong("ts", System.currentTimeMillis()), who);
        }
        int rc = notifId(group);

        // Reply: one RemoteInput, semantic REPLY, no UI, and a MUTABLE PendingIntent so Android
        // Auto can put the spoken text into it.
        Intent ri = new Intent(ctx, CarReplyService.class).setAction(CarReplyService.ACTION_REPLY).putExtra("group", group);
        PendingIntent replyPi = PendingIntent.getService(ctx, rc, ri,
            PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
        RemoteInput input = new RemoteInput.Builder(REPLY_KEY).setLabel("Reply").build();
        NotificationCompat.Action reply = new NotificationCompat.Action.Builder(R.drawable.ic_stat_groundlink, "Reply", replyPi)
            .addRemoteInput(input)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build();

        Intent mi = new Intent(ctx, CarReplyService.class).setAction(CarReplyService.ACTION_READ).putExtra("group", group);
        PendingIntent readPi = PendingIntent.getService(ctx, rc + 1, mi, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Action read = new NotificationCompat.Action.Builder(R.drawable.ic_stat_groundlink, "Mark as read", readPi)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build();

        // Tapping it on the phone opens the app in that crew.
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(SITE + "/?room=" + Uri.encode(group)), ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(ctx, rc + 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder nb = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_groundlink)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openPi)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .addAction(reply)
            .addInvisibleAction(read);
        try { NotificationManagerCompat.from(ctx).notify(rc, nb.build()); }
        catch (SecurityException se) { Log.w(TAG, "no notification permission", se); }
    }

    static JSONObject load(Context ctx, String group) {
        try { return new JSONObject(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(group, "{}")); }
        catch (Exception e) { return new JSONObject(); }
    }

    /** Read or answered: forget the unread messages and take the notification down. */
    static void clear(Context ctx, String group) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject conv = new JSONObject(sp.getString(group, "{}"));
            conv.put("m", new JSONArray());
            sp.edit().putString(group, conv.toString()).apply();
        } catch (Exception e) {}
        NotificationManagerCompat.from(ctx).cancel(notifId(group));
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Crew chat", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Messages from your crews. Also shown and read aloud in Android Auto.");
        nm.createNotificationChannel(ch);
    }

    private static String str(String v, String dflt) { return v == null || v.isEmpty() ? dflt : v; }

    /** "our_crew" -> "Our Crew" */
    static String pretty(String g) {
        String s = g.replace('_', ' ').trim();
        StringBuilder b = new StringBuilder();
        boolean up = true;
        for (char c : s.toCharArray()) { b.append(up ? Character.toUpperCase(c) : c); up = c == ' '; }
        return b.toString();
    }
}

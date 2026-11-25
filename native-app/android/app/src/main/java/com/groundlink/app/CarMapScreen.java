package com.groundlink.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.CarToast;
import androidx.car.app.Screen;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.core.graphics.drawable.IconCompat;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The truck-screen crew map (Android 1.5.0, 2026-11-25; Jace: "my biggest want is to be able to see
 * the other crew members on the screen while I'm driving").
 *
 * Camera modes, cycled by the top button: Everyone (fit the crew, leaving out anyone 100+ miles
 * away), My picks (the people picked on the phone with Follow my picks), Me (keep the truck in the
 * middle). Dragging or pinching the map, or the zoom buttons, pause the auto camera for 30 s.
 * Positions come from the server every 5 s with this phone's car key for the crew.
 */
public class CarMapScreen extends Screen implements SurfaceCallback, DefaultLifecycleObserver {
    private static final String TAG = "GLCarMap";
    private static final int MODE_ALL = 0, MODE_PICKS = 1, MODE_ME = 2;
    private static final long POLL_MS = 5000, PAUSE_MS = 30000, EXTRA_MS = 30000;
    private long lastExtraAt = 0;

    private final CarMapRenderer map = new CarMapRenderer();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private int mode = MODE_ALL;
    private long pausedUntil = 0;
    private boolean running = false, fetching = false;
    private String crewKey = "", crewName = "";
    private boolean warnedNoKey = false, warnedNoPicks = false;

    public CarMapScreen(@NonNull CarContext ctx) {
        super(ctx);
        getLifecycle().addObserver(this);
        SharedPreferences sp = prefs();
        mode = sp.getInt("mode", MODE_ALL);
        map.satellite = sp.getBoolean("sat", true);
    }

    private SharedPreferences prefs() { return getCarContext().getSharedPreferences(GLCarBridge.PREFS, Context.MODE_PRIVATE); }
    private JSONObject cfg() {
        try { return new JSONObject(prefs().getString("cfg", "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    // ── lifecycle ──
    @Override public void onCreate(@NonNull LifecycleOwner o) {
        getCarContext().getCarService(AppManager.class).setSurfaceCallback(this);
    }
    @Override public void onStart(@NonNull LifecycleOwner o) { running = true; poll(); }
    @Override public void onStop(@NonNull LifecycleOwner o) { running = false; main.removeCallbacksAndMessages(null); }
    @Override public void onDestroy(@NonNull LifecycleOwner o) { map.shutdown(); io.shutdownNow(); }

    // ── template: top buttons + map buttons ──
    @NonNull
    @Override
    public Template onGetTemplate() {
        String modeLbl = mode == MODE_ALL ? "Everyone" : mode == MODE_PICKS ? "My picks" : "Me";
        ActionStrip.Builder tb = new ActionStrip.Builder()
            .addAction(new Action.Builder().setTitle(modeLbl).setOnClickListener(this::cycleMode).build())
            .addAction(new Action.Builder().setTitle(map.satellite ? "Road map" : "Satellite").setOnClickListener(this::toggleStyle).build());
        JSONArray crews = cfg().optJSONArray("crews");
        if (crews != null && crews.length() > 1)
            tb.addAction(new Action.Builder().setTitle("Crews").setOnClickListener(this::openCrews).build());
        ActionStrip top = tb.build();
        ActionStrip mapStrip = new ActionStrip.Builder()
            .addAction(Action.PAN)
            .addAction(new Action.Builder().setIcon(icon(R.drawable.ic_car_zoom_in)).setOnClickListener(() -> userZoom(1)).build())
            .addAction(new Action.Builder().setIcon(icon(R.drawable.ic_car_zoom_out)).setOnClickListener(() -> userZoom(-1)).build())
            .addAction(new Action.Builder().setIcon(icon(R.drawable.ic_car_recenter)).setOnClickListener(this::recenter).build())
            .build();
        return new NavigationTemplate.Builder().setActionStrip(top).setMapActionStrip(mapStrip).build();
    }
    private CarIcon icon(int res) { return new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), res)).build(); }

    private void cycleMode() {
        mode = (mode + 1) % 3;
        prefs().edit().putInt("mode", mode).apply();
        pausedUntil = 0; warnedNoPicks = false;
        CarToast.makeText(getCarContext(), mode == MODE_ALL ? "Following everyone" : mode == MODE_PICKS ? "Following your picks" : "Following you", CarToast.LENGTH_SHORT).show();
        invalidate(); aimCamera();
    }
    private void toggleStyle() {
        map.satellite = !map.satellite;
        prefs().edit().putBoolean("sat", map.satellite).apply();
        invalidate(); map.requestDraw();
    }
    private void recenter() { pausedUntil = 0; aimCamera(); }
    private void userZoom(int dir) { pausedUntil = System.currentTimeMillis() + PAUSE_MS; map.zoomBy(dir, Float.NaN, Float.NaN); }

    // ── surface ──
    @Override public void onSurfaceAvailable(@NonNull SurfaceContainer s) {
        map.setSurface(s.getSurface(), s.getWidth(), s.getHeight(), s.getDpi());
        aimCamera();
    }
    @Override public void onSurfaceDestroyed(@NonNull SurfaceContainer s) { map.clearSurface(); }
    @Override public void onVisibleAreaChanged(@NonNull Rect r) { map.visible.set(r); map.requestDraw(); }
    @Override public void onStableAreaChanged(@NonNull Rect r) { map.stable.set(r); aimCamera(); }
    @Override public void onScroll(float dx, float dy) { pausedUntil = System.currentTimeMillis() + PAUSE_MS; map.panBy(dx, dy); }
    @Override public void onFling(float vx, float vy) { pausedUntil = System.currentTimeMillis() + PAUSE_MS; }
    @Override public void onScale(float fx, float fy, float f) {
        pausedUntil = System.currentTimeMillis() + PAUSE_MS;
        if (f > 0) map.zoomBy(Math.log(f) / Math.log(2), fx, fy);
    }
    @Override public void onClick(float x, float y) {
        CarMapRenderer.Person p = map.hit(x, y);
        if (p == null || p.me) return;
        CarMapRenderer.Person me = null;
        for (CarMapRenderer.Person q : map.people) if (q.me) me = q;
        String line = p.status == null ? "" : p.status;
        if (me != null) {
            double mi = miles(me.lat, me.lng, p.lat, p.lng);
            String dist = mi < 0.2 ? Math.round(mi * 5280) + " ft away" : (mi < 10 ? String.format(java.util.Locale.US, "%.1f mi away", mi) : Math.round(mi) + " mi away");
            line = line.isEmpty() ? dist : line + " · " + dist;
        }
        getScreenManager().push(new CarPersonScreen(getCarContext(), p.name, line, p.lat, p.lng));
    }

    // ── crews ──
    /** The crew the truck shows: the phone's crew, unless one was picked on the truck screen since
     *  the phone last changed crews. */
    private String activeCrew(JSONObject c) {
        String phone = c.optString("cur", "");
        SharedPreferences sp = prefs();
        String ov = sp.getString("car_cur", ""), base = sp.getString("car_cur_base", "");
        if (!ov.isEmpty() && !base.equals(phone)) { sp.edit().remove("car_cur").remove("car_cur_base").apply(); ov = ""; }
        return ov.isEmpty() ? phone : ov;
    }
    private void openCrews() {
        JSONObject c = cfg();
        JSONArray crews = c.optJSONArray("crews"); if (crews == null) return;
        String cur = activeCrew(c);
        androidx.car.app.model.ItemList.Builder lb = new androidx.car.app.model.ItemList.Builder();
        for (int i = 0; i < crews.length() && i < 6; i++) {
            JSONObject cr = crews.optJSONObject(i); if (cr == null) continue;
            final String k = cr.optString("k"), n = cr.optString("n", k);
            lb.addItem(new androidx.car.app.model.Row.Builder().setTitle(n + (k.equals(cur) ? "  (showing)" : ""))
                .setOnClickListener(() -> { pickCrew(k, c.optString("cur", "")); getScreenManager().pop(); }).build());
        }
        getScreenManager().push(new Screen(getCarContext()) {
            @NonNull @Override public Template onGetTemplate() {
                return new androidx.car.app.model.ListTemplate.Builder().setTitle("Crews").setHeaderAction(Action.BACK).setSingleList(lb.build()).build();
            }
        });
    }
    private void pickCrew(String k, String phoneCur) {
        prefs().edit().putString("car_cur", k).putString("car_cur_base", phoneCur).apply();
        map.people = new ArrayList<>(); map.trails = new HashMap<>(); map.pins = new ArrayList<>(); map.pinNames = new ArrayList<>();
        lastExtraAt = 0; pausedUntil = 0; warnedNoPicks = false;
        map.requestDraw(); poll();
    }

    // ── data ──
    private void poll() {
        if (!running) return;
        main.removeCallbacks(pollRun);
        fetch();
        main.postDelayed(pollRun, POLL_MS);
    }
    private final Runnable pollRun = this::poll;

    private void fetch() {
        if (fetching) return;
        final JSONObject c = cfg();
        final String uid = c.optString("uid", ""), site = c.optString("site", CarChat.SITE);
        String cur = activeCrew(c);
        JSONArray crews = c.optJSONArray("crews");
        String tok = "", name = "";
        if (crews != null) for (int i = 0; i < crews.length(); i++) {
            JSONObject cr = crews.optJSONObject(i); if (cr == null) continue;
            if (cr.optString("k").equals(cur)) { tok = cr.optString("tok"); name = cr.optString("n"); }
        }
        if (uid.isEmpty() || cur.isEmpty() || tok.isEmpty()) {
            if (!warnedNoKey) { warnedNoKey = true; CarToast.makeText(getCarContext(), "Open GroundLink on your phone and go into a crew", CarToast.LENGTH_LONG).show(); }
            return;
        }
        if (!cur.equals(crewKey)) lastExtraAt = 0;
        crewKey = cur; crewName = name;
        final String fTok = tok, fCur = cur;
        final boolean extra = System.currentTimeMillis() - lastExtraAt > EXTRA_MS;
        if (extra) lastExtraAt = System.currentTimeMillis();
        fetching = true;
        io.execute(() -> {
            JSONObject res = null;
            try {
                JSONObject body = new JSONObject().put("group", fCur).put("uid", uid).put("tok", fTok);
                if (extra) body.put("extra", 1);
                HttpURLConnection con = (HttpURLConnection) new URL(site + "/api/car/crew").openConnection();
                con.setRequestMethod("POST"); con.setDoOutput(true);
                con.setConnectTimeout(8000); con.setReadTimeout(10000);
                con.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = con.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                if (con.getResponseCode() == 200) {
                    java.io.InputStream in = con.getInputStream();
                    byte[] buf = new byte[8192]; java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); int n;
                    while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                    res = new JSONObject(bo.toString("UTF-8"));
                } else Log.w(TAG, "crew HTTP " + con.getResponseCode());
                con.disconnect();
            } catch (Exception e) { Log.w(TAG, "crew fetch failed: " + e); }
            final JSONObject fr = res;
            main.post(() -> {
                fetching = false;
                if (fr == null || !fr.optBoolean("ok")) { if (extra) lastExtraAt = 0; return; }
                if (!fCur.equals(crewKey)) return;          // the crew was switched while this was in flight
                apply(fr, c);
            });
        });
    }

    private void apply(JSONObject r, JSONObject c) {
        JSONArray arr = r.optJSONArray("people"); if (arr == null) return;
        long now = r.optLong("now", System.currentTimeMillis());
        JSONObject hide = c.optJSONObject("hide"), nick = c.optJSONObject("nick");
        List<CarMapRenderer.Person> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject u = arr.optJSONObject(i); if (u == null) continue;
            String id = u.optString("u");
            if (hide != null && hide.optBoolean(id, false)) continue;
            CarMapRenderer.Person p = new CarMapRenderer.Person();
            p.uid = id; p.me = u.optInt("me") == 1;
            p.name = nick != null && nick.has(id) ? nick.optString(id) : u.optString("n");
            p.lat = u.optDouble("lat"); p.lng = u.optDouble("lng");
            p.color = color(u.optString("c"), id);
            long ts = u.optLong("ts"), age = now - ts, hs = u.optLong("hs");
            double spd = u.optDouble("spd", 0);
            p.stale = age > 30 * 60000L;
            if (age < 3 * 60000L && spd >= 3) p.status = Math.round(spd) + " mph";
            else if (p.stale) p.status = ago(age);
            else if (hs > 0 && now - hs > 2 * 60000L) p.status = "parked " + ago(now - hs).replace(" ago", "");
            else p.status = "";
            out.add(p);
        }
        map.people = out;
        // Trails and pins only come on the 30-second "extra" asks; keep the last ones in between.
        JSONObject tr = r.optJSONObject("trails");
        if (tr != null) {
            Map<String, double[][]> t = new HashMap<>();
            java.util.Iterator<String> it = tr.keys();
            while (it.hasNext()) {
                String id = it.next(); JSONArray a = tr.optJSONArray(id); if (a == null) continue;
                double[][] pts = new double[a.length()][];
                for (int i = 0; i < a.length(); i++) { JSONArray q = a.optJSONArray(i); pts[i] = new double[]{ q.optDouble(0), q.optDouble(1) }; }
                t.put(id, pts);
            }
            map.trails = t;
        }
        JSONArray pa = r.optJSONArray("pins");
        if (pa != null) {
            List<double[]> pl = new ArrayList<>(); List<String> pn = new ArrayList<>();
            for (int i = 0; i < pa.length(); i++) { JSONObject q = pa.optJSONObject(i); if (q == null) continue; pl.add(new double[]{ q.optDouble("lat"), q.optDouble("lng") }); pn.add(q.optString("n")); }
            map.pins = pl; map.pinNames = pn;
        }
        aimCamera();
        map.requestDraw();
    }

    private void aimCamera() {
        if (System.currentTimeMillis() < pausedUntil) return;
        List<CarMapRenderer.Person> ps = map.people;
        if (ps.isEmpty()) return;
        CarMapRenderer.Person me = null;
        for (CarMapRenderer.Person p : ps) if (p.me) me = p;
        if (mode == MODE_ME) {
            if (me != null) map.aim(me.lat, me.lng, map.hasCamera() ? Math.max(map.tZoom, 13) : 15);
            return;
        }
        List<double[]> pts = new ArrayList<>();
        if (mode == MODE_PICKS) {
            Set<String> picks = new HashSet<>();
            JSONObject pk = cfg().optJSONObject("picks");
            JSONArray a = pk != null ? pk.optJSONArray(crewKey) : null;
            if (a != null) for (int i = 0; i < a.length(); i++) picks.add(a.optString(i));
            for (CarMapRenderer.Person p : ps) if (picks.contains(p.uid)) pts.add(new double[]{ p.lat, p.lng });
            if (pts.isEmpty() && !warnedNoPicks) {
                warnedNoPicks = true;
                CarToast.makeText(getCarContext(), "No picks for this crew yet. Use Follow my picks on your phone", CarToast.LENGTH_LONG).show();
            }
        }
        if (pts.isEmpty()) {
            // Everyone, leaving out anyone more than 100 miles from you (or from the middle).
            double aLat, aLng;
            if (me != null) { aLat = me.lat; aLng = me.lng; }
            else {
                List<Double> la = new ArrayList<>(), ln = new ArrayList<>();
                for (CarMapRenderer.Person p : ps) { la.add(p.lat); ln.add(p.lng); }
                java.util.Collections.sort(la); java.util.Collections.sort(ln);
                aLat = la.get(la.size() / 2); aLng = ln.get(ln.size() / 2);
            }
            for (CarMapRenderer.Person p : ps) if (miles(aLat, aLng, p.lat, p.lng) <= 100) pts.add(new double[]{ p.lat, p.lng });
        }
        map.fit(pts);
    }

    // ── helpers ──
    private static double miles(double a, double b, double c, double d) {
        double R = 3958.8, dLat = Math.toRadians(c - a), dLng = Math.toRadians(d - b);
        double x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(Math.toRadians(a)) * Math.cos(Math.toRadians(c)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }
    private static String ago(long ms) {
        long m = Math.max(1, ms / 60000L);
        if (m < 60) return m + " min ago";
        long h = m / 60; if (h < 48) return h + "h " + (m % 60) + "m ago";
        return (h / 24) + " days ago";
    }
    private static final int[] PALETTE = { 0xFF1F6FEB, 0xFFD73A49, 0xFF2EA043, 0xFF8957E5, 0xFFDB6D28, 0xFF0F9D9A, 0xFFBF4B8A, 0xFF6E7781 };
    private static int color(String hex, String uid) {
        try { if (hex != null && hex.matches("#?[0-9a-fA-F]{6}")) return Color.parseColor(hex.startsWith("#") ? hex : "#" + hex); } catch (Exception e) {}
        return PALETTE[Math.abs(uid.hashCode()) % PALETTE.length];
    }
}

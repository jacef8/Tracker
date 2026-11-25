package com.groundlink.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.view.Surface;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Draws the truck map onto the Android Auto surface: Esri photo tiles (plus Esri's road and name
 * layer on top), or Esri's street map, then the crew as round markers with a name/status label.
 *
 * Plain Web Mercator with 256 px tiles. The camera is (lat, lng, zoom); it eases toward a target
 * set by CarMapScreen (fit the group, the picks, or follow me). A tile that is not loaded yet is
 * drawn from a lower-zoom tile already in memory, stretched, so panning never shows black.
 */
class CarMapRenderer {
    static final String ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";

    static class Person {
        String uid, name, status; double lat, lng; int color; boolean me, stale;
    }

    // ── state ──
    private Surface surface;
    private int w, h; private float k = 1.5f;              // k = density scale (dp -> px)
    // 1.5.5: "the symbology for the roads is almost invisible especially in the forest the labels
    // are extremely small" (Jace, 2026-11-25, first real truck test). Map pictures are made for a
    // desk monitor; the truck screen reports a low density, so they were drawn 1:1 and the road
    // lines and names came out tiny. Each 256-pixel tile is now drawn at least twice as big, which
    // doubles road width and label size, and needs a quarter as many pictures per screen (faster).
    static double T = 512;
    Rect visible = new Rect(), stable = new Rect();
    double lat = 30.43, lng = -84.98, zoom = 11;          // current camera
    double tLat = lat, tLng = lng, tZoom = zoom;           // target
    boolean satellite = true;
    List<Person> people = new ArrayList<>();
    // Stage 2 (1.5.1): last hour of each person's trail, and the crew's dropped pins.
    java.util.Map<String, double[][]> trails = new java.util.HashMap<>();
    List<double[]> pins = new ArrayList<>();
    List<String> pinNames = new ArrayList<>();
    private boolean haveCam = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newFixedThreadPool(8);
    private final LruCache<String, Bitmap> tiles = new LruCache<String, Bitmap>(40 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap b) { return b.getByteCount(); }
    };
    private final Set<String> loading = new HashSet<>();
    private final Set<String> failed = new HashSet<>();
    private boolean drawQueued = false;

    private final Paint tilePaint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final Paint roadPaint = new Paint(Paint.FILTER_BITMAP_FLAG);
    {
        android.graphics.ColorMatrix cm = new android.graphics.ColorMatrix(new float[]{
            1.15f, 0, 0, 0, 0,
            0, 1.15f, 0, 0, 0,
            0, 0, 1.15f, 0, 0,
            0, 0, 0, 2.2f, 0 });
        roadPaint.setColorFilter(new android.graphics.ColorMatrixColorFilter(cm));
    }
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pill = new Paint(Paint.ANTI_ALIAS_FLAG);

    CarMapRenderer() {
        ring.setStyle(Paint.Style.STROKE);
        text.setColor(Color.WHITE);
        text.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        text.setTextAlign(Paint.Align.CENTER);
        pill.setColor(0xE6101417);
    }

    void setSurface(Surface s, int width, int height, int dpi) {
        surface = s; w = width; h = height; k = Math.max(1.4f, dpi / 160f);
        double mag = Math.max(2.0, Math.min(3.0, dpi / 160.0 * 1.5));
        if (Math.abs(256 * mag - T) > 1) {
            // keep the same place on screen when the scale changes
            zoom = tZoom = zoom + Math.log(T / (256 * mag)) / Math.log(2);
            T = 256 * mag;
        }
        if (visible.isEmpty()) visible.set(0, 0, w, h);
        if (stable.isEmpty()) stable.set(0, 0, w, h);
        requestDraw();
    }
    void clearSurface() { surface = null; }
    boolean hasCamera() { return haveCam; }

    // ── projection (world pixels at zoom z) ──
    static double wx(double lng, double z) { return (lng + 180.0) / 360.0 * T * Math.pow(2, z); }
    static double wy(double lat, double z) {
        double s = Math.sin(Math.toRadians(Math.max(-85, Math.min(85, lat))));
        return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * T * Math.pow(2, z);
    }
    static double lngOf(double x, double z) { return x / (T * Math.pow(2, z)) * 360.0 - 180.0; }
    static double latOf(double y, double z) {
        double n = Math.PI - 2.0 * Math.PI * y / (T * Math.pow(2, z));
        return Math.toDegrees(Math.atan(Math.sinh(n)));
    }
    private float cx() { return visible.isEmpty() ? w / 2f : visible.exactCenterX(); }
    private float cy() { return visible.isEmpty() ? h / 2f : visible.exactCenterY(); }
    float sx(double plng) { return (float) (wx(plng, zoom) - wx(lng, zoom) + cx()); }
    float sy(double plat) { return (float) (wy(plat, zoom) - wy(lat, zoom) + cy()); }

    // ── camera ──
    void jumpTo(double la, double ln, double z) { lat = tLat = la; lng = tLng = ln; zoom = tZoom = z; haveCam = true; requestDraw(); }
    void aim(double la, double ln, double z) {
        tLat = la; tLng = ln; tZoom = z;
        if (!haveCam) { jumpTo(la, ln, z); return; }
        requestDraw();
    }
    /** Fit these points into the stable area (the part no buttons cover), with room for labels. */
    void fit(List<double[]> pts) {
        if (pts.isEmpty()) return;
        if (pts.size() == 1) { aim(pts.get(0)[0], pts.get(0)[1], Math.max(tZoom, 14.5)); return; }
        double minX = 1e18, maxX = -1e18, minY = 1e18, maxY = -1e18;
        for (double[] p : pts) {
            double x = wx(p[1], 0), y = wy(p[0], 0);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        Rect a = stable.isEmpty() ? new Rect(0, 0, w, h) : stable;
        float padX = 46 * k, padTop = 34 * k, padBot = 52 * k;      // marker radius + label below
        double aw = Math.max(80, a.width() - 2 * padX), ah = Math.max(80, a.height() - padTop - padBot);
        double dx = Math.max(1e-9, maxX - minX), dy = Math.max(1e-9, maxY - minY);
        double z = Math.log(Math.min(aw / dx, ah / dy)) / Math.log(2);
        z = Math.max(3, Math.min(16, z));
        // Centre the box in the stable area (shifted for the label room), then express that as
        // the camera centre, which sits in the middle of the visible area.
        double bcx = (minX + maxX) / 2 * Math.pow(2, z), bcy = (minY + maxY) / 2 * Math.pow(2, z);
        double scx = a.exactCenterX(), scy = a.exactCenterY() + (padTop - padBot) / 2;
        double camX = bcx - (scx - cx()), camY = bcy - (scy - cy());
        aim(latOf(camY, z), lngOf(camX, z), z);
    }
    void panBy(float dx, float dy) {
        double x = wx(lng, zoom) + dx, y = wy(lat, zoom) + dy;
        lng = tLng = lngOf(x, zoom); lat = tLat = latOf(y, zoom); tZoom = zoom; requestDraw();
    }
    void zoomBy(double dz, float fx, float fy) {
        double nz = Math.max(3, Math.min(18, zoom + dz));
        if (Float.isNaN(fx) || fx < 0) { fx = cx(); fy = cy(); }
        // keep the point under the fingers still
        double gx = wx(lng, zoom) + (fx - cx()), gy = wy(lat, zoom) + (fy - cy());
        double glng = lngOf(gx, zoom), glat = latOf(gy, zoom);
        double nx = wx(glng, nz) - (fx - cx()), ny = wy(glat, nz) - (fy - cy());
        zoom = tZoom = nz; lng = tLng = lngOf(nx, nz); lat = tLat = latOf(ny, nz);
        requestDraw();
    }
    /** Person under a tap, or null. */
    Person hit(float x, float y) {
        Person best = null; float bd = 34 * k;
        for (Person p : people) {
            float d = (float) Math.hypot(sx(p.lng) - x, sy(p.lat) - y);
            if (d < bd) { bd = d; best = p; }
        }
        return best;
    }

    // ── drawing ──
    void requestDraw() {
        if (drawQueued) return;
        drawQueued = true;
        main.postDelayed(this::frame, 33);
    }
    private void frame() {
        drawQueued = false;
        boolean moving = false;
        if (haveCam) {
            double f = 0.18;
            if (Math.abs(tZoom - zoom) > 0.002) { zoom += (tZoom - zoom) * f; moving = true; } else zoom = tZoom;
            double ex = wx(tLng, zoom) - wx(lng, zoom), ey = wy(tLat, zoom) - wy(lat, zoom);
            if (Math.abs(ex) > 0.5 || Math.abs(ey) > 0.5) {
                lng = lngOf(wx(lng, zoom) + ex * f, zoom); lat = latOf(wy(lat, zoom) + ey * f, zoom); moving = true;
            } else { lat = tLat; lng = tLng; }
        }
        draw();
        if (moving) requestDraw();
    }
    private void draw() {
        Surface s = surface; if (s == null || !s.isValid()) return;
        Canvas c = null;
        try {
            c = s.lockHardwareCanvas();
            c.drawColor(0xFF1B2A1E);
            drawTiles(c);
            drawTrails(c);
            drawPins(c);
            drawPeople(c);
        } catch (Exception e) {
        } finally {
            if (c != null) try { s.unlockCanvasAndPost(c); } catch (Exception e) {}
        }
    }

    private String[] layers() {
        return satellite ? new String[]{ "World_Imagery", "Reference/World_Transportation" } : new String[]{ "World_Street_Map" };
    }
    private void drawTiles(Canvas c) {
        int tz = (int) Math.max(2, Math.min(18, Math.round(zoom)));
        double scale = Math.pow(2, zoom - tz);
        double ts = T * scale;
        double ox = wx(lng, tz) * scale - cx(), oy = wy(lat, tz) * scale - cy();   // world px (at zoom) of screen 0,0
        int x0 = (int) Math.floor(ox / ts), y0 = (int) Math.floor(oy / ts);
        int x1 = (int) Math.floor((ox + w) / ts), y1 = (int) Math.floor((oy + h) / ts);
        int n = 1 << tz;
        for (String layer : layers()) {
            for (int ty = y0; ty <= y1; ty++) {
                if (ty < 0 || ty >= n) continue;
                for (int tx = x0; tx <= x1; tx++) {
                    int wxp = ((tx % n) + n) % n;
                    RectF dst = new RectF((float) (tx * ts - ox), (float) (ty * ts - oy), (float) ((tx + 1) * ts - ox), (float) ((ty + 1) * ts - oy));
                    Bitmap b = tile(layer, tz, wxp, ty, true);
                    Paint tp = layer.startsWith("Reference") ? roadPaint : tilePaint;
                    if (b != null) { c.drawBitmap(b, null, dst, tp); continue; }
                    // stretch a parent tile while this one loads
                    for (int up = 1; up <= 5 && tz - up >= 0; up++) {
                        int pz = tz - up, px = wxp >> up, py = ty >> up;
                        Bitmap pb = tile(layer, pz, px, py, false);
                        if (pb == null) continue;
                        int span = 1 << up, sub = 256 / span;
                        int ix = (wxp - (px << up)) * sub, iy = (ty - (py << up)) * sub;
                        c.drawBitmap(pb, new Rect(ix, iy, ix + sub, iy + sub), dst, tp);
                        break;
                    }
                }
            }
        }
    }
    private Bitmap tile(String layer, int z, int x, int y, boolean fetch) {
        String key = layer + "/" + z + "/" + y + "/" + x;
        Bitmap b = tiles.get(key);
        if (b != null || !fetch) return b;
        if (loading.contains(key) || failed.contains(key)) return null;
        loading.add(key);
        net.execute(() -> {
            Bitmap got = null;
            try {
                HttpURLConnection con = (HttpURLConnection) new URL(ESRI + layer + "/MapServer/tile/" + z + "/" + y + "/" + x).openConnection();
                con.setConnectTimeout(8000); con.setReadTimeout(12000); con.setUseCaches(true);
                if (con.getResponseCode() == 200) { try (InputStream in = con.getInputStream()) { got = BitmapFactory.decodeStream(in); } }
                con.disconnect();
            } catch (Exception e) {}
            final Bitmap fb = got;
            main.post(() -> {
                loading.remove(key);
                if (fb != null) { tiles.put(key, fb); requestDraw(); }
                else { failed.add(key); main.postDelayed(() -> failed.remove(key), 20000); }
            });
        });
        return null;
    }

    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final android.graphics.Path path = new android.graphics.Path();
    /** Each person's last hour as a line in their colour, on a dark casing so it shows on the photo. */
    private void drawTrails(Canvas c) {
        if (trails.isEmpty()) return;
        line.setStyle(Paint.Style.STROKE); line.setStrokeCap(Paint.Cap.ROUND); line.setStrokeJoin(Paint.Join.ROUND);
        for (Person p : people) {
            double[][] t = trails.get(p.uid);
            if (t == null || t.length < 2) continue;
            path.reset();
            for (int i = 0; i < t.length; i++) {
                float x = sx(t[i][1]), y = sy(t[i][0]);
                if (i == 0) path.moveTo(x, y); else path.lineTo(x, y);
            }
            path.lineTo(sx(p.lng), sy(p.lat));      // join the line to where they are now
            line.setColor(0x99101417); line.setStrokeWidth(7 * k); c.drawPath(path, line);
            line.setColor(p.stale ? 0xFF9AA4AE : p.color); line.setStrokeWidth(4 * k); c.drawPath(path, line);
        }
    }
    /** Dropped pins: gold diamonds (round = person, diamond = place), names when zoomed in. */
    private void drawPins(Canvas c) {
        if (pins.isEmpty()) return;
        float d = 8 * k;
        boolean names = zoom >= 13.5;
        text.setTextSize(12 * k);
        for (int i = 0; i < pins.size(); i++) {
            double[] q = pins.get(i);
            float x = sx(q[1]), y = sy(q[0]);
            if (x < -40 * k || y < -40 * k || x > w + 40 * k || y > h + 40 * k) continue;
            path.reset(); path.moveTo(x, y - d); path.lineTo(x + d, y); path.lineTo(x, y + d); path.lineTo(x - d, y); path.close();
            fill.setColor(0xFFF0A500); c.drawPath(path, fill);
            ring.setColor(Color.WHITE); ring.setStrokeWidth(2f * k); c.drawPath(path, ring);
            String n = i < pinNames.size() ? pinNames.get(i) : "";
            if (names && n != null && !n.isEmpty()) {
                float tw = text.measureText(n);
                RectF bg = new RectF(x - tw / 2 - 5 * k, y + d + 3 * k, x + tw / 2 + 5 * k, y + d + 20 * k);
                c.drawRoundRect(bg, 6 * k, 6 * k, pill);
                c.drawText(n, x, bg.bottom - 4.5f * k, text);
            }
        }
    }

    private void drawPeople(Canvas c) {
        float r = 17 * k;
        // others first, me on top
        List<Person> order = new ArrayList<>();
        for (Person p : people) if (!p.me) order.add(p);
        for (Person p : people) if (p.me) order.add(p);
        for (Person p : order) {
            float x = sx(p.lng), y = sy(p.lat);
            if (x < -60 * k || y < -60 * k || x > w + 60 * k || y > h + 60 * k) continue;
            fill.setColor(p.stale ? 0xFF7D8590 : p.color);
            c.drawCircle(x, y, r, fill);
            ring.setColor(p.me ? 0xFFF0A500 : Color.WHITE);
            ring.setStrokeWidth((p.me ? 4f : 2.5f) * k);
            c.drawCircle(x, y, r, ring);
            text.setTextSize(16 * k);
            String ini = p.name == null || p.name.isEmpty() ? "?" : p.name.substring(0, 1).toUpperCase(Locale.US);
            c.drawText(ini, x, y + 5.5f * k, text);
            String lbl = p.me ? "You" : p.name;
            if (p.status != null && !p.status.isEmpty()) lbl = lbl + " · " + p.status;
            text.setTextSize(13 * k);
            float tw = text.measureText(lbl);
            RectF bg = new RectF(x - tw / 2 - 7 * k, y + r + 4 * k, x + tw / 2 + 7 * k, y + r + 24 * k);
            c.drawRoundRect(bg, 8 * k, 8 * k, pill);
            c.drawText(lbl, x, bg.bottom - 5.5f * k, text);
        }
    }

    void shutdown() { net.shutdownNow(); main.removeCallbacksAndMessages(null); }
}

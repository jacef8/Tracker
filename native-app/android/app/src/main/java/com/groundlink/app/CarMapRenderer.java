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
import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
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
        // 1.5.6: "when pins are moving they seem to be moving in little spurts ... like jumps not
        // smooth movement" (Jace, 2026-11-26). lat/lng is now the DRAWN spot, worked out every frame
        // from the last fix (fLat/fLng, its time on this phone's clock fixAt), the speed vector
        // (degrees per ms) and a correction (oLat/oLng) that fades out over BLEND_MS when a new fix
        // lands somewhere other than where the dot had got to.
        double fLat, fLng, vLat, vLng, oLat, oLng; long fx, fixAt, corrAt;
    }
    static final long EXTRAP_MS = 8000, BLEND_MS = 1200;
    /** Where to draw p at time now: the fix, carried forward at its speed for up to 8 s, plus the
     *  fading correction. With no speed this is just the fix. */
    static void place(Person p, long now) {
        double dt = Math.max(0, Math.min(EXTRAP_MS, now - p.fixAt));
        double la = p.fLat + p.vLat * dt, ln = p.fLng + p.vLng * dt;
        double b = p.corrAt > 0 ? 1.0 - (now - p.corrAt) / (double) BLEND_MS : 0;
        if (b > 0) { la += p.oLat * b; ln += p.oLng * b; }
        p.lat = la; p.lng = ln;
    }
    static boolean animating(Person p, long now) {
        return ((p.vLat != 0 || p.vLng != 0) && now - p.fixAt < EXTRAP_MS) || (p.corrAt > 0 && now - p.corrAt < BLEND_MS);
    }
    static void copyMotion(Person from, Person to) {
        to.fLat = from.fLat; to.fLng = from.fLng; to.vLat = from.vLat; to.vLng = from.vLng;
        to.oLat = from.oLat; to.oLng = from.oLng; to.fx = from.fx; to.fixAt = from.fixAt; to.corrAt = from.corrAt;
        to.lat = from.lat; to.lng = from.lng;
    }
    /** Run once per frame before drawing (the screen keeps the camera on moving dots with it). */
    Runnable onFrame = null;

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
    // 1.5.8: "the truck screen is very plain and boring" (Jace, 2026-11-28). He picked the mock-up
    // with: profile photos on the dots, a heading arrow on anyone moving, speed / "parked 4 min"
    // in the tag, your own dot bigger and gold, a crew card (top left), a "Closest" readout
    // (bottom left) and the crew's own road names in dark tags.
    String crewName = "";
    /** uid -> profile photo, already cropped square. */
    final java.util.Map<String, Bitmap> photos = new java.util.HashMap<>();
    List<double[][]> crewRoads = new ArrayList<>();   // each [lng,lat] points
    List<String> crewRoadNames = new ArrayList<>();
    List<double[]> nameMids = new ArrayList<>();       // [lng,lat] of a renamed stretch
    List<String> nameTxt = new ArrayList<>();
    static final int GOLD = 0xFFF0A500;
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
        boolean same = Math.abs(la - tLat) < 1e-7 && Math.abs(ln - tLng) < 1e-7 && Math.abs(z - tZoom) < 1e-4;
        tLat = la; tLng = ln; tZoom = z;
        if (!haveCam) { jumpTo(la, ln, z); return; }
        if (!same) requestDraw();      // called every frame now; an unchanged aim must not keep the loop alive
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
        float padX = 46 * k, padTop = 58 * k, padBot = 62 * k;      // marker + label, clear of the crew card and Closest bar
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
            float[] o = drawnOff.get(p.uid);
            float d = (float) Math.hypot(sx(p.lng) + (o == null ? 0 : o[0]) - x, sy(p.lat) + (o == null ? 0 : o[1]) - y);
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
        long now = System.currentTimeMillis();
        for (Person p : people) { place(p, now); if (animating(p, now)) moving = true; }
        if (onFrame != null) try { onFrame.run(); } catch (Exception e) {}
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
            // 1.5.9: each layer on its own. 1.5.8 crashed the whole app on the truck (2026-11-28):
            // a layer that threw while a clip was saved left the canvas unbalanced, which the
            // hardware renderer does not survive. Now a failing layer is put back to its saved
            // state, skipped, and reported once, and the map keeps drawing.
            layer(c, 0); layer(c, 1); layer(c, 2); layer(c, 3); layer(c, 5); layer(c, 4);
        } catch (Throwable e) {
            reportOnce("draw", e);
        } finally {
            if (c != null) try { s.unlockCanvasAndPost(c); } catch (Throwable e) { reportOnce("post", e); }
            if (!drawnOnce && c != null) { drawnOnce = true; try { CarLog.step("first frame drawn, photos " + photos.size()); } catch (Throwable t) {} }
        }
    }

    private final Set<String> reported = new HashSet<>();
    private void reportOnce(String where, Throwable e) {
        if (reported.add(where)) { try { CarLog.error("draw " + where, e); } catch (Throwable t) {} }
    }
    private final boolean[] layerOff = new boolean[6];
    private int layerFails[] = new int[6];
    private void layer(Canvas c, int i) {
        if (layerOff[i]) return;
        int sc = c.save();
        try {
            switch (i) {
                case 0: drawTiles(c); break;
                case 1: drawCrewRoads(c); break;
                case 2: drawTrails(c); break;
                case 3: drawPins(c); break;
                case 4: drawPeople(c); break;
                default: drawHud(c); break;
            }
        } catch (Throwable e) {
            reportOnce("layer" + i, e);
            if (++layerFails[i] >= 5 && i != 0 && i != 4) layerOff[i] = true;   // give up on an extra, never on the map or the people
        } finally {
            try { c.restoreToCount(sc); } catch (Throwable t) {}
        }
    }
    private boolean drawnOnce = false;

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
                    boolean miss = failed.contains(layer + "/" + tz + "/" + ty + "/" + wxp);
                    for (int up = 1; up <= 5 && tz - up >= 0; up++) {
                        int pz = tz - up, px = wxp >> up, py = ty >> up;
                        Bitmap pb = tile(layer, pz, px, py, miss);
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
    // 1.5.10: "Does the auto version use offline maps?" (Jace, 2026-11-28). It only had a short-lived
    // web cache, so in a dead zone the map went blank. Every map picture the truck shows is now kept
    // on the phone (up to about 400 MB, oldest dropped first) and read from there first, so any
    // place the truck has already shown still draws with no signal.
    static File tileDir;
    private static File tileFile(String layer, int z, int x, int y) {
        if (tileDir == null) return null;
        return new File(tileDir, layer.replace('/', '_') + "/" + z + "/" + y + "/" + x + ".t");
    }
    private Bitmap tile(String layer, int z, int x, int y, boolean fetch) {
        String key = layer + "/" + z + "/" + y + "/" + x;
        Bitmap b = tiles.get(key);
        if (b != null || !fetch) return b;
        if (loading.contains(key) || failed.contains(key)) return null;
        loading.add(key);
        net.execute(() -> {
            Bitmap got = null;
            File f = tileFile(layer, z, x, y);
            try {
                if (f != null && f.length() > 0) { got = BitmapFactory.decodeFile(f.getPath()); if (got != null) f.setLastModified(System.currentTimeMillis()); }
            } catch (Throwable e) {}
            if (got == null) try {
                HttpURLConnection con = (HttpURLConnection) new URL(ESRI + layer + "/MapServer/tile/" + z + "/" + y + "/" + x).openConnection();
                con.setConnectTimeout(8000); con.setReadTimeout(12000); con.setUseCaches(true);
                if (con.getResponseCode() == 200) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    try (InputStream in = con.getInputStream()) { byte[] buf = new byte[16384]; int r; while ((r = in.read(buf)) > 0) bo.write(buf, 0, r); }
                    byte[] bytes = bo.toByteArray();
                    got = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (got != null && f != null) try {
                        f.getParentFile().mkdirs();
                        File tmp = new File(f.getPath() + ".part");
                        try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(bytes); }
                        tmp.renameTo(f);
                    } catch (Throwable e) {}
                }
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
            line.setColor(p.me ? GOLD : (p.stale ? 0xFF9AA4AE : p.color)); line.setStrokeWidth((p.me ? 5 : 4) * k); c.drawPath(path, line);
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

    // 1.5.7: "These aren't showing the same info" (Jace, 2026-11-27). Gary and J stood 18 ft apart:
    // the phone showed one G | J bubble, the truck drew two dots on one spot with their name tags
    // printed over each other ("Gary J :Gee"). Same rules as the phone app now (builds 1047/1097):
    //  - people within 50 ft, or within ~1,300 ft whose dots would overlap, become ONE marker with a
    //    face for each (up to 4) and one tag like "Gary & J"; it sits on you if you are in it,
    //    otherwise on the freshest fix;
    //  - people further apart stay separate, and if their markers still overlap they are eased apart
    //    (at most 40 px) with a thin line back to where each really is. Only when zoomed so far out
    //    that their dots sit almost exactly on top of each other are they combined anyway.
    static final double TOGETHER_M = 15, NEAR_M = 400;
    /** uid -> how far its marker was moved from its true spot this frame, for taps. */
    final java.util.Map<String, float[]> drawnOff = new java.util.HashMap<>();
    static double metres(double la1, double ln1, double la2, double ln2) {
        double a = (la2 - la1) * 111320.0, b = (ln2 - ln1) * 111320.0 * Math.cos(Math.toRadians(la1));
        return Math.hypot(a, b);
    }
    private static String first(String n) {
        if (n == null || n.trim().isEmpty()) return "?";
        String t = n.trim(); int sp = t.indexOf(' '); return sp > 0 ? t.substring(0, sp) : t;
    }
    private static int root(int[] par, int i) { while (par[i] != i) { par[i] = par[par[i]]; i = par[i]; } return i; }
    private static String initial(Person p) { return p.name == null || p.name.isEmpty() ? "?" : p.name.substring(0, 1).toUpperCase(Locale.US); }

    /** Where markers and tags were drawn (last frame), so the crew card and Closest bar can get out of the way. */
    private List<RectF> markRects = new ArrayList<>(), lastMarks = new ArrayList<>();
    private boolean underMarks(RectF box) { for (RectF m : lastMarks) if (RectF.intersects(m, box)) return true; return false; }
    private void drawPeople(Canvas c) {
        markRects = new ArrayList<>(); closeCand.clear();
        try { drawPeople0(c); } finally { lastMarks = markRects; lastCand = new ArrayList<>(closeCand); }
    }
    private List<Object[]> lastCand = new ArrayList<>();
    private void drawPeople0(Canvas c) {
        float r = 17 * k;
        List<Person> vis = new ArrayList<>();
        for (Person p : people) {
            float x = sx(p.lng), y = sy(p.lat);
            if (x < -80 * k || y < -80 * k || x > w + 80 * k || y > h + 80 * k) continue;
            vis.add(p);
        }
        int n = vis.size();
        int[] par = new int[n];
        float[] px = new float[n], py = new float[n];
        for (int i = 0; i < n; i++) { par[i] = i; px[i] = sx(vis.get(i).lng); py[i] = sy(vis.get(i).lat); }
        for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) {
            Person a = vis.get(i), b = vis.get(j);
            double m = metres(a.lat, a.lng, b.lat, b.lng);
            float d = (float) Math.hypot(px[i] - px[j], py[i] - py[j]);
            boolean join = m <= TOGETHER_M || (m <= NEAR_M && d < 2 * r + 6 * k) || d < 6 * k;
            if (join) { int ra = root(par, i), rb = root(par, j); if (ra != rb) par[ra] = rb; }
        }
        java.util.Map<Integer, List<Integer>> gs = new java.util.LinkedHashMap<>();
        for (int i = 0; i < n; i++) {
            int ro = root(par, i); List<Integer> l = gs.get(ro);
            if (l == null) { l = new ArrayList<>(); gs.put(ro, l); }
            l.add(i);
        }
        // Each group: [anchor, members in face order]. Anchor = you, else a live fix, else the freshest.
        List<int[]> groups = new ArrayList<>();
        for (List<Integer> l : gs.values()) {
            int anc = l.get(0);
            for (int i : l) {
                Person p = vis.get(i), q = vis.get(anc);
                if (q.me) break;
                if (p.me || (q.stale && !p.stale) || (p.stale == q.stale && p.fixAt > q.fixAt)) anc = i;
            }
            int[] g = new int[l.size() + 1]; g[0] = anc; int t = 1;
            if (vis.get(anc).me) g[t++] = anc;
            for (int i : l) if (!(vis.get(anc).me && i == anc)) g[t++] = i;
            groups.add(g);
        }
        int G = groups.size();
        float[] gx = new float[G], gy = new float[G], ox = new float[G], oy = new float[G], hw = new float[G];
        for (int g = 0; g < G; g++) {
            int a = groups.get(g)[0]; gx[g] = px[a]; gy[g] = py[a];
            int cnt = Math.min(groups.get(g).length - 1, 4);
            hw[g] = cnt > 1 ? cnt * r * 0.95f : r;
        }
        // Ease apart markers that still overlap: separate people, so they are NOT combined.
        float maxOff = 40 * k;
        for (int pass = 0; pass < 4; pass++) {
            for (int i = 0; i < G; i++) for (int j = i + 1; j < G; j++) {
                float dx = (gx[j] + ox[j]) - (gx[i] + ox[i]), dy = (gy[j] + oy[j]) - (gy[i] + oy[i]);
                float need = hw[i] + hw[j] + 4 * k;
                float d = (float) Math.hypot(dx, dy);
                if (d >= need) continue;
                if (d < 0.01f) { dx = (i % 2 == 0) ? 1 : -1; dy = 1; d = 1.414f; }
                float push = (need - d) / 2, ux = dx / d, uy = dy / d;
                ox[i] -= ux * push; oy[i] -= uy * push; ox[j] += ux * push; oy[j] += uy * push;
            }
        }
        drawnOff.clear();
        for (int g = 0; g < G; g++) {
            float m = (float) Math.hypot(ox[g], oy[g]);
            if (m > maxOff) { ox[g] = ox[g] / m * maxOff; oy[g] = oy[g] / m * maxOff; }
            int[] gr = groups.get(g);
            for (int t = 1; t < gr.length; t++) {
                drawnOff.put(vis.get(gr[t]).uid, new float[]{ gx[g] + ox[g] - px[gr[t]], gy[g] + oy[g] - py[gr[t]] });
            }
        }
        // A thin line from each moved marker back to its true spot.
        line.setStyle(Paint.Style.STROKE); line.setStrokeWidth(2f * k); line.setColor(0xCCFFFFFF);
        for (int g = 0; g < G; g++) {
            if (Math.hypot(ox[g], oy[g]) < 10 * k) continue;
            c.drawLine(gx[g], gy[g], gx[g] + ox[g], gy[g] + oy[g], line);
            fill.setColor(Color.WHITE); c.drawCircle(gx[g], gy[g], 3 * k, fill);
        }
        // Others first, the marker holding you last (on top).
        List<Integer> order = new ArrayList<>();
        for (int g = 0; g < G; g++) if (!vis.get(groups.get(g)[0]).me) order.add(g);
        for (int g = 0; g < G; g++) if (vis.get(groups.get(g)[0]).me) order.add(g);
        for (int g : order) {
            int[] gr = groups.get(g);
            float x = gx[g] + ox[g], y = gy[g] + oy[g];
            String lbl;
            if (gr.length == 2) {
                Person p = vis.get(gr[1]);
                // Quiet people (no report in 30+ min) are drawn smaller with only a small age badge:
                // full names and "2h 13m ago" tags were covering the map (Jace, 2026-11-28).
                float rr = p.me ? 21 * k : (p.stale ? 13 * k : r);
                drawArrow(c, p, x, y, rr);
                drawFace(c, p, x - rr, y - rr, x + rr, y + rr, true, 18 * k);
                ring.setColor(p.me ? GOLD : Color.WHITE);
                ring.setStrokeWidth((p.me ? 4.5f : 3f) * k);
                c.drawCircle(x, y, rr, ring);
                markRects.add(new RectF(x - rr - 4 * k, y - rr - 4 * k, x + rr + 4 * k, y + rr + 4 * k));
                if (!p.me) closeCand.add(new Object[]{ first(p.name), p.lat, p.lng, !p.stale });
                if (p.stale) { ageBadge(c, x + rr * 0.8f, y - rr * 0.8f, p.status); continue; }
                drawTag(c, x, y + rr, p.me ? "You" : first(p.name), p.status, p.me, false);
                continue;
            } else {
                boolean hasMe = false;
                for (int t = 1; t < gr.length; t++) if (vis.get(gr[t]).me) hasMe = true;
                int cnt = Math.min(gr.length - 1, 4);
                float half = hw[g];
                RectF box = new RectF(x - half, y - r, x + half, y + r);
                android.graphics.Path clip = new android.graphics.Path();
                clip.addRoundRect(box, r, r, android.graphics.Path.Direction.CW);
                c.save(); c.clipPath(clip);
                float cw = (2 * half) / cnt;
                text.setTextSize(15 * k);
                for (int t = 0; t < cnt; t++) {
                    Person p = vis.get(gr[t + 1]);
                    drawFace(c, p, box.left + t * cw, box.top, box.left + (t + 1) * cw, box.bottom, false, 15 * k);
                }
                c.restore();
                ring.setColor(hasMe ? 0xFFF0A500 : Color.WHITE);
                ring.setStrokeWidth((hasMe ? 4f : 2.5f) * k);
                c.drawRoundRect(box, r, r, ring);
                markRects.add(new RectF(box.left - 4 * k, box.top - 4 * k, box.right + 4 * k, box.bottom + 4 * k));
                StringBuilder sb = new StringBuilder();
                int names = Math.min(gr.length - 1, 3);
                for (int t = 1; t <= names; t++) {
                    Person p = vis.get(gr[t]);
                    if (t > 1) sb.append(t == names && gr.length - 1 <= 3 ? " & " : ", ");
                    sb.append(p.me ? "You" : first(p.name));
                }
                if (gr.length - 1 > 3) sb.append(" +").append(gr.length - 4);
                // A shared status (the same speed, say) only when everyone in it agrees.
                String st = vis.get(gr[1]).status;
                boolean same = st != null && !st.isEmpty();
                for (int t = 2; t < gr.length && same; t++) same = st.equals(vis.get(gr[t]).status);
                lbl = sb.toString();
                drawTag(c, x, y + r, lbl, same ? st : "", hasMe, false);
            }
            // Remember for the Closest readout.
            if (!hasMeIn(vis, gr)) {
                Person a = vis.get(gr[0]);
                String nm = gr.length == 2 ? a.name : lbl;
                boolean live = false; for (int t = 1; t < gr.length; t++) if (!vis.get(gr[t]).stale) live = true;
                closeCand.add(new Object[]{ nm, a.lat, a.lng, live });
            }
        }
    }
    private final List<Object[]> closeCand = new ArrayList<>();
    private static boolean hasMeIn(List<Person> vis, int[] gr) { for (int t = 1; t < gr.length; t++) if (vis.get(gr[t]).me) return true; return false; }

    /** A face: the photo cropped to fill the box, else the person's colour and initial. Round when
     *  `round`, otherwise the caller has already clipped (a cell of a group marker). */
    private final Paint bmp = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final android.graphics.Path fpath = new android.graphics.Path();
    private void drawFace(Canvas c, Person p, float l, float t, float rgt, float b, boolean round, float ts) {
        Bitmap ph = photos.get(p.uid);
        if (round) { fpath.reset(); fpath.addCircle((l + rgt) / 2, (t + b) / 2, (rgt - l) / 2, android.graphics.Path.Direction.CW); c.save(); c.clipPath(fpath); }
        if (ph != null && !ph.isRecycled()) {
            float bw = rgt - l, bh = b - t;
            int sw = ph.getWidth(), sh = ph.getHeight();
            float sc = Math.max(bw / sw, bh / sh);
            float cw = bw / sc, ch = bh / sc;
            Rect src = new Rect((int) ((sw - cw) / 2), (int) ((sh - ch) / 2), (int) ((sw + cw) / 2), (int) ((sh + ch) / 2));
            bmp.setAlpha(p.stale ? 140 : 255);
            fill.setColor(0xFF2A2F36); c.drawRect(l, t, rgt, b, fill);
            c.drawBitmap(ph, src, new RectF(l, t, rgt, b), bmp);
        } else {
            fill.setColor(p.stale ? 0xFF7D8590 : p.color);
            c.drawRect(l, t, rgt, b, fill);
            text.setTextSize(ts);
            c.drawText(initial(p), (l + rgt) / 2, (t + b) / 2 + ts * 0.36f, text);
        }
        if (round) c.restore();
    }
    /** A wedge just outside the ring pointing the way someone is going (only while moving). */
    private void drawArrow(Canvas c, Person p, float x, float y, float rr) {
        if (p.stale || (p.vLat == 0 && p.vLng == 0)) return;
        double ang = Math.atan2(p.vLng * Math.cos(Math.toRadians(p.lat)), p.vLat);   // 0 = north, clockwise
        float d0 = rr + 2 * k, d1 = rr + 14 * k, wv = 8 * k;
        float sx0 = (float) Math.sin(ang), cy0 = (float) -Math.cos(ang);
        float px = -cy0, py = sx0;   // perpendicular
        path.reset();
        path.moveTo(x + sx0 * d1, y + cy0 * d1);
        path.lineTo(x + sx0 * d0 + px * wv, y + cy0 * d0 + py * wv);
        path.lineTo(x + sx0 * d0 - px * wv, y + cy0 * d0 - py * wv);
        path.close();
        fill.setColor(p.me ? GOLD : Color.WHITE); c.drawPath(path, fill);
        ring.setColor(0xFF101417); ring.setStrokeWidth(1.5f * k); c.drawPath(path, ring);
    }
    /** Name tag under a marker: name in white, then the status coloured by what it says. You get a
     *  gold tag. */
    private void ageBadge(Canvas c, float x, float y, String st) {
        String t = st == null ? "" : st.trim(); int sp = t.indexOf(' '); if (sp > 0) t = t.substring(0, sp);
        if (t.isEmpty()) return;
        Paint.Align al = text.getTextAlign(); int col = text.getColor();
        text.setTextAlign(Paint.Align.CENTER); text.setTextSize(11 * k); text.setFakeBoldText(true);
        float tw = text.measureText(t);
        RectF bg = new RectF(x - tw / 2 - 5 * k, y - 9 * k, x + tw / 2 + 5 * k, y + 9 * k);
        fill.setColor(0xF0101417); c.drawRoundRect(bg, 9 * k, 9 * k, fill);
        text.setColor(0xFFC9D1D9); c.drawText(t, x, y + 4 * k, text);
        text.setFakeBoldText(false); text.setTextAlign(al); text.setColor(col);
    }
    private void drawTag(Canvas c, float x, float yb, String name, String st, boolean me, boolean stale) {
        // Speed only: "parked 4 min" and ages made the tags too long to see the map past.
        if (st != null && !st.endsWith("mph")) st = "";
        if (zoom < 10.5 && !me) st = "";
        String a = name == null ? "" : name, b = (st == null || st.isEmpty()) ? "" : " · " + st;
        // 1.5.10: the size was never set here, so each tag took whatever the last drawing used
        // (the big initial letter, a road tag...) and tags came out different sizes (Jace, 2026-11-28).
        text.setTextSize(15 * k);
        text.setFakeBoldText(true);
        float wa = text.measureText(a);
        text.setFakeBoldText(false);
        float wb = b.isEmpty() ? 0 : text.measureText(b);
        float tw = wa + wb;
        RectF bg = new RectF(x - tw / 2 - 8 * k, yb + 4 * k, x + tw / 2 + 8 * k, yb + 26 * k);
        Paint bgp = me ? goldPill : pill;
        c.drawRoundRect(bg, 10 * k, 10 * k, bgp);
        float base = bg.bottom - 6 * k, left = x - tw / 2;
        markRects.add(new RectF(bg));
        Paint.Align al = text.getTextAlign();
        int col = text.getColor();
        text.setTextAlign(Paint.Align.LEFT);
        text.setFakeBoldText(true);
        text.setColor(me ? 0xFF2A1D00 : (stale ? 0xFFC9D1D9 : Color.WHITE));
        c.drawText(a, left, base, text);
        text.setFakeBoldText(false);
        if (!b.isEmpty()) {
            int sc = me ? 0xFF2A1D00 : stale ? 0xFFAEB7C2 : (st.startsWith("parked") ? 0xFF8FD18A : 0xFFFFD54A);
            text.setColor(sc);
            c.drawText(b, left + wa, base, text);
        }
        text.setColor(col); text.setTextAlign(al);
    }
    private final Paint goldPill = new Paint(Paint.ANTI_ALIAS_FLAG);
    { goldPill.setColor(GOLD); }

    /** The crew's own roads (drawn by hand) in orange, and names they gave existing stretches. */
    private void drawCrewRoads(Canvas c) {
        line.setStyle(Paint.Style.STROKE); line.setStrokeCap(Paint.Cap.ROUND); line.setStrokeJoin(Paint.Join.ROUND);
        for (double[][] rd : crewRoads) {
            path.reset();
            for (int i = 0; i < rd.length; i++) { float x = sx(rd[i][0]), y = sy(rd[i][1]); if (i == 0) path.moveTo(x, y); else path.lineTo(x, y); }
            line.setColor(0xCC101417); line.setStrokeWidth(8 * k); c.drawPath(path, line);
            line.setColor(0xFFFF9F43); line.setStrokeWidth(4.5f * k); c.drawPath(path, line);
        }
        if (zoom < 12) return;
        text.setTextAlign(Paint.Align.CENTER);
        for (int i = 0; i < crewRoads.size(); i++) {
            String n = i < crewRoadNames.size() ? crewRoadNames.get(i) : "";
            double[][] rd = crewRoads.get(i); if (n == null || n.isEmpty() || rd.length < 2) continue;
            double[] m = rd[rd.length / 2];
            roadTag(c, sx(m[0]), sy(m[1]), n, 0xFFFF9F43);
        }
        for (int i = 0; i < nameMids.size(); i++) {
            double[] m = nameMids.get(i);
            roadTag(c, sx(m[0]), sy(m[1]), nameTxt.get(i), 0xFFFFD54A);
        }
    }
    private void roadTag(Canvas c, float x, float y, String n, int col) {
        if (x < -60 * k || y < -30 * k || x > w + 60 * k || y > h + 30 * k) return;
        text.setTextSize(13 * k); text.setFakeBoldText(true);
        float tw = text.measureText(n);
        RectF bg = new RectF(x - tw / 2 - 6 * k, y - 11 * k, x + tw / 2 + 6 * k, y + 11 * k);
        fill.setColor(0xF0101417); c.drawRoundRect(bg, 5 * k, 5 * k, fill);
        int cc = text.getColor(); text.setColor(col);
        c.drawText(n, x, y + 4.5f * k, text);
        text.setColor(cc); text.setFakeBoldText(false);
    }

    /** Crew card (top left) and the Closest readout (bottom left), inside the area no button covers. */
    private void drawHud(Canvas c) {
        Rect a = stable.isEmpty() ? new Rect(0, 0, w, h) : stable;
        Paint.Align al = text.getTextAlign(); int col = text.getColor();
        text.setTextAlign(Paint.Align.LEFT);
        // crew card
        int live = 0, quiet = 0;
        for (Person p : people) { if (p.stale) quiet++; else live++; }
        String t1 = crewName == null || crewName.isEmpty() ? "Crew" : crewName;
        String t2 = live + " live" + (quiet > 0 ? " · " + quiet + " quiet" : "");
        text.setTextSize(16 * k); text.setFakeBoldText(true); float w1 = text.measureText(t1);
        text.setTextSize(13 * k); text.setFakeBoldText(false); float w2 = text.measureText(t2);
        float cl = a.left + 12 * k, ct = a.top + 12 * k;
        RectF card = new RectF(cl, ct, cl + 34 * k + Math.max(w1, w2) + 14 * k, ct + 52 * k);
        // 1.5.10: "The crew pill sits on top of other components" (Jace, 2026-11-28). The card is now
        // drawn under the people, and when someone is behind it, it turns see-through.
        boolean dim = underMarks(card);
        c.saveLayerAlpha(card, dim ? 70 : 255);
        fill.setColor(0xF0101417); c.drawRoundRect(card, 14 * k, 14 * k, fill);
        fill.setColor(live > 0 ? 0xFF5DCB6A : 0xFF7D8590); c.drawCircle(cl + 18 * k, ct + 26 * k, 6 * k, fill);
        text.setColor(Color.WHITE); text.setTextSize(16 * k); text.setFakeBoldText(true);
        c.drawText(t1, cl + 34 * k, ct + 23 * k, text);
        text.setFakeBoldText(false); text.setTextSize(13 * k); text.setColor(0xFFC9D1D9);
        c.drawText(t2, cl + 34 * k, ct + 42 * k, text);
        c.restore();
        // closest
        Person me = null; for (Person p : people) if (p.me) me = p;
        Object[] best = null; double bd = Double.MAX_VALUE;
        if (me != null) for (int pass = 0; pass < 2 && best == null; pass++) {
            for (Object[] o : lastCand) {
                if (pass == 0 && !(Boolean) o[3]) continue;
                double d = metres(me.lat, me.lng, (Double) o[1], (Double) o[2]);
                if (d < bd) { bd = d; best = o; }
            }
        }
        if (best != null) {
            double mi = bd / 1609.34;
            String dist = mi < 0.2 ? Math.round(bd * 3.28084) + " ft" : mi < 10 ? String.format(Locale.US, "%.1f mi", mi) : Math.round(mi) + " mi";
            double br = Math.toDegrees(Math.atan2(((Double) best[2] - me.lng) * Math.cos(Math.toRadians(me.lat)), (Double) best[1] - me.lat));
            if (br < 0) br += 360;
            String[] dn = { "N ↑", "NE ↗", "E →", "SE ↘", "S ↓", "SW ↙", "W ←", "NW ↖" };
            String dir = dn[(int) Math.round(br / 45) % 8];
            String nm = (String) best[0];
            text.setTextSize(16 * k); text.setFakeBoldText(true); float wn = text.measureText(nm);
            text.setTextSize(22 * k); float wd = text.measureText(dist);
            text.setTextSize(15 * k); float wr = text.measureText(dir);
            text.setFakeBoldText(false);
            float bl = a.left + 12 * k, bb = a.bottom - 12 * k;
            RectF bar = new RectF(bl, bb - 60 * k, bl + 14 * k + Math.max(wn, 60 * k) + 18 * k + wd + 12 * k + wr + 14 * k, bb);
            c.saveLayerAlpha(bar, underMarks(bar) ? 70 : 255);
            fill.setColor(0xF0101417); c.drawRoundRect(bar, 14 * k, 14 * k, fill);
            text.setTextSize(12 * k); text.setColor(0xFFC9D1D9);
            c.drawText("Closest", bl + 14 * k, bb - 40 * k, text);
            text.setTextSize(16 * k); text.setFakeBoldText(true); text.setColor(Color.WHITE);
            c.drawText(nm, bl + 14 * k, bb - 16 * k, text);
            float dx = bl + 14 * k + Math.max(wn, 60 * k) + 18 * k;
            text.setTextSize(22 * k); text.setColor(0xFFFFD54A);
            c.drawText(dist, dx, bb - 16 * k, text);
            text.setTextSize(15 * k); text.setColor(0xFFC9D1D9);
            c.drawText(dir, dx + wd + 12 * k, bb - 16 * k, text);
            text.setFakeBoldText(false);
            c.restore();
        }
        text.setTextAlign(al); text.setColor(col);
    }

    void shutdown() { net.shutdownNow(); main.removeCallbacksAndMessages(null); }
}

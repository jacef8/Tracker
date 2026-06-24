# GroundLink — Offline Maps (parcels + aerial imagery) — Scope

**Goal:** A "download this area" tool. The user selects an area on the map; within a
size cap, the app downloads the **aerial imagery** + **parcel data** for that area and
**caches it for fully-offline use** in the field (no cell signal). Swap in as many
areas as the storage budget allows.

This is a self-contained mini-project, prototyped on the **test page (`/test888`)**
first. It does NOT touch voice.

---

## 1. The hard constraint (why this is shaped the way it is)

Commercial basemaps (Mapbox, Google, Esri, Bing) **all prohibit caching their tiles
for offline use** in a web/WebView app. There is no provider to "swap to" that lets us
cache *their* imagery offline. Offline imagery is a **licensing** problem, not a
renderer problem.

**Therefore everything offline must be self-hosted, openly-licensed tiles:**
- **Imagery:** USDA **NAIP** aerial (public domain, ~0.6–1 m, US-wide, great for rural
  hunting land). Build into our own raster tiles.
- **Parcels:** FL **DOR / FGDL** county parcel data (public). Build into our own vector
  tiles (or per-area GeoJSON).

Online we can KEEP Mapbox satellite (looks great, streams). Offline we fall back to our
cached NAIP imagery for the downloaded areas. Both coexist.

---

## 2. Architecture

```
NAIP imagery  ─┐                          ┌─ Mapbox GL JS (online basemap, unchanged)
               ├─► tiles (PMTiles) ─► R2 ─┤
FL parcels    ─┘                          └─ self-hosted tiles (online + cached offline)
                                                     │
                          Service Worker caches the tiles for a downloaded area
                                                     │
                                          Offline: SW serves cached tiles
```

- **Tile format:** **PMTiles** (single-file tilesets, HTTP range requests) stored on
  **Cloudflare R2** (already used for GROUNDWAVE audio — cheap, range-friendly).
- **Renderer note / decision point:** the app uses **Mapbox GL JS v3**, which **cannot
  read PMTiles directly** (no `addProtocol`; that's a MapLibre feature). Two ways to
  feed our tiles to the current renderer:
  - **(a) Serve XYZ from PMTiles** via a tiny **Cloudflare Worker** (`{z}/{x}/{y}`), so
    Mapbox GL JS consumes a normal tile URL. ← recommended, keeps Mapbox.
  - **(b) Migrate renderer to MapLibre GL JS** (mostly API-compatible) which reads
    PMTiles natively. Bigger change; optional/future.
- **Offline caching:** the download tool computes the `{z}/{x}/{y}` tiles covering the
  selected box (for a chosen zoom range), fetches them, and stores them in the **Cache
  API** via the service worker. Offline, the SW serves them. (Works with Mapbox GL JS
  because the tiles are our own cacheable URLs — not Mapbox's.)

---

## 3. The download-area tool (UI)

1. "Download area" mode → draw a box (or use current viewport).
2. Choose detail (max zoom) → tool **estimates tile count + MB** → enforces the **cap**
   (e.g. "≈ 180 MB, over your 150 MB limit — shrink the box or lower detail").
3. Download → cache imagery + parcel tiles → mark area "available offline."
4. **Manage downloads:** list saved areas, sizes, total storage; delete to reclaim.

Imagery dominates size (raster ≫ vector parcels), so the cap + tight area select are
doing real work. You download a hunting spot/WMA, not a whole county.

---

## 4. Biggest risk → de-risk FIRST

**Does offline tile caching actually work in the Capacitor WebView with Mapbox GL JS?**
Everything depends on this. Phase 1 is a spike that proves exactly this, end to end,
before we invest in pipelines/UI.

---

## 5. Phased plan

- **Phase 1 — Offline spike (de-risk):** one small NAIP raster tileset for ONE hunting
  area → on R2 (served XYZ via Worker) → added to the test map as a raster layer → SW
  caches that area → **confirm it renders in airplane mode** in the installed app. If
  this works, the rest is additive.
- **Phase 2 — Download-area tool:** select box → size estimate + cap → download → cache
  → manage/delete. (Imagery only, the one area, then any area covered by the tileset.)
- **Phase 3 — Parcels offline:** parcel vector tiles (or per-area GeoJSON) cached the
  same way; both layers download together.
- **Phase 4 — Scale the data:** expand imagery + parcel coverage (more areas → region →
  statewide), storage management, tile-update strategy.

Each phase is independently useful.

---

## 6. Decisions / inputs needed to start Phase 1

1. **One hunting area** to seed it (rough bounds or a place/WMA name).
2. **Per-area storage cap** you'd accept (imagery makes ~100–250 MB realistic for a
   tight area).
3. **R2 access** — use the existing GROUNDWAVE R2 account (new bucket, e.g.
   `groundlink-tiles`) or a separate one?
4. Confirm **keep Mapbox online + self-hosted offline** (recommended) vs. committing to
   a **MapLibre** renderer migration now.

---

## 7. Cost / effort reality

- Real multi-phase project. Biggest costs: **imagery data volume**, **R2 storage +
  egress**, and the **tiling pipeline** (NAIP → reproject → tiles; tippecanoe for
  parcels).
- A Cloudflare **Worker** to serve PMTiles as XYZ (small, cheap).
- Pipeline is provider-independent and generalizes to other states.

# GroundLink Voice Integration — Starter Spec (GROUNDWAVE embedded)

**Purpose of this doc:** hand-off spec for Claude Code. The architecture below is already
decided — do not re-derive it or propose alternatives (especially do not propose mesh WebRTC;
see "Locked decisions"). Build to this spec. Ask before deviating.

---

## 1. What we're building

GroundLink (real-time field-tracking PWA/TWA) already lets a user tap a member on the map and
navigate to them. We are adding a second action on that same selection: **talk to them** (push-to-talk
voice), and **talk to a whole group**.

The voice capability comes from an existing, working PWA walkie-talkie app — **GROUNDWAVE**. We are
NOT rebuilding voice. We are repackaging GROUNDWAVE's voice client as a reusable same-origin module
that GroundLink imports and renders as a docked PTT bar.

GROUNDWAVE remains a separate standalone tool. Its voice **client logic** becomes a shared module
that BOTH the standalone GROUNDWAVE app and the GroundLink bar wrap. Same code, two front doors.

---

## 2. Locked decisions (do not revisit)

| Decision | Choice | One-line reason |
|---|---|---|
| Transport | **LiveKit (self-hosted on Railway)** | Group all-call must scale to ~20 people. Mesh saturates the talker's cellular uplink past ~6 (talker uploads one stream per peer). SFU = talker uploads once, server fans out. |
| Mesh? | **No. Never mesh.** | 20-person target makes mesh physically impossible on cellular. Build the SFU path from day one even while early usage is tiny. |
| 1:1 calls | Also on LiveKit (a 2-person room) | One transport stack, not two. |
| Embedding | **Same-origin JS module** imported into GroundLink | Seamless docked bar + expand with no audio drop. NOT an iframe (an iframe that loads/unloads on expand would drop the call; same-origin avoids the mic-permission and state-sharing headaches). |
| Backends | GROUNDWAVE stays its own Railway service; GroundLink does NOT merge its tracking backend | Apps fail independently; GROUNDWAVE stays standalone-usable. GroundLink hands GROUNDWAVE the roster across a small interface. |
| Provisioning | Build 20-capable architecture, provision small | Early usage is minimal. Scale the Railway/LiveKit footprint when real 20-person calls happen — config change, not a rewrite. |

---

## 3. Audio behavior (so it's built right)

- **Live streaming, not record-then-send.** On PTT press, the mic track goes live into the LiveKit
  room and listeners hear it within the normal WebRTC latency window (~150–400ms on cellular).
  A 5-minute transmission is heard live across all 5 minutes, lagging by a fraction of a second —
  there is NO wait-for-release. Do not build a chunked/blob-send live path.
- **Half-duplex = a talking rule, not a timing delay.** One person holds the floor at a time
  (like a radio). It does not mean buffering. Live audio and half-duplex coexist.
- **The `.webm` blob (MediaRecorder) is for transmission HISTORY/replay only** — a parallel capture,
  not the live path. Keep it for the expanded view's "listen again" feature; never route live audio
  through it.

---

## 4. Integration contract (GroundLink → voice module)

The interface is deliberately tiny. GroundLink hands the voice module two things:

1. **A room identity** (a stable room name/ID).
2. **A roster** — for 1:1, a single member ID; for group, the group's member list.

The flow:
- Tap a member on the map → action "Talk" → GroundLink calls the voice module:
  `openVoice({ room: <id>, members: [<memberId>] })` (1:1, ephemeral 2-person room).
- Tap a group → action "Talk to group" → `openVoice({ room: <groupRoomId>, members: [...all group member IDs] })`.
- GroundLink owns identity/presence (who's online, who's in which group). It passes that in.
  The voice module does NOT need its own login if GroundLink can supply a member identity and a
  LiveKit access token (token minting can live on GROUNDWAVE's Railway service).

Map identity → LiveKit participant identity mapping must be consistent so the bar can label
"who's talking" with GroundLink member names.

---

## 5. UI model — docked bar + expand

**Collapsed bar (default, ~90% of use):** docked at bottom of GroundLink once in a voice room.
Shows only essentials:
- Who you're talking to (member name or group name)
- The PTT button (press-and-hold)
- Live talker indicator ("◉ Dale talking")
- Mute / leave
- Expand affordance

**Expanded view:** the SAME running voice session rendered larger — GROUNDWAVE's fuller UI
(participant roster, transmission history/replay, settings). This is a CSS/layout state change,
NOT a navigation and NOT a reload.

**Critical:** the LiveKit connection lives in GroundLink at the app level, above the bar's
presentation. Collapse / expand / dock must NOT tear down or re-establish the room. Audio survives
all view-state changes. This is the whole point — build the connection as persistent app state and
let the bar/expanded view be two renderings of it.

---

## 6. Gotchas to handle from the start (miserable to retrofit)

- **Mic permission + autoplay priming.** `getUserMedia` needs a user gesture + HTTPS; incoming audio
  playback can be silently blocked until the page has been interacted with. Add a deliberate
  **"Join voice" tap** when the bar first appears that primes BOTH mic permission and the
  AudioContext up front. The PTT press covers keying up; the join tap covers *hearing* the first
  incoming transmission.
- **Consistent participant identity** between GroundLink members and LiveKit participants (see §4).
- **TURN fallback only.** With a self-hosted LiveKit SFU (public IP), most clients connect directly;
  TURN (currently Metered.ca in GROUNDWAVE) becomes fallback for hostile NAT, not the default path.
  Don't wire every client to relay through TURN by default.

---

## 7. Milestones

### M1 — HARD GATE (do this first, prove it, stop)
Stand up LiveKit self-hosted on Railway. Get **one 2-person room** working, launched from a
GroundLink map-member tap, rendered as the docked PTT bar.

**Target the EXISTING test map page — do NOT touch the production map.** GroundLink already has a
test page; find it and wire M1 there so the working tracking map is never at risk. If anything
misbehaves it stays quarantined on a page nobody depends on.

- LiveKit running on Railway (small footprint is fine)
- Token minting endpoint (on GROUNDWAVE's service)
- On the **test page**: member tap → `openVoice` → docked bar appears → join-voice priming tap →
  PTT → **live audio flows both ways**
- Talker indicator works

**Done = two browsers (ideally phone + laptop, to exercise cellular↔wifi) tap a member on the test
page, prime, hold PTT, and hear each other live within ~half a second, both directions.**

**Do not build group, expand, or history until M1 passes.** If two people can connect and pass live
audio from a map tap, everything else is additive. This is the equivalent of the baseball M1 ingest
spike — the gate that de-risks the whole project.

**Likely M1 snags (recognize, don't burn an evening):** (1) sending works but the first *incoming*
audio is silent → autoplay/priming; the join-voice tap is the fix (§6). (2) Two browsers connect but
no audio passes → TURN/ICE on cellular; self-hosted LiveKit's public IP means most connections go
direct rather than through Metered.ca, which mitigates this.

### M2 — Group all-call
- `openVoice` with a full group roster → group LiveKit room
- Wire room membership to GroundLink's group membership (GroundLink passes the member list)
- Works identically for 3 or 20; do not stress-test to 20 yet, just don't cap it

### M3 — Expanded view
- Expand the bar into GROUNDWAVE's fuller UI as a layout state of the same session
- Transmission history/replay (the `.webm` blobs) surfaces here
- Verify audio never drops on expand/collapse

---

## 8. Explicitly OUT OF SCOPE for now (do not build, do not half-build)

- **Background audio / foreground service / FCM wake.** When the screen locks, Android's battery
  optimizer eventually kills the WebSocket (GROUNDWAVE has a 60s server grace period today). True
  in-pocket/holster operation needs a native Android foreground service + FCM wake — this is
  native-shell work on the TWA wrapper, handled later as its own phase (Cowork on the local repo,
  like the Kotlin baseball work). Early users will have the app open while coordinating, so this is
  the most deferrable piece. Keep it on the roadmap; do not build it now.
- SFU scaling/load tuning for 20 — provision small now.
- Merging GROUNDWAVE's backend into GroundLink.

---

## 9. GROUNDWAVE current tech breakdown (reference — this is the working app)

> Paste of the verified GROUNDWAVE architecture. Treat as ground truth for what the voice client
> already does.

**Audio transport:** WebRTC peer-to-peer via native `RTCPeerConnection`. No SFU today (we are ADDING
LiveKit). Opus codec (WebRTC default).

**Signaling:** custom Node.js + `ws` WebSocket server on Railway. Manual offer/answer/ICE relay.
No managed service.

**NAT traversal:** STUN = Google public (`stun.l.google.com:19302`). TURN = Metered.ca managed
(`standard.relay.metered.ca`), ports 80/443 + TCP fallback. Third-party, not self-hosted coturn.

**PTT mechanics:** mic track swapped into a pre-negotiated peer connection via `replaceTrack()` —
live audio starts immediately, no buffering. `MediaRecorder` captures a parallel `.webm` blob for
history only. Latency 80–200ms WiFi, 150–400ms cellular via TURN.

**Group model (current):** full mesh, each client → every other client. Ceiling 4–6 (n² connections,
and talker uplink saturates). **This is exactly what LiveKit replaces.**

**Platform:** pure browser PWA — HTML/CSS/JS, no framework. Chrome/Edge Android, Safari iOS. No
native modules. Standard Web APIs only (`RTCPeerConnection`, `getUserMedia`, `MediaRecorder`,
`AudioContext`). Fully portable to TWA (TWA is just Chrome) and to a same-origin GroundLink module.

**Infra:** signaling = Node.js on Railway Hobby ($5/mo always-on). Audio history = Cloudflare R2
(`beakermessages` bucket, ~free tier). TURN = Metered.ca free tier + paid beyond. No media server,
no auth server, no per-minute costs at current scale.

**Permissions/background:** mic permission requested on first PTT press. Background playback works
while the tab is alive; no foreground service / wake lock / FCM today. Screen-lock eventually kills
the socket → 60s server grace period. (Background = deferred, see §8.)

---

## 10. Build notes / preferences

- Plain-language commits and PR descriptions.
- Keep the voice client as a clean importable module with a small public surface (`openVoice`,
  `leaveVoice`, state/events for "who's talking"). Both GroundLink and standalone GROUNDWAVE
  consume the same module.
- GroundLink repo: `jacef8/Tracker`. GROUNDWAVE stays its own service/repo; the shared voice module
  is the seam between them.
- Don't introduce a second transport stack. LiveKit for 1:1 and group both.

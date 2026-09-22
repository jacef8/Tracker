"""Allow/deny matrix for ../../database.rules.json, run against the local emulator.

Run it before deploying any rules change:

    # firebase-tools needs JDK 21+; this machine also has 17, which it refuses.
    export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-25.0.3.9-hotspot"
    export PATH="$JAVA_HOME/bin:$PATH"
    cd tools/rules-test
    cp ../../database.rules.json .      # the emulator refuses a rules file outside this folder
    firebase emulators:start --only database --project demo-groundlink &
    python test_rules.py

The emulator hot-reloads database.rules.json here, so re-copy after every edit. Deploy
with `node tools/deploy-rules.mjs --apply` (backs up the live rules first).

READ THIS BEFORE TRUSTING A GREEN RUN. Any token sent via `Authorization: Bearer`
-- including a deliberately malformed one -- is treated by the emulator as ADMIN
and bypasses rules entirely. A suite built that way reports PASS while testing
nothing; this one originally did, twice. User auth MUST go through the `?auth=`
query parameter, with a full-claims Firebase-ID-token-shaped payload (a minimal
{uid} body is rejected outright). The Bearer channel is used here only for
admin seeding.

If you add cases, sanity-check the harness the same way: point it at deny-all
rules and confirm the authed cases FAIL. If they pass, the harness is broken,
not the rules.
"""
import base64
import time
import json
import urllib.error
import urllib.request

HOST = "http://127.0.0.1:9000"
NS = "demo-groundlink-default-rtdb"

ALICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"   # 28 chars, auth-uid shaped
BOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbb"
CAROL = "cccccccccccccccccccccccccccc"
DAVE = "dddddddddddddddddddddddddddd"
ADMIN = "1RwPgdSdOEgp3lhlGly5I71EkY73"   # the app admin's Google account
IK = "k3y-abcdefghijkl"


PROJECT = "demo-groundlink"


def jwt(uid):
    """A full-claims, Firebase-ID-token-shaped JWT. The emulator does not verify the
    signature but DOES require this shape -- a minimal {uid} payload is rejected.

    Channel matters as much as shape, and getting it wrong silently invalidates the
    whole suite: ANY token sent via `Authorization: Bearer` (including a bogus one)
    is treated as ADMIN and bypasses rules entirely. Verified against deny-all rules:
    Bearer -> 200 (bypass), ?auth= -> 401 (enforced). User auth must use ?auth=.
    """
    now = int(time.time())

    def b64(o):
        return base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()

    payload = {
        "iss": f"https://securetoken.google.com/{PROJECT}",
        "aud": PROJECT,
        "auth_time": now,
        "user_id": uid,
        "sub": uid,
        "iat": now,
        "exp": now + 3600,
        "firebase": {"identities": {}, "sign_in_provider": "anonymous"},
    }
    return f'{b64({"alg": "RS256", "typ": "JWT"})}.{b64(payload)}.c2ln'


def req(method, path, uid=None, body=None, admin=False):
    url = f"{HOST}/{path}.json?ns={NS}"
    if uid and not admin:
        url += "&auth=" + jwt(uid)
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if admin:
        r.add_header("Authorization", "Bearer owner")   # admin channel, for seeding only
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read().decode()[:80]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:80]
    except Exception as e:                                    # noqa: BLE001
        return 0, str(e)[:80]


def seed():
    """Admin-write a realistic tree so delete/overwrite cases have something to hit."""
    # Start from nothing: the emulator keeps data between runs, and leftovers from a previous
    # run (an acl entry, an invite key) silently turn deny cases into allows.
    req("DELETE", "gl", admin=True)
    req("DELETE", "gltest", admin=True)
    req("PUT", "gl/testroom/config", admin=True,
        body={"owner": ALICE, "name": "Test Room", "persistent": True})
    req("PUT", f"gl/testroom/users/{BOB}", admin=True, body={"name": "Bob", "ts": 1})
    req("PUT", f"gl/testroom/members/{ALICE}", admin=True, body={"name": "Alice"})
    req("PUT", "gl/_devices/watch_abc/live", admin=True, body={"name": "watch", "ts": 1})
    req("PUT", "gl/gcroom/config", admin=True, body={"name": "Doomed"})
    # ACL + joinReq surface, plus a second OWNED room with live content so the
    # delete-hole cases have a real target that isn't testroom (which later cases
    # still read).
    req("PUT", f"gl/testroom/acl/{ALICE}", admin=True, body={"ts": 1, "by": "seed"})
    req("PUT", f"gl/testroom/acl/{BOB}", admin=True, body={"ts": 1, "by": "seed"})
    req("PUT", f"gl/testroom/joinReq/{BOB}", admin=True, body={"name": "Bob", "ts": 1})
    req("PUT", "gl/liveroom/config", admin=True, body={"owner": ALICE, "name": "Live"})
    req("PUT", f"gl/liveroom/users/{BOB}", admin=True, body={"name": "Bob", "ts": 1})
    req("PUT", "gl/_devices/watch_abc/sched", admin=True, body={"on": 1})
    req("PUT", "gl/_devices/watch_abc/ownerName", admin=True, body="Jace")
    req("PUT", "gl/_devices/watch_abc/fcmToken", admin=True, body="tok")
    req("PUT", "_forceReload", admin=True, body=1)
    # Phase A: invite keys, owner migration, unowned rooms, admin-only logs.
    req("PUT", "gl/ikroom/config", admin=True, body={"owner": ALICE, "name": "IK", "inviteKey": IK, "circle": True})
    req("PUT", f"gl/ikroom/acl/{ALICE}", admin=True, body={"ts": 1})
    req("PUT", "gl/migroom/config", admin=True, body={"owner": "dev_alice", "name": "Mig"})
    req("PUT", "gl/_devOwner/dev_alice", admin=True, body={"acct": ALICE})
    req("PUT", "gl/openroom/config", admin=True, body={"name": "No owner yet"})
    req("PUT", f"gl/testroom/config/removed/{BOB}", admin=True, body=5)
    req("PUT", "gl/_debug/x", admin=True, body=1)
    req("PUT", "gl/_diag/devices/d1", admin=True, body={"b": 1})


# (label, expect_allowed, method, path, uid, body)
CASES = [
    # --- the headline denials -------------------------------------------------
    ("nukeEverything: authed DELETE of /gl", False, "DELETE", "gl", ALICE, None),
    ("unauth write to a room's users", False, "PUT", f"gl/testroom/users/{ALICE}", None, {"n": 1}),
    ("authed write to UNKNOWN room child", False, "PUT", "gl/testroom/newthing", ALICE, {"x": 1}),
    ("authed write to UNKNOWN gl child", False, "PUT", "gl/_newthing/x", ALICE, {"x": 1}),
    ("authed wholesale REPLACE of a room", False, "PUT", "gl/testroom", ALICE, {"config": {"owner": BOB}}),
    ("unauth write to _users", False, "PUT", f"gl/_users/{ALICE}/sessions/d1", None, {"n": 1}),
    ("unauth READ of a room", False, "GET", "gl/testroom", None, None),

    # --- must keep working ----------------------------------------------------
    ("watch: UNAUTH write to _devices/<id>/live", True, "PUT", "gl/_devices/watch_abc/live", None, {"lat": 1, "ts": 2}),
    ("apple log: UNAUTH write to _debug", True, "PUT", "gl/_debug/appleSignInLog/3", None, {"step": "x"}),
    ("watch: UNAUTH write to _deviceShares/<code>", True, "PUT", "gl/_deviceShares/ABC123", None, {"id": "watch_abc"}),
    ("watch: UNAUTH write _devices fcmToken", True, "PUT", "gl/_devices/watch_abc/fcmToken", None, "tok"),
    ("watch: UNAUTH write _devices wakeLog", True, "PUT", "gl/_devices/watch_abc/wakeLog/1", None, {"t": 1}),
    ("watch: UNAUTH read _devices/<id>/sched", True, "GET", "gl/_devices/watch_abc/sched", None, None),
    ("watch: UNAUTH read _devices/<id>/ownerName", True, "GET", "gl/_devices/watch_abc/ownerName", None, None),
    ("privacy: UNAUTH read _devices/<id>/live must stay DENIED", False, "GET", "gl/_devices/watch_abc/live", None, None),
    ("privacy: UNAUTH read _devices/<id>/fcmToken must stay DENIED", False, "GET", "gl/_devices/watch_abc/fcmToken", None, None),
    ("authed write own presence", True, "PUT", f"gl/testroom/users/{ALICE}", ALICE, {"name": "Alice", "ts": 9}),
    # Position/roster-spoofing lockdown (commit 2ace010): you may write ONLY your own
    # id, so writing or deleting another person's presence/roster row is denied even
    # for the owner. (These expected `allow` before that rule shipped; the harness
    # was never updated, which would have masked a regression.)
    ("roster lockdown: can't DELETE another's presence", False, "DELETE", f"gl/testroom/users/{BOB}", ALICE, None),
    ("roster lockdown: can't write ANOTHER's member row", False, "PUT", f"gl/testroom/members/{BOB}", ALICE, {"name": "Bob"}),
    ("roster: CAN write your OWN member row", True, "PUT", f"gl/testroom/members/{ALICE}", ALICE, {"name": "Alice"}),
    ("authed write room config", True, "PUT", "gl/testroom/config/name", ALICE, "Renamed"),
    ("authed post chat", True, "PUT", "gl/testroom/chat/m1", ALICE, {"t": "hi"}),
    ("authed write pins", True, "PUT", "gl/testroom/pins/p1", ALICE, {"lat": 1, "lng": 2}),
    ("authed write trails", True, "PUT", f"gl/testroom/trails/{ALICE}/t1", ALICE, {"lat": 1}),
    ("authed write history", True, "PUT", f"gl/testroom/history/{ALICE}/h1", ALICE, {"lat": 1}),
    ("authed write voiceAll", True, "PUT", "gl/testroom/voiceAll", ALICE, True),
    ("room GC: authed DELETE a whole room", True, "DELETE", "gl/gcroom", ALICE, None),
    ("authed write _users sessions", True, "PUT", f"gl/_users/{ALICE}/sessions/d1", ALICE, {"n": 1}),
    ("authed write _sessions", True, "PUT", "gl/_sessions/s1", ALICE, {"g": "testroom"}),
    ("authed write _invites", True, "PUT", f"gl/_invites/{BOB}", ALICE, {"i": 1}),
    ("authed write _presence", True, "PUT", f"gl/_presence/{ALICE}", ALICE, {"room": "testroom"}),
    ("authed write _deviceOwners", True, "PUT", f"gl/_deviceOwners/{ALICE}/watch_abc", ALICE, True),
    ("authed write _directory", True, "PUT", f"gl/_directory/{ALICE}", ALICE, {"d": 1}),
    ("authed READ a room", True, "GET", "gl/testroom", ALICE, None),
    ("_forceReload: ordinary user CANNOT reload everyone", False, "PUT", "_forceReload", ALICE, 12345),
    ("_forceReload: app admin can", True, "PUT", "_forceReload", ADMIN, 12345),
    ("_minNative: ordinary user CANNOT", False, "PUT", "_minNative", BOB, 99),

    # --- Phase A: room settings are the owner's -------------------------------
    ("config: non-owner renames a room", False, "PUT", "gl/testroom/config/name", BOB, "Hijacked"),
    ("config: non-owner takes ownership", False, "PUT", "gl/testroom/config/owner", BOB, BOB),
    ("config: non-owner makes self admin", False, "PUT", f"gl/testroom/config/admins/{BOB}", BOB, {"n": 1}),
    ("config: non-owner makes room PUBLIC", False, "PUT", "gl/testroom/config/visibility", BOB, "public"),
    ("config: non-owner locks room PRIVATE (safety)", True, "PUT", "gl/testroom/config/visibility", BOB, "private"),
    ("config: non-owner sets a passcode", False, "PUT", "gl/testroom/config/pin", BOB, "hash"),
    ("config: member records an invite", True, "PUT", f"gl/testroom/config/invited/{CAROL}", BOB, {"name": "C"}),
    ("config: member asks to be admin", True, "PUT", f"gl/testroom/config/adminRequest/{BOB}", BOB, {"ts": 1}),
    ("config: member writes a place guard", True, "PUT", "gl/testroom/config/placeGuard/x_y_arrive", BOB, 1),
    ("config: member converts to Crew (circle)", True, "PUT", "gl/testroom/config/circle", BOB, True),
    ("config: member clears own removed marker", True, "DELETE", f"gl/testroom/config/removed/{BOB}", BOB, None),
    ("config: member marks someone removed", False, "PUT", f"gl/testroom/config/removed/{ALICE}", BOB, 1),
    ("config: persistent room can't be given an expiry", False, "PUT", "gl/testroom/config/expires", BOB, 1),
    ("config: self-heal expiry on a room with none", True, "PUT", "gl/openroom/config/expires", BOB, 99),
    ("config: first visitor claims an unowned room", True, "PUT", "gl/openroom/config/owner", BOB, BOB),
    ("config: owner migrates device-id owner to account", True, "PUT", "gl/migroom/config/owner", ALICE, ALICE),
    ("config: a stranger can't wholesale-replace config", False, "PUT", "gl/ikroom/config", BOB, {"owner": BOB}),

    # --- Phase A: invite keys --------------------------------------------------
    ("acl: self-grant with the WRONG invite key", False, "PUT", f"gl/ikroom/acl/{CAROL}", CAROL, {"ik": "nope-nope-nope", "ts": 1}),
    ("acl: self-grant with NO key", False, "PUT", f"gl/ikroom/acl/{CAROL}", CAROL, {"ts": 1}),
    ("acl: key holder grants ANOTHER uid", False, "PUT", f"gl/ikroom/acl/{DAVE}", CAROL, {"ik": IK, "ts": 1}),
    ("acl: self-grant with the RIGHT invite key", True, "PUT", f"gl/ikroom/acl/{CAROL}", CAROL, {"ik": IK, "ts": 1}),
    ("acl: a member invites someone (grants their id)", True, "PUT", f"gl/ikroom/acl/{DAVE}", CAROL, {"ts": 1, "by": CAROL}),
    ("acl: a member can't DELETE another member", False, "DELETE", f"gl/ikroom/acl/{ALICE}", CAROL, None),
    ("inviteKey: a member can't REPLACE it", False, "PUT", "gl/ikroom/config/inviteKey", CAROL, "another-key-123"),
    ("inviteKey: the owner CAN rotate it (revokes old links)", True, "PUT", "gl/ikroom/config/inviteKey", ALICE, "rotated-key-12345"),
    ("inviteKey: too short to be a secret", False, "PUT", "gl/testroom/config/inviteKey", BOB, "abc"),
    ("inviteKey: a member creates one where none exists", True, "PUT", "gl/testroom/config/inviteKey", BOB, "fresh-key-12345"),

    # --- Phase A: admin-only logs and push tokens ------------------------------
    ("_debug: ordinary user can't read", False, "GET", "gl/_debug", ALICE, None),
    ("_debug: admin reads", True, "GET", "gl/_debug", ADMIN, None),
    ("_diag: ordinary user can't read", False, "GET", "gl/_diag", ALICE, None),
    ("_diag: device still writes its beacon", True, "PUT", "gl/_diag/devices/d2", ALICE, {"b": 2}),
    ("_activityLog: ordinary user can't read", False, "GET", "gl/_activityLog", ALICE, None),
    ("_aclMiss: ordinary user can't read", False, "GET", "gl/_aclMiss", ALICE, None),
    ("_voipSubs: nobody reads call tokens", False, "GET", "gl/_voipSubs", ALICE, None),
    ("_pttSubs: nobody reads PTT tokens", False, "GET", "gl/_pttSubs", ALICE, None),
    ("_voipSubs: device still registers", True, "PUT", f"gl/_voipSubs/{ALICE}", ALICE, {"token": "t"}),
    ("_authMap: report own sign-in id", True, "PUT", f"gl/_authMap/{BOB}", BOB, {"glUid": "dev_b"}),
    ("_authMap: forge another's", False, "PUT", f"gl/_authMap/{ALICE}", BOB, {"glUid": "x"}),
    ("_authMap: ordinary user can't read", False, "GET", "gl/_authMap", BOB, None),
    ("_authMap: admin reads", True, "GET", "gl/_authMap", ADMIN, None),
    ("gltest: open sandbox is closed", False, "PUT", "gltest/g/anything", ALICE, {"x": 1}),
    ("gltest: unauth write closed", False, "PUT", "gltest/g/anything", None, {"x": 1}),

    # --- ACL / joinReq surface (approval queue) -------------------------------
    ("acl: non-member grants SELF access (no key)", False, "PUT", f"gl/testroom/acl/{CAROL}", CAROL, {"ts": 2}),
    ("acl: owner grants a member access", True, "PUT", f"gl/testroom/acl/{BOB}", ALICE, {"ts": 2, "by": "alice"}),
    ("acl: non-owner deletes ANOTHER's entry", False, "DELETE", f"gl/testroom/acl/{ALICE}", BOB, None),
    ("acl: member deletes their OWN entry", True, "DELETE", f"gl/testroom/acl/{BOB}", BOB, None),
    ("joinReq: forge under own uid", True, "PUT", f"gl/testroom/joinReq/{BOB}", BOB, {"name": "B", "ts": 3}),
    ("joinReq: forge under ANOTHER's uid", False, "PUT", f"gl/testroom/joinReq/{ALICE}", BOB, {"name": "x", "ts": 3}),
    ("joinReq: owner reads the queue", True, "GET", "gl/testroom/joinReq", ALICE, None),
    # An outsider must be able to read their OWN request even when NOT in the room —
    # this is what lets the joiner's approval-watcher work from outside once the ACL
    # read-gate lands and $room.read no longer blanket-grants. The child .read grants
    # what the (future) gated parent denies.
    ("joinReq: outsider reads their OWN request", True, "GET", f"gl/testroom/joinReq/{BOB}", BOB, None),
    # NOTE: a non-owner reading the WHOLE queue is currently ALLOWED — $room.read is a
    # blanket `auth != null` and that grant cascades into joinReq; the node-level
    # owner-only .read cannot revoke a parent grant. It tightens to room-members-only
    # the moment the ACL read-gate makes $room.read conditional. Asserted as-is so the
    # test tells the truth about today's behavior rather than an aspiration.
    ("joinReq: non-owner reads the queue (blanket room-read, pre-gate)", True, "GET", "gl/testroom/joinReq", BOB, None),
    ("_aclMiss: write under own uid", True, "PUT", f"gl/_aclMiss/testroom/{BOB}", BOB, {"ts": 4}),
    ("_aclMiss: write under ANOTHER's uid", False, "PUT", f"gl/_aclMiss/testroom/{ALICE}", BOB, {"ts": 4}),

    # --- room index (home directory / join-by-name) ---------------------------
    ("roomIndex: authed reads the directory", True, "GET", "gl/_roomIndex", BOB, None),
    ("roomIndex: unauth CANNOT read the directory", False, "GET", "gl/_roomIndex", None, None),
    ("roomIndex: authed writes a room's entry", True, "PUT", "gl/_roomIndex/testroom", BOB, {"name": "T", "vis": "public", "lastSeen": 5}),
    ("roomIndex: unauth CANNOT write an entry", False, "PUT", "gl/_roomIndex/testroom", None, {"name": "x"}),

    # --- delete hole (must run LAST — destructive to shared state) -------------
    ("acl DoS: non-owner wipes the whole acl node", False, "DELETE", "gl/testroom/acl", BOB, None),
    ("room DoS: non-owner deletes a LIVE room", False, "DELETE", "gl/liveroom", BOB, None),
    ("owner deletes their OWN live room", True, "DELETE", "gl/liveroom", ALICE, None),
]

seed()
print(f"{'result':7} {'expect':8} {'code':5} case")
print("-" * 78)
fails = 0
for label, expect_allow, method, path, uid, body in CASES:
    code, _ = req(method, path, uid=uid, body=body)
    allowed = code in (200, 204)
    ok = allowed == expect_allow
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL':7} "
          f"{'allow' if expect_allow else 'DENY':8} {code:<5} {label}")

print("-" * 78)
print(f"{len(CASES) - fails}/{len(CASES)} passed"
      + ("" if not fails else f"   ** {fails} FAILED **"))
raise SystemExit(1 if fails else 0)

"""Allow/deny matrix for ../../database.rules.json, run against the local emulator.

Run it before deploying any rules change:

    # firebase-tools needs JDK 21+; this machine also has 17, which it refuses.
    export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-25.0.3.9-hotspot"
    export PATH="$JAVA_HOME/bin:$PATH"
    cd tools/rules-test
    firebase emulators:start --only database --project demo-groundlink &
    python test_rules.py

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
    req("PUT", "gl/testroom/config", admin=True,
        body={"owner": ALICE, "name": "Test Room", "persistent": True})
    req("PUT", f"gl/testroom/users/{BOB}", admin=True, body={"name": "Bob", "ts": 1})
    req("PUT", f"gl/testroom/members/{ALICE}", admin=True, body={"name": "Alice"})
    req("PUT", "gl/_devices/watch_abc/live", admin=True, body={"name": "watch", "ts": 1})
    req("PUT", "gl/gcroom/config", admin=True, body={"name": "Doomed"})
    req("PUT", "gl/_devices/watch_abc/sched", admin=True, body={"on": 1})
    req("PUT", "gl/_devices/watch_abc/ownerName", admin=True, body="Jace")
    req("PUT", "gl/_devices/watch_abc/fcmToken", admin=True, body="tok")
    req("PUT", "_forceReload", admin=True, body=1)


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
    ("ghost cleanup: authed DELETE other's presence", True, "DELETE", f"gl/testroom/users/{BOB}", ALICE, None),
    ("authed write members entry", True, "PUT", f"gl/testroom/members/{BOB}", ALICE, {"name": "Bob"}),
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
    ("_forceReload still writable (deploy flow)", True, "PUT", "_forceReload", ALICE, 12345),
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

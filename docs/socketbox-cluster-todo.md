# SocketBox clustering — history

Status: all items originally tracked here are resolved or corrected as of
2026-08-01. `public/WebSocket.bx` implements cross-node delivery and
count/roster aggregation for client events, subscription counts, presence,
and watchlist online/offline, following the module's own
`send()`/`routeMessage()` rebroadcast pattern and
`getClusterSTOMPConnections()` RPC-aggregation pattern. Kept as a record of
what was found and how it was fixed, in case any of it regresses or a
similar issue shows up elsewhere in the module.

## RESOLVED (2026-08-01) — cluster peer connections did not stay stable

Root cause found and fixed. `createDynamicProxy()` cannot dispatch Java
`default` interface methods to a proxied BoxLang component — confirmed via
bytecode decompilation as a currently-open upstream bug,
[ortus-boxlang/BoxLang#595](https://github.com/ortus-boxlang/BoxLang/issues/595).
Every method on `java.net.http.WebSocket.Listener` is a default method, so
`ClusterManager.cfc`'s `createPeerListener()` — which proxied that
interface directly against `ClusterPeer.cfc` — silently never invoked any
of `ClusterPeer`'s callbacks. `webSocket` was never captured,
`isConnectionOpen()` always returned `false`, and `checkPeers()` tore the
(genuinely connected) link down and reconnected it every cycle forever,
with no error ever logged.

**Fix**: `java/socketbox-shim/` — a tiny compiled Java shim
(`PeerListenerCallback`, a plain interface with no default methods, safe to
proxy; `PeerListenerAdapter`, a real compiled `WebSocket.Listener` that
forwards to it) — routes around the bug entirely.
`patches/socketbox/files/models/cluster/ClusterManager.cfc` patches
`createPeerListener()` to use it; `patches/socketbox/apply.sh` reapplies
that patch after every `box install` (wired via `box.json`'s
`postInstallAll` script locally, and explicitly in the `Dockerfile`, since
`lib/modules/socketbox/` is gitignored and refetched fresh on every
install). See `patches/socketbox/README.md` and
`java/socketbox-shim/README.md` for the full detail.

**Verified end-to-end** against the `docker-compose.cluster-test.yml`
two-node rig: connections now hold open indefinitely (no reconnect churn
observed over a 3+ minute window, versus every 2-6s before), the module's
pre-existing `RPCClusterRequest()`/`getClusterSTOMPConnections()` mechanism
works, and — critically — the cluster-aware delivery/aggregation code
above now demonstrably works cross-node: a subscriber on node A correctly
saw a cluster-wide count of 2 when a second subscriber joined via node B,
and correctly saw count 3 (pushed cross-node, not just aggregated on
request) when a third subscriber joined node A. Fixing this also surfaced
and required fixing one more bug it had been masking: `onManagementMessage()`
in `public/WebSocket.bx` used `deserializeJSON` (a ColdFusion-compat alias)
instead of `jsonDeserialize` (canonical BoxLang, used everywhere else in
that file) — it silently never ran before because no management message
ever reached it; once delivery started working, this surfaced immediately
as a real, easy-to-diagnose stack trace and was fixed in the same pass.

## RESOLVED (2026-08-01) — host-published-port fragility

`public/WebSocket.bx`'s cluster `name` computation derived the advertised
port from `cgi.server_port` — the port the *triggering request* appeared to
arrive on, not necessarily the server's real bound port. In Docker,
triggering the first configuring request via a host-published port (e.g.
`curl localhost:18085`) baked that *external* port into the node's
self-advertised name instead of the real internal one (`8080`), and other
nodes then tried to dial a port nothing inside the container network was
listening on — the reason the earlier verification had to trigger the first
request via `docker exec <container> curl ...` from inside the container.

**Fix**: `clusterAdvertisedPort()` (`public/WebSocket.bx`) now prefers the
`BOX_SERVER_WEB_HTTP_PORT` env var when set — the `Dockerfile` already sets
this to the real bound port for health-check/routing purposes, so reusing
it needed no new infrastructure — falling back to `cgi.server_port` for
local dev, where it's accurate since nothing remaps the port in front of
it. The `docker exec`-from-inside-the-container workaround is no longer
necessary as a result.

## RESOLVED (2026-08-01) — watchlist online/offline double-fire

`app/models/WatchlistService.bx`'s `signIn()`/`signOutAllForConnection()`
decide `wasFirstConnection`/`wasLastConnection` from the local-only
`pulselyWatchlist` cache, so a user already online via node A got a
duplicate `watchlist.online` when they connected to node B.

**Fix**: `isOnlineOnAnyPeer()` (`public/WebSocket.bx`), mirroring
`clusterSubscriberCount()`'s RPC-aggregation pattern exactly (new
`getLocalWatchlistOnline` case in `_onRPCRequest()`, backed by
`WatchlistService.isOnline()` which already existed and needed no changes).
`handleSignin()`/`onClose()` now check it *after* the local sign-in/out
call, before broadcasting — only ever asking about *other* peers, never
racing against this node's own just-written state. `WatchlistService.bx`
itself is unchanged.

Known residual edge case, not solved here: if the very first connections
for the same user land on two different nodes in the same instant, both
could complete their peer-check before the other's local write lands,
producing a double `watchlist.online` in that narrow window. A large
improvement over always-double-firing, not a claim of perfect distributed
consistency.

## CORRECTED (2026-08-01) — the two items below were not real bugs

Re-investigated before attempting a fix. Both turned out to be based on a
false diagnosis — most likely symptoms of this project's own rapid
test-restart churn during the original investigation, not code defects.
Recorded here so nobody re-investigates them from the same false premise.

**"First-connection concurrency race"**: `WebSocketCore.cfc`'s
`reloadCheck()` already wraps the configure-decision in
`cflock(name="SocketBoxInit", type="exclusive", timeout=60)` with correct
double-checked locking — a thread that blocks on the lock re-checks
`structKeyExists(application, "SocketBoxConfig")` live after acquiring it,
and correctly skips `_configure()` if another thread already ran it. The
`Duplicate entry`/`Thread name already in use` errors originally observed
are much better explained by the investigation's own repeated rapid server
restarts leaving stale rows in the shared `pulselyClusterPeers` table from
earlier, ungracefully-killed JVM incarnations of the same node — a node
restarting under the same peer name within `peerIdleTimeoutSeconds` (60s
default) of its own prior, uncleanly-terminated life hits a duplicate-key
error on its *own* stale row, regardless of any in-process locking. That's
a real, narrow, genuinely different operational edge case (a node
crash-and-fast-restart) than "missing a lock" — worth a small defensive
improvement someday (have a node clear its own prior registration on
startup before re-registering, via `patches/socketbox/`), but not urgent
and not what was originally diagnosed.

**"`RPCClusterRequest()` is serial, not concurrent"**: `RPCClusterRequest()`
calls `.map((peerName, peerConnection) => {...}, true)`. That trailing
`true` is BoxLang's `parallel` argument — confirmed by decompiling the
installed runtime's `StructMap`/`StructEach` BIF classes
(`(struct, callback, parallel, maxThreads, virtual/ordered)`). This is
genuine parallel dispatch across peers already, not serial. No fix needed.

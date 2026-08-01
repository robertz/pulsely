# SocketBox clustering — remaining known gaps

Status: `public/WebSocket.bx` implements cross-node delivery and
count/roster aggregation for client events, subscription counts, and
presence, following the module's own `send()`/`routeMessage()` rebroadcast
pattern and `getClusterSTOMPConnections()` RPC-aggregation pattern. Written
2026-07-31.

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

## Still open

**The host-published-port fragility noted during the investigation above is
still real** and worth its own fix eventually: `getDefaultClusterName()` in
`WebSocketCore.cfc` derives a node's advertised cluster peer name from
`cgi.server_port`/the triggering request's own Host header, rather than the
actual bound listener port. In Docker, triggering the first configuring
request via a host-published port (e.g. `curl localhost:18085`) bakes that
*external* port into the node's self-advertised name instead of the real
internal one (`8080`), and other nodes then try to dial a port nothing
inside the container network is listening on. Must trigger via `docker exec
<container> curl ...` from inside the container instead — see
`java/socketbox-shim/README.md`'s neighbor, `docker-compose.cluster-test.yml`,
for the working incantation. Not fixed in this pass; scoped separately from
the peer-connection-stability fix above.

## Watchlist online/offline can double-fire across nodes

`app/models/WatchlistService.bx`'s `signIn()` / `signOutAllForConnection()`
decide `wasFirstConnection` / `wasLastConnection` by reading the
`pulselyWatchlist` cache, which — like `pulselyPresence` — is local to the
node's JVM, not shared across the cluster.

If a user is already signed in via a connection on node A and opens a
second connection on node B, node B's `signIn()` has no visibility into
node A's state, so it also reports `wasFirstConnection = true` and
`broadcastWatchlist()` (`public/WebSocket.bx`) re-fires `watchlist.online`
for a user who was already online. The symmetric case applies to
`watchlist.offline` on disconnect.

This isn't fixable by read-time aggregation the way subscription counts and
presence rosters were (see `clusterSubscriberCount()` /
`clusterPresenceMembers()` in `public/WebSocket.bx`) — it needs the
sign-in/sign-out decision itself to check peers *before* deciding
`wasFirstConnection`/`wasLastConnection`, most likely via the same
`RPCClusterRequest()` pattern (e.g. a `getLocalWatchlistStatus` RPC
operation), with the actual first/last-connection bookkeeping in
`WatchlistService.bx` changed to be cluster-aware rather than just its
callers.

## First-connection concurrency race in the socketbox module itself

Found while fixing the `pulselyClusterPeers` cache-region collision: on a
cold server, the very first WebSocket handshake can trigger `_configure()`
from more than one concurrent request path, so two `ClusterManager`
instances both try to start a thread named `SocketBoxClusterManager` and
both try to insert the same peer-registration row —

```
SocketBox error during configuration: Duplicate entry '...' for key 'pulselyclusterpeers.PRIMARY'
SocketBox error during configuration: Thread name [SocketBoxClusterManager] already in use for this request.
```

This is a gap in `lib/modules/socketbox/models/WebSocketCore.cfc`'s
`reloadCheck()`/`_configure()` (missing a lock around first-time
configuration), not something specific to Pulsely's own config. Left alone
per explicit instruction when the cache-region collision was fixed —
revisit if it causes visible startup errors in practice (it's a one-time
race on cold start, not an ongoing issue once configured).

## `RPCClusterRequest()` is serial, not concurrent

`WebSocketCore.cfc`'s `RPCClusterRequest()` (used by
`clusterSubscriberCount()` and `clusterPresenceMembers()` in
`public/WebSocket.bx`) iterates peers one at a time — each `RPCRequest()`
call blocks (up to its timeout) before the next peer is asked. Both new
aggregation helpers pass a short 2-second per-peer timeout specifically to
bound this, but latency still scales linearly with peer count in the worst
case (all peers slow/unresponsive). Fine for a small cluster; worth
revisiting (e.g. fanning out concurrently) if the cluster grows large.

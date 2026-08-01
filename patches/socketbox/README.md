# socketbox vendor patches

`lib/modules/socketbox/` is a ForgeBox dependency (`box.json`: `"socketbox": "^2.1.0"`)
and is gitignored (`lib/**`) — `box install` refetches it fresh every time,
both locally and in `Dockerfile`'s `RUN box install --production`. Direct
edits to files under `lib/modules/socketbox/` do not survive that and would
silently vanish. This directory holds tracked, patched copies of specific
vendored files, reapplied by `apply.sh` after every install.

`files/` mirrors the path structure under `lib/modules/socketbox/`, so
`apply.sh` is a plain recursive copy — a future patch just drops in at the
matching relative path.

## Current patches

- **`files/models/cluster/ClusterManager.cfc`** — fixes cluster peer
  WebSocket connections never staying open (see
  `docs/socketbox-cluster-todo.md`). Root cause:
  `createPeerListener()` proxied `java.net.http.WebSocket$Listener`
  directly via `createDynamicProxy()`. Every method on that interface is a
  Java `default` method, and BoxLang's `createDynamicProxy()` cannot
  dispatch default methods to a proxied BoxLang component — it always runs
  the JDK's own default body instead (confirmed via bytecode
  decompilation; tracked upstream as
  [ortus-boxlang/BoxLang#595](https://github.com/ortus-boxlang/BoxLang/issues/595),
  open, unfixed as of this patch). `ClusterPeer.cfc`'s `onOpen`/`onText`/
  `onBinary`/`onClose`/`onError` overrides were therefore silently never
  invoked, so the peer's `webSocket` reference was never captured,
  `isConnectionOpen()` always returned `false`, and `checkPeers()` tore the
  (genuinely connected) link down and reconnected it every cycle forever.
  The patch routes through `java/socketbox-shim/` (see that directory's
  README) — a plain interface with no default methods that
  `createDynamicProxy()` CAN dispatch correctly, wrapped in a real compiled
  `WebSocket.Listener` that forwards to it.

## Wired into both install paths

- `box.json`'s `scripts.postInstallAll` runs `apply.sh` automatically after
  every local `box install`.
- `Dockerfile` runs it explicitly right after `RUN box install --production`,
  as belt-and-suspenders for the build.

## When socketbox ships a new version

Re-diff: `box install` fresh, compare the new
`lib/modules/socketbox/models/cluster/ClusterManager.cfc` against this
directory's copy, and re-derive the patch against the new upstream file if
`createPeerListener()`'s surroundings changed. If BoxLang#595 gets fixed
upstream, this whole patch (and `java/socketbox-shim/`) can likely be
dropped — revert `createPeerListener()` to the original
`createDynamicProxy(peer, ["java.net.http.WebSocket$Listener"])` and delete
this directory.

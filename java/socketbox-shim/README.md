# socketbox cluster peer listener shim

Works around [ortus-boxlang/BoxLang#595](https://github.com/ortus-boxlang/BoxLang/issues/595):
`createDynamicProxy()` cannot dispatch Java `default` interface methods to
a proxied BoxLang component — it always runs the JDK's own default body
instead, even when the target defines a matching override. Every method on
`java.net.http.WebSocket.Listener` is a default method, so the socketbox
module's `ClusterManager.cfc` (`createPeerListener()`) previously proxied
`WebSocket$Listener` directly against `ClusterPeer.cfc` and none of
`ClusterPeer`'s callbacks (`onOpen`/`onText`/`onBinary`/`onClose`/`onError`)
were ever actually invoked. See `docs/socketbox-cluster-todo.md` for the
full investigation and symptoms.

`PeerListenerCallback` is a plain, all-abstract mirror of
`WebSocket.Listener`'s callbacks — no default methods, so a
`createDynamicProxy()` built against *it* isn't subject to the bug.
`PeerListenerAdapter` is a real (non-proxied, compiled) `WebSocket.Listener`
that forwards every JDK callback verbatim to a `PeerListenerCallback`.
`patches/socketbox/files/models/cluster/ClusterManager.cfc` wires the two
together in `createPeerListener()` (see `patches/socketbox/README.md`).

## Rebuilding

After editing anything in `src/`:

```bash
./build.sh
```

This produces `lib/java/pulsely-socketbox-shim.jar`, picked up
automatically via `runtime/boxlang.json`'s `javaLibraryPaths`. Commit both
the source change and the regenerated jar — `lib/java/` is the one part of
`lib/` not gitignored (see `.gitignore`), so it's the only place a
hand-built jar survives `box install` re-fetching everything else under
`lib/`.

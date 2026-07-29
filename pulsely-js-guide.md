# pulsely.js — beginner's guide

A practical, task-by-task guide to the Pulsely browser SDK
(`public/assets/js/pulsely.js`). If you want the full endpoint/webhook
reference, see [readme.md](readme.md) — this guide is about the client only.

## Setup

Load STOMP.js first, then `pulsely.js`:

```html
<script src="/assets/js/vendor/stomp.umd.min.js"></script>
<script src="/assets/js/pulsely.js"></script>
```

Create a client and connect:

```js
const bp = new Pulsely( 'your-app-key' ); // the public key — safe in the browser
await bp.connect();
```

That's it for public channels. Private and presence channels need an
`authToken` too — see [Private channels](#private-channels) below.

`bp.connect()` returns a promise that resolves once the broker has accepted
the connection, and rejects if the app key is invalid or the broker can't be
reached at all.

---

## 1. Subscribe and receive events

```js
bp.subscribe( 'orders' );

bp.bind( 'created', ( data, meta ) => {
	console.log( 'new order:', data );
} );
```

- `subscribe()` can be called before or after `connect()` — it queues and
  fires once connected either way.
- `bind( eventName, callback )` only fires for that exact event name. Your
  callback gets `(data, meta)` — `data` is whatever your server published,
  `meta` tells you `{ channel, event, replayed, fromClient }`.

To stop listening:

```js
bp.unsubscribe( 'orders' );
```

---

## 2. Tell replayed history apart from live events

If the channel's plan has message history enabled, subscribing to it replays
recent messages before the live stream starts — useful so a page that just
loaded doesn't show up empty.

```js
bp.bind( 'created', ( data, meta ) => {
	if ( meta.replayed ) {
		prependToFeed( data );   // arrived first, oldest → newest
	} else {
		prependToFeed( data );   // arrived live
		flashNewItemIndicator();
	}
} );
```

`meta.replayed` is the only difference — the event name and shape are
identical either way.

---

## 3. Listen to everything, without knowing event names ahead of time

For a debug console, an activity log, or analytics — anything that shouldn't
have to list every event name up front:

```js
bp.bindGlobal( ( data, meta ) => {
	console.log( `[${meta.channel}] ${meta.event}`, data );
} );
```

Fires for every event on every channel, in addition to whatever `bind()`
handlers are also registered — they aren't mutually exclusive.

---

## 4. Watch the connection itself

Don't reach into `bp.client` — that's the underlying STOMP.js client and
touching it directly breaks the SDK's own bookkeeping. Use
`bp.connection.bind(...)` instead:

```js
bp.connection.bind( 'state_change', ( { previous, current, error } ) => {
	if ( current === 'connected' )    showBanner( 'Live' );
	if ( current === 'unavailable' )  showBanner( error || 'Reconnecting…' );
	if ( current === 'disconnected' ) showBanner( 'Disconnected' );
} );
```

States: `initialized` → `connecting` → `connected` / `unavailable` (dropped
or refused — the SDK retries automatically) / `disconnected` (you called
`disconnect()` — terminal, no retry).

---

## 5. Private channels

Anything prefixed `private-` needs your server to vouch for the connection.
Two pieces:

**Server** mints a short-lived token (Node SDK shown; every server SDK has
the same method):

```js
const token = bp.authToken( currentUserId ); // your server, not the browser
```

**Client** presents it at connect time:

```js
const bp = new Pulsely( 'your-app-key', { authToken: token } );
await bp.connect();
bp.subscribe( 'private-orders' );
```

Your server also needs an auth webhook that answers Pulsely's question
"may this connection subscribe to this channel" — see readme.md's
[Private and presence channels](readme.md#private-and-presence-channels)
section for the wire contract.

**A refused subscribe doesn't kill the connection.** It's reported as its own
event, on the same socket, and everything else you're subscribed to keeps
working:

```js
bp.bind( 'subscription_error', ( data, meta ) => {
	console.log( `refused on ${meta.channel}:`, data.reason );
} );

bp.bind( 'subscription_succeeded', ( data, meta ) => {
	console.log( `joined ${meta.channel}` );
} );
```

To check later whether a channel is actually joined (not just requested):

```js
bp.isSubscribed( 'private-orders' ); // false until subscription_succeeded arrives
```

---

## 6. Presence channels — who's in the room

A `presence-` channel is a private channel that also tracks a live roster.
Your auth webhook names the subscriber (`user_id` + optional `user_info`);
the SDK keeps a local copy of who's there.

```js
bp.subscribe( 'presence-lobby' );

bp.bind( 'presence.subscription_succeeded', ( data ) => {
	renderRoster( data.members );      // everyone already here, including you
} );

bp.bind( 'presence.member_added', ( data ) => {
	addToRoster( data.member );        // { user_id, user_info }
} );

bp.bind( 'presence.member_removed', ( data ) => {
	removeFromRoster( data.member.user_id );
} );

// A local read, no round trip — kept in sync as members join/leave.
bp.members( 'presence-lobby' );        // [{ user_id, user_info }, ...]
bp.memberCount( 'presence-lobby' );     // distinct users; extra tabs don't double-count
```

---

## 7. Publish straight from the browser (client events)

For ephemeral, low-stakes signals like typing indicators or cursor position —
**not** for anything your server needs to trust. Requires: a `private-` or
`presence-` channel you're already subscribed to, the app has client events
turned on, and the event name starts with `client-`.

```js
bp.trigger( 'presence-lobby', 'client-typing', { userId: currentUserId } );
```

Everyone else on the channel receives it — you never get your own event back.
On the receiving end, check `meta.fromClient` before trusting the payload:

```js
bp.bind( 'client-typing', ( data, meta ) => {
	if ( meta.fromClient ) {
		showTypingIndicator( data.userId ); // treat as untrusted input
	}
} );
```

For anything that matters — orders, payments, notifications — publish from
your **server** instead (via a server SDK's `trigger()`), which is the only
path that isn't limited to `client-`-prefixed names or subject to a client
rate limit.

---

## 8. Live subscriber count

```js
bp.bind( 'subscription_count', ( data, meta ) => {
	updateViewerCount( meta.channel, data.count );
} );
```

Fires on every subscribe/unsubscribe/disconnect for a channel, to everyone
currently on it — no separate call needed, it's pushed automatically once
you're subscribed.

---

## 9. Sign in as a user (app-wide identity)

Separate from a channel's `authToken` — this establishes who a connection is
for the whole app, independent of any one channel. Needed for the watchlist
feature below.

```js
bp.bind( 'signin.succeeded', ( data ) => console.log( 'signed in as', data.user_id ) );
bp.bind( 'signin.failed',    ( data ) => console.log( 'refused:', data.reason ) );

bp.signin( token ); // same {expires}.{userId}.{hmac} shape as authToken
```

`signin()` auto-subscribes to the reserved `$signin` destination first if
you haven't already — that's where the reply arrives, so bind your handlers
*before* calling it.

---

## 10. Watch who's online

Requires a backend-minted **ops token** (the same identity the dashboard's
own live tiles use) — an ordinary end-user connection can't see this.

```js
bp.bind( 'watchlist.online',  ( data ) => console.log( data.user_id, 'came online' ) );
bp.bind( 'watchlist.offline', ( data ) => console.log( data.user_id, 'went offline' ) );

bp.watch();
```

Fires for every signed-in user app-wide — there's no per-user filtering yet,
so you get everyone's transitions, not a chosen subset.

---

## 11. Debugging

```js
Pulsely.logToConsole = true;
```

Prints a running trace — connection state changes, every `subscribe()` /
`unsubscribe()` call, and every dispatched event — prefixed `[Pulsely]`. Off
by default; flip it back to `false` when you're done.

---

## 12. Clean up

```js
bp.disconnect();
```

Deliberately closes the connection (no auto-reconnect afterward), and clears
local subscription/presence state. Call this on page unload if you want a
prompt server-side cleanup rather than waiting for the broker to notice the
socket died.

---

## Quick reference

| Method | What it does |
|---|---|
| `new Pulsely(appKey, options)` | Create a client. `options.authToken`, `options.url` |
| `bp.connect()` | Connect. Returns a promise |
| `bp.subscribe(channel)` / `bp.unsubscribe(channel)` | Join / leave a channel |
| `bp.bind(event, cb)` / `bp.unbind(event, cb)` | Listen for one event name |
| `bp.bindGlobal(cb)` / `bp.unbindGlobal(cb)` | Listen for every event |
| `bp.trigger(channel, event, data)` | Publish from the browser (`client-*` only) |
| `bp.signin(token)` | Sign in as a user, app-wide |
| `bp.watch()` | Subscribe to online/offline for the whole app |
| `bp.members(channel)` / `bp.memberCount(channel)` | Local presence roster read |
| `bp.isSubscribed(channel)` | Has the broker actually confirmed this channel |
| `bp.connection.bind('state_change', cb)` | Watch connect/disconnect/retry |
| `bp.disconnect()` | Close and stop retrying |
| `Pulsely.logToConsole = true` | Turn on debug tracing |

## Events you'll bind to

| Event | Fires when |
|---|---|
| *(your own event names)* | Something your server (or a client) published |
| `subscription_succeeded` | A channel subscribe was accepted |
| `subscription_error` | A channel subscribe was refused — `data.reason` |
| `subscription_count` | A channel's live subscriber count changed |
| `presence.subscription_succeeded` | You joined a presence channel — `data.members` |
| `presence.member_added` / `presence.member_removed` | Someone else joined/left |
| `signin.succeeded` / `signin.failed` | Result of `bp.signin()` |
| `watchlist.online` / `watchlist.offline` | A signed-in user came online/went offline |

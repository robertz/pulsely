# Pulsely

Multi-tenant realtime pub/sub, sold as infrastructure. BoxLang + ColdBox 8 + SocketBox
STOMP, MySQL for tenancy/metering.

## Running

```bash
mysql -u root < schema.sql
mysql -u root < seed-dev.sql
box server start
```

Existing databases created before the `channel_auth_rules` unique key was added
need `migrations/001-channel-auth-rules-unique.sql`; `schema.sql` already has it.

HTTP and WebSocket both on `:8085`; the STOMP endpoint is `ws://127.0.0.1:8085/ws`.

Marketing site: <http://127.0.0.1:8085/> · Dashboard: <http://127.0.0.1:8085/dashboard>
— dev login `dev@example.com` / `pulsely`.

## Surfaces

| Route | Auth | Purpose |
|---|---|---|
| `/`, `/pricing` | public | Landing page — hero, features, pricing, signup CTAs |
| `/dashboard/signup` | public | Create an account |
| `/dashboard/login` | public | Sign in |
| `/dashboard` | session | Apps list |
| `/dashboard/app/{appId}` | session | Keys, live tiles, usage, activity, channel rules |
| `POST /apps/{appId}/events` | HMAC | Trigger API |
| `GET /apps/{appId}/channels`, `GET /apps/{appId}/channels/{channelName}` | HMAC | Channels API |

Every application file is BoxLang: classes are `.bx`, templates are `.bxm`, and
tags are `<bx:…>`. There is no CFML left in the app — `.cfm`/`.cfc` files under
`coldbox/`, `modules/` and `testbox/` are vendored dependencies managed by
`box install` and are deliberately untouched. ColdBox resolves views and layouts
by probing `.cfm` then `.bxm`, so the `.bxm` versions are picked up with no
configuration.

Styling is three layers: `assets/css/base.css` holds the design tokens and
primitives shared by every surface, with `marketing.css` and `dashboard.css`
layered on top. Changing an accent or radius happens in one place.

**Pricing is rendered from the `plans` table**, not hardcoded, so published prices
and limits cannot drift from what the broker enforces — deactivating a plan removes
it from the page. There is no fabricated social proof anywhere on the site; every
claim maps to behavior covered by the test suites.

The "How it works" section is a five-step tabbed walkthrough (create → subscribe →
publish → secure → replay) carrying the real integration code. Its publish example
is not illustrative: `tests/docs-example-check.mjs` is a verbatim copy of what the
page prints and runs it against the live API, so the documentation cannot silently
drift from the signing scheme. The tabs follow the ARIA tabs pattern with arrow /
Home / End keys and a roving tabindex, and degrade to all steps stacked without JS.

## Tests

Everything, against a running server:

```bash
./tests/run-all.sh
```

TestBox specs alone — 115 specs, browser or curl:

```
http://127.0.0.1:8085/tests/runner.bxm?reporter=text
```

| Suite | Covers |
|---|---|
| `specs/unit/SignatureServiceSpec` | Trigger-API signing: tamper, replay across apps, clock window, UTC epoch |
| `specs/unit/PasswordServiceSpec` | PBKDF2 format, salting, iteration binding, malformed input |
| `specs/unit/ChannelAuthServiceSpec` | Glob matching, regex-metacharacter literals, webhook failure denies |
| `specs/unit/AppServiceSpec` | App id validation, `flagEnabled()` against driver booleans |
| `specs/unit/OpsServiceSpec` | Ops destination and token format, forgery resistance |
| `specs/integration/MeteringServiceSpec` | Counter upsert, connection tracking, peak high-water mark |
| `specs/integration/HistoryServiceSpec` | Replay shape and order, retention bounds, purge |
| `specs/integration/AccountServiceSpec` | Login, tenant scoping on every dashboard read/write |
| `specs/integration/WebSocketAuthSpec` | `authenticate()` / `authorize()` — isolation, ops gate, publish denial |
| `specs/integration/PlanServiceSpec` | Public pricing: ordering, price formatting, feature flags, inactive plans hidden |

The DB-backed specs create and drop their own tenant, so they never touch seeded
dev data. `AccountServiceSpec` and `WebSocketAuthSpec` do read the seeded dev and
"Other Account" rows, so run `seed-dev.sql` before them.

Protocol-level behavior that TestBox cannot reach — real STOMP frames, the auth
webhook round trip, HTTP status codes — stays in the shell and Node suites
(`api-cases.sh`, `dashboard-check.sh`, `limits-and-auth.sh`, `stomp-check.mjs`,
`auth-webhook-check.mjs`, `channels-check.mjs`), all wrapped by `run-all.sh`.

## Dashboard

Server-rendered ColdBox views; sessions hold the logged-in account and every query
is filtered by `account_id`, so one account cannot reach another's app by id.
Passwords are PBKDF2-HMAC-SHA256 (210k iterations) via `models/PasswordService.bx`.

**Plan entitlements** are enforced at the broker, not just displayed. `authorize()`
checks `allows_private_channels` / `allows_presence_channels` *before* consulting
`channel_auth_rules`, so configuring a rule cannot buy a feature the plan excludes.

**Login throttling:** five failed attempts on the same (client IP, email) pair
locks that pair for 15 minutes. The check runs before the password is verified, so
a locked-out attacker learns nothing and burns no hashing time. Keying on the pair
rather than the email alone means nobody can lock a victim out of their own account
by failing logins on their behalf. A distributed attack from many addresses is not
stopped by this — that needs a network-level control. State is in the application
scope, matching the single-node assumption elsewhere, and a scheduled task purges
stale records.

**CSRF:** every state-changing request into the `Dashboard` handler must carry a
valid token. Verification lives in `Dashboard.preHandler()` rather than cbcsrf's
auto-verifier, because that verifier throws from an interceptor during `preProcess`
— outside the event lifecycle — so a stale tab produced a raw 500 instead of a
redirect. Failing verification sends the user back to sign in with an explanatory
message. The trigger API is deliberately outside this: it lives in the `Events`
handler and authenticates with an HMAC signature, not a session.

Signup is self-service: name, email, and a password of at least 8 characters with
confirmation. Emails are lowercased on the way in and `accounts.email` is unique,
so case cannot be used to register the same address twice. New accounts are put on
the cheapest active plan — Sandbox as seeded — rather than a hardcoded plan name,
so introducing a different free tier needs no code change. Signup does not create a
starter app; new accounts land on the empty state and name their first app.

Surfaces:

| Route | What it shows |
|---|---|
| `/dashboard/signup` | Create an account — lands on the cheapest active plan |
| `/dashboard/login` | Sign in |
| `/dashboard` | All apps with today's messages, peak connections, plan |
| `/dashboard/app/{appId}` | Keys, live tiles, 14-day usage chart, live activity, channel rules |

### Live updates

The dashboard does not poll — it consumes Pulsely through the same public SDK
customers use. Each app has a reserved `$ops` destination:

- `message.published` — fired by the trigger API on every publish; drives the
  messages-today tile and the activity feed.
- `connections.changed` — fired on STOMP connect/close; drives the live
  connections tile.

Customer channel names may not begin with `$` (400 from the trigger API), so the
ops namespace cannot be squatted or published into from outside. Reading it
requires a short-lived token naming the reserved ops user, minted server-side per
page render, so the app secret never reaches the browser and an ordinary end-user
token for the same app cannot read the account's usage counters.

Ops events are deliberately **not metered** — they are our traffic, not the
customer's — and a failure to publish one can never break a customer publish or a
client connection.

## Architecture

Destinations are `{appId}.{channelName}`, where `appId` is the lowercased hex of
`apps.id`. Customers never see the prefix — the JS SDK and the trigger API add and
strip it. Tenant isolation is enforced in `authorize()`, which rejects any destination
outside the connection's own `{appId}.` prefix.

Everything runs on the STOMP broker's default direct exchange. A topic exchange is
deliberately not used: SocketBox topic exchanges are a publish-time routing table from
a wildcard pattern to a fixed destination list, fixed at exchange creation. They do not
let a subscriber subscribe by wildcard and cannot know about apps created after boot,
so the explicit prefix check in `authorize()` is required regardless — at which point a
topic exchange adds indirection without adding enforcement.

| Concern | Where |
|---|---|
| Connection auth, plan connection limit | `WebSocket.bx::authenticate()` |
| Namespace isolation, private/presence gate | `WebSocket.bx::authorize()` |
| History replay on subscribe | `WebSocket.bx::onSubscribe()` |
| Connection metering | `WebSocket.bx::onClose()`, `models/MeteringService.bx` |
| Publish, HMAC auth, daily limit | `handlers/Events.bx` |
| Peak-connection flush, history purge | `config/Scheduler.bx` |

## Connecting (browser)

Clients connect with the **public app key only** — a browser cannot hold `app_secret`.
Public channels need nothing more. `passcode` is optional and carries a short-lived
token, minted by the customer's backend, that establishes the user identity passed to
the private/presence auth webhook:

```
passcode = "{expiresEpochSeconds}.{userId}.{hmacSHA256Hex}"
hmac     = HMAC-SHA256(app_secret, "{app_key}:{expires}:{userId}")
```

```js
const bp = new Pulsely( 'devkey123' );
await bp.connect();
bp.subscribe( 'orders' );
bp.bind( 'created', ( data ) => console.log( data ) );
```

Clients may **never** publish. A STOMP `SEND` from a client connection is always
rejected; the trigger API is the only publish path.

## Trigger API

```
POST /apps/{appId}/events
X-Pulsely-Timestamp: {epochSeconds}
X-Pulsely-Signature: {hex}
{"channel":"orders","event":"created","data":{...}}
```

Signing string, joined with real newlines:

```
POST\n/apps/{appId}/events\n{timestamp}\n{sha256(body)}
```

signed HMAC-SHA256 with `app_secret`. The path and body hash are bound into the
signature so a captured one cannot be replayed against another app or payload;
timestamps outside `triggerAuthWindowSeconds` (default 600) are rejected.

Responses: `200` ok, `400` malformed, `401` bad signature, `404` unknown/inactive app,
`429` daily message limit reached.

## Channels API

Read-only occupancy state — channels are ephemeral, not persistent objects, so this
is the only way to find out what's currently live without maintaining your own
shadow registry. Signed the same way as the trigger API, with an empty body:

```
GET /apps/{appId}/channels
GET /apps/{appId}/channels/{channelName}
X-Pulsely-Timestamp: {epochSeconds}
X-Pulsely-Signature: {hex}
```

```
GET\n/apps/{appId}/channels\n{timestamp}\n{sha256("")}
```

Only the route path is signed — query params (`filter_by_prefix`, `info`) are never
part of the signing string.

`GET /apps/{appId}/channels` returns every occupied channel as a map of
`channel_name -> {}`:

```json
{ "channels": { "orders": {}, "presence-lobby": {} } }
```

- `?filter_by_prefix=presence-` scopes the result to channel names with that prefix.
- `?info=user_count` includes `{ "user_count": N }` inline for presence channels,
  instead of `{}`.

`GET /apps/{appId}/channels/{channelName}` returns detail for one channel — always
`200`, since "not occupied" is a normal state, not a missing resource:

```json
{ "occupied": true, "subscription_count": 3, "user_count": 2 }
```

`user_count` (distinct presence members, not connection count) only appears for
`presence-` channels. `subscription_count` counts live subscriptions (tabs), which
can exceed `user_count` when one user has multiple tabs open.

Responses: `200` ok, `400` malformed channel name, `401` bad signature, `404`
unknown/inactive app.

## Administration

An account with `is_admin` reaches `/admin`, which lists every account with its
plan, app count and usage today, and can:

- change any account's plan (the only way to move between tiers, since there is
  no billing)
- suspend or reactivate an account — `is_active` gates sign-in, so a suspended
  account is refused at login and is indistinguishable from a wrong password
- grant or revoke administrator access

**The authorization is server-side on every action**, not a hidden nav link.
`Admin.preHandler()` re-reads `is_admin` from the database on each request rather
than trusting the session, so revoking it takes effect immediately. A signed-in
non-admin POSTing straight at `/admin/setPlan` changes nothing — covered by
`tests/admin-check.sh`.

Three guards stop an administrator locking everyone out: you cannot suspend
yourself, you cannot revoke your own access, and the last remaining administrator
cannot be demoted.

App secrets are deliberately not shown in the console. Administration covers plans
and access, not reading a customer's credentials.

## Event webhooks

Your backend does not need to hold a socket open to react to what happens in a
channel. Register an endpoint and Pulsely POSTs to it.

| Event | Fires when |
|---|---|
| `channel_occupied` | the first subscriber joins a channel |
| `channel_vacated` | the last subscriber leaves |
| `member_added` | someone joins a presence channel |
| `member_removed` | they leave it |
| `client_event` | a browser publishes a client event |

```json
{
  "event": "channel_occupied",
  "data": { "channel": "orders" },
  "app_id": "a3f1…",
  "created_at": "2026-07-28T09:14:22"
}
```

Each request carries `X-Pulsely-Timestamp` and `X-Pulsely-Signature`, signed
with your app secret using **the same four-line scheme as the trigger API** — so
the server SDK verifies it with code you already have:

```js
app.post( '/pulsely/webhook', express.raw( { type: 'application/json' } ), ( req, res ) => {
	if ( !bp.verifyWebhook( req.body, req.headers ) ) return res.sendStatus( 401 );
	handle( JSON.parse( req.body ) );
	res.sendStatus( 200 );
} );
```

Verify against the **raw** body — a re-serialized object will not match.

**Delivery is queued, never inline.** A customer endpoint that hangs must not stall
the broker thread that produced the event, so events go onto a queue and a
scheduled task drains it every five seconds. Non-2xx responses retry with backoff
(10s, 1m, 5m, 30m) up to five attempts, after which the row stops being retried but
stays visible for debugging. Recent deliveries and their status are shown on the
app page in the dashboard.

Endpoints only receive the event types they subscribed to, and registering the
same URL twice updates it rather than creating a duplicate.

## Client-published events

By default only your server publishes, via the signed trigger API. Client events
let browsers publish straight to each other — useful for typing indicators, cursor
positions and reactions, where a round trip through your backend is wasted work.

Because the app key is public and ships in every frontend bundle, this is
deliberately narrow. All of the following must hold:

| Guard | Why |
|---|---|
| Off unless the app opts in (`apps.allows_client_events`) | The default cannot be "any visitor may broadcast" |
| `private-` / `presence-` channels only | Public channels would let any visitor reach every other one |
| Must already be subscribed to that channel | Subscribing means your auth endpoint approved them |
| Event name must start with `client-` | A client can never impersonate a server event your handlers trust |
| 10 events/second per connection | One abusive tab cannot flood a channel |
| 10 KB per payload | — |

```js
bp.subscribe( 'private-chat-42' );
bp.trigger( 'private-chat-42', 'client-typing', { user: 'ada' } );

bp.bind( 'client-typing', ( data, meta ) => {
	// meta.fromClient === true — this came from a browser, not your server.
	showTypingIndicator( data.user );
} );
```

Client events are **metered** like any other message but are **not written to
history**: they are ephemeral, and persisting them would let any connected browser
write rows into your history table indefinitely. Senders do not receive their own
events back.

The payload is untrusted input. `meta.fromClient` tells your handler which
messages came from a browser rather than your server — validate those.

Toggle it per app from the app page in the dashboard.

## Presence channels

Subscribing to a `presence-` channel joins a live roster. The auth endpoint names
the subscriber by returning `user_id` and optional `user_info` alongside
`authorized`; if it returns only `authorized`, the connection token's identity is
used instead.

Three events are delivered on the channel:

| Event | Sent to | Payload |
|---|---|---|
| `presence.subscription_succeeded` | the joiner only | `{ members, me, count }` |
| `presence.member_added` | everyone else | `{ member, count }` |
| `presence.member_removed` | everyone else | `{ member, count }` |

Membership is tracked per connection but **reported per user**: someone with three
tabs open is one member, and only their first arrival and last departure produce an
event. A dropped socket is cleaned up on close, so a member cannot linger after a
browser crash.

The SDK keeps a local roster in step with these events:

```js
bp.subscribe( 'presence-lobby' );

bp.bind( 'presence.subscription_succeeded', () => renderMembers( bp.members( 'presence-lobby' ) ) );
bp.bind( 'presence.member_added',   ( d ) => addMember( d.member ) );
bp.bind( 'presence.member_removed', ( d ) => removeMember( d.member ) );

bp.members( 'presence-lobby' );      // [{ user_id, user_info }, …]
bp.memberCount( 'presence-lobby' );  // distinct users
```

Presence requires a plan with `allows_presence_channels` and a matching rule in
`channel_auth_rules`, the same as private channels.

## Private and presence channels

Channels prefixed `private-` or `presence-` require a matching row in
`channel_auth_rules` with an `auth_webhook_url`. The broker POSTs
`{channel_name, socket_id, user_token}` to the customer's endpoint and honors
`{"authorized": true|false}`. Any timeout, non-200, or malformed response denies.

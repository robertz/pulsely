# Pulsely server SDKs

Thin clients for the server side: publish events, mint browser connection tokens,
and answer channel authorization requests. Each is dependency-free and small
enough to read in one sitting.

| Language | File | Verified against a live broker |
|---|---|---|
| Node.js 18+ | `node/pulsely.mjs` | yes |
| Python 3.8+ | `python/pulsely.py` | yes |
| BoxLang / CFML | `boxlang/Pulsely.bx` | yes |
| PHP 7.4+ | `php/Pulsely.php` | **no — see below** |

`tests/sdk-check.mjs` drives every verified SDK through a real publish, a rejected
publish, and a connection token that must survive an actual STOMP CONNECT. It also
asserts all three produce **byte-identical signatures** for a fixed payload, so a
divergence in any one of them fails the build.

The PHP client is written to the same specification but there is no PHP runtime on
this machine, so it has not been executed. Before relying on it, run the same three
checks against your broker.

## What each one does

```
trigger( channel, event, data )      publish an event            → your backend
authToken( userId, ttl )             mint a browser passcode     → your login flow
authorizeChannel( … )                answer an auth request      → your auth endpoint
```

### Publish

```js
// Node
const bp = new Pulsely( { appId, appKey, appSecret, baseUrl } );
await bp.trigger( 'orders', 'created', { id: 42 } );
```

```python
# Python
bp = Pulsely(app_id=..., app_key=..., app_secret=..., base_url=...)
bp.trigger("orders", "created", {"id": 42})
```

```
// BoxLang
pulsely = new Pulsely( appId = "…", appKey = "…", appSecret = "…" );
pulsely.trigger( "orders", "created", { "id" : 42 } );
```

Non-2xx responses raise a typed error (`PulselyError`) carrying the status and
parsed body, rather than returning silently.

### Connection tokens

Public channels need no token. For private and presence channels, mint one when
the user logs in and hand it to the browser:

```js
const token = bp.authToken( user.id );   // "{expires}.{userId}.{hmac}"
```

The browser passes it to the SDK as `authToken`; your auth endpoint later receives
that identity as `user_token`.

### Auth endpoint

```js
app.post( '/pulsely/auth', ( req, res ) => {
	const user = userFromToken( req.body.user_token );
	res.json( bp.authorizeChannel( {
		authorized: canSee( user, req.body.channel_name ),
		userId: user.id,
		userInfo: { name: user.name }
	} ) );
} );
```

## Why use these rather than rolling your own

The signing scheme is simple but has four sharp edges, and each one surfaces as an
unexplained `401`:

1. **Serialize the body once and send those exact bytes.** Signing one JSON string
   and letting your HTTP client re-serialize the object gives a different key order
   and a signature that no longer matches.
2. **Epoch seconds, not milliseconds**, derived in UTC.
3. **Real newlines** in the signing string. In CFML/BoxLang `"\n"` is two literal
   characters — use `char( 10 )`.
4. **Lowercase hex** for both the body hash and the signature.

The SDKs get all four right.

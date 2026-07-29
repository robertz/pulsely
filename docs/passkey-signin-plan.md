# Passkey sign-in — implementation plan

Status: **shelved**, not started. Written 2026-07-28 against the current
password-only auth in `app/handlers/Dashboard.bx` and `app/models/PasswordService.bx`.

## Recommendation

Ship passkeys as an **alternative to the password, not a replacement**, for v1.

Passkey-only accounts create an account-recovery problem: a user who loses their
only authenticator is locked out permanently, and we have no email-based recovery
flow today. Keeping the password as a fallback sidesteps that entirely and avoids
having to make `accounts.password_hash` nullable.

## Prerequisite: a WebAuthn library

`lib/java/` is empty and there is no WebAuthn dependency in `box.json`.

Verifying a registration or assertion by hand means CBOR decoding, COSE key
parsing, ES256/RS256/EdDSA signature verification, attestation statement
handling, and authenticator-data flag and counter checks. That is not something
to hand-roll next to a 76-line `PasswordService`.

Plan: drop [webauthn4j](https://github.com/webauthn4j/webauthn4j) (or Yubico's
`java-webauthn-server`) jars into `lib/java/` and call them via
`createObject( "java", ... )` — the same pattern `PasswordService.bx` already
uses for PBKDF2.

This is the single biggest decision in the whole feature; everything below
assumes it is resolved first.

## Schema

New migration `resources/database/migrations/005-passkeys.sql`, following the
existing numbering.

```sql
CREATE TABLE account_credentials (
    id                BINARY(16)      NOT NULL PRIMARY KEY,
    account_id        BINARY(16)      NOT NULL,
    credential_id     VARBINARY(255)  NOT NULL,
    public_key_cose   VARBINARY(1024) NOT NULL,
    sign_count        BIGINT          NOT NULL DEFAULT 0,
    aaguid            BINARY(16)      NULL,
    transports        VARCHAR(255)    NULL,
    label             VARCHAR(100)    NOT NULL,
    last_used_at      DATETIME        NULL,
    created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_credential_id (credential_id),
    KEY idx_account (account_id)
) ENGINE=InnoDB;
```

Challenges can live in `session` rather than a `webauthn_challenges` table —
simpler, and we already keep `session.account`.

The **user handle** must be a stable opaque per-account value, never the email.
`accounts.id BINARY(16)` already satisfies this; reuse it.

If we ever do go passkey-only, `accounts.password_hash` is `NOT NULL` and would
need to become nullable. Not required for the recommended v1 scope.

## Server

New `app/models/PasskeyService.bx` singleton, alongside `PasswordService.bx`,
with four entry points:

- `startRegistration( accountId )` — challenge plus `excludeCredentials`;
  challenge stashed in session
- `finishRegistration( accountId, clientResponse )` — verify, insert row
- `startAuthentication()` — challenge, empty `allowCredentials` for the
  usernameless / discoverable-credential flow
- `finishAuthentication( clientResponse )` — verify, resolve user handle to
  account, bump `sign_count`

Four new routes in `app/config/Router.bx`, as JSON POST endpoints rather than
form posts:

```
route( "/dashboard/passkey/register/start"  ).withAction( { POST : "passkeyRegisterStart"  } ).toHandler( "Dashboard" );
route( "/dashboard/passkey/register/finish" ).withAction( { POST : "passkeyRegisterFinish" } ).toHandler( "Dashboard" );
route( "/dashboard/passkey/login/start"     ).withAction( { POST : "passkeyLoginStart"     } ).toHandler( "Dashboard" );
route( "/dashboard/passkey/login/finish"    ).withAction( { POST : "passkeyLoginFinish"    } ).toHandler( "Dashboard" );
```

Both flows converge on setting `session.account`, so everything downstream of
authentication is unchanged.

## Existing code that will bite

1. **CSRF.** `preHandler` (`app/handlers/Dashboard.bx:17`) fails closed on every
   non-GET request and reads `rc.csrf`. The passkey endpoints are `fetch()` calls
   with JSON bodies and will not carry a form field. Send the token in the JSON
   body or a header and teach `preHandler` to look there. **Most likely thing to
   break silently.**

2. **The public-action list.** `[ "login", "doLogin", "logout", "signup",
   "doSignup" ]` at `app/handlers/Dashboard.bx:27` must gain the two passkey
   *login* actions — but **not** the register actions, which correctly require an
   existing session.

3. **Throttling.** `LoginThrottleService` is keyed on `( clientIP, email )`.
   Usernameless passkey login has no email at the start. Key on IP alone for that
   path, or skip it — a passkey assertion is not brute-forceable the way a
   password is, so IP-only rate limiting is defensible.

4. **RP ID and origin.** Must be configured, not inferred from `cgi`, or we
   inherit a Host-header trust problem. Add `PASSKEY_RP_ID` and `PASSKEY_ORIGIN`
   to `.env` and `.env.example`. Localhost dev works over http; everything else
   is HTTPS-only.

## Client

`public/assets/js/passkeys.js`, roughly 80 lines of vanilla JS matching the
no-build style of `marketing-tabs.js`: base64url helpers,
`navigator.credentials.create` / `.get`, and feature detection that hides the
button when `window.PublicKeyCredential` is absent.

UI:

- "Sign in with a passkey" button on `app/views/dashboard/login.bxm`
- passkey management list on the account page — add, rename, delete, showing
  `last_used_at`

## Estimate

- 2–3 days for a working passkey-alongside-password flow. Most of it is the
  webauthn4j integration and the CSRF/JSON plumbing, not the happy path.
- +1 day for the management UI and `tests/` coverage in the existing
  `dashboard-check.sh` style.

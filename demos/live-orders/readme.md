# Live Orders — Pulsely demo

A self-contained page that exercises a real Pulsely integration end to end.
Zero dependencies, Node 18+. Everything it needs is vendored into this folder,
so it can be copied out and served on its own.

```bash
node demos/live-orders/server.mjs
```

Then open <http://127.0.0.1:3000> — **in two tabs**, which is the whole point.

## What it demonstrates

| | |
|---|---|
| **Signed publish** | The browser asks the demo's server to publish; the server signs with the app secret. The secret never reaches the page. |
| **Fan-out** | One publish lands in every open tab over a WebSocket. Nothing polls. |
| **History & replay** | Reload a tab: recent messages replay first, dimmed and dashed, before the live stream resumes. Needs a plan with history — the dev seed account is on Business, which has it. |
| **Private channels** | Subscribing to `private-ops` makes Pulsely call this demo's own `/dev-auth` endpoint first. |
| **Refusal** | "Join anonymously" presents no connection token, the auth endpoint says no, and the broker refuses the subscribe. The failure is the demonstration. |
| **Clients cannot publish** | Every publish path here goes through the server, because a STOMP `SEND` from a browser is always rejected. |

## The three roles

A real integration has three server-side jobs, and `server.mjs` plays all of them:

1. **Your backend** — `POST /api/publish` signs and publishes via the SDK
2. **Your token minter** — `POST /api/token` mints a short-lived connection token
3. **Your auth endpoint** — `POST /dev-auth` answers Pulsely's authorization webhook

In production these live in your own app; they are together here so the demo is
one file you can read top to bottom.

## Credentials

Defaults are the throwaway values from `resources/database/seed-dev.sql`
(`devkey123` / `devsecret456`), which are already committed to this repo and are
not secrets.

To run it against your own app, copy `.env.example` to `.env` and fill in the
values from `/dashboard/app/{appId}`. `.env` is gitignored at the repo root.

## Private channels need one setting

The seed ships an auth rule for `private-*` pointing at
`http://127.0.0.1:8080/dev-auth`, but this demo serves on **3000**. Point the
rule at the demo before the private-channel panel will work:

- open `/dashboard/app/{appId}`
- edit the `private-*` rule's auth endpoint to `http://127.0.0.1:3000/dev-auth`

Or run the demo on 8080 instead (`PORT=8080`), if nothing else is using it.

The public `orders` channel needs none of this and works immediately.

## Presence channels

Not wired up. Presence needs a `presence-*` auth rule, which the dev seed does
not include — add one in the dashboard pointing at the same `/dev-auth`
endpoint, and note that presence is also plan-gated.

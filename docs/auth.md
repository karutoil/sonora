# Authentication & account security

How someone gets into sonora, how long they stay in, and how they get every other
device out.

This is a single-instance app with accounts stored in SQLite. There is no email,
no password reset link, and no third-party identity provider. That makes the
threat model narrow, and it makes the *account lifecycle* the interesting part:
devices that stay signed in, and passkeys that replace a typed passphrase.

## The three credentials

| Credential | Where it lives | Lifetime | Revoked by |
| --- | --- | --- | --- |
| Access token (`sonora_session`) | HttpOnly cookie, signed HMAC | `SONORA_SESSION_MINUTES` (12 h) | session-version bump, device deletion, account disable, expiry |
| Refresh token (`sonora_refresh`) | HttpOnly cookie, opaque; only its SHA-256 is stored | `SONORA_REFRESH_DAYS` (30 d) | rotation, device deletion, "forget", sign-out |
| Passkey | Public key in `passkeys`, private key on the device | until removed | removing the passkey |

The access token is **stateless** (a signed payload), which is what keeps a
phone's many ranged audio requests cheap. It carries `uid`, `ver` (the user's
`session_version`), `sid` (the device id) and `exp`, and every request re-reads
the user row, so:

- disabling an account takes effect immediately (not when the cookie expires);
- a role change takes effect immediately;
- bumping `session_version` invalidates every token ever issued;
- deleting the device row invalidates every token that names it.

The last point is what makes per-device revocation real on a stateless session.

## Remember me

Without it, the access cookie is **session-scoped** and a browser restart signs
the device out. With it, the access cookie gets a `Max-Age` and the server also
issues a refresh token, so a tab left open overnight (or a PWA resumed a week
later) renews itself silently.

Refresh tokens **rotate**: each use revokes the presented token and returns a new
one. The replacement starts a fresh `SONORA_REFRESH_DAYS` clock, so the lifetime
bounds an *unused* remembered device, not a tab that keeps renewing itself.
Rotation is not idempotent, and one browser is more than one tab, so a replay is
judged by *when* it arrives:

- **Within `SONORA_REFRESH_GRACE_MS`** (default 30 000 ms) of the rotation, a
  replay is read as a race. The chain is walked forward to its newest link, that
  link is rotated, and the presenter gets a fresh access cookie and a fresh
  refresh token with `200`. Nothing is revoked, so a tab whose response was lost in
  flight — or two tabs refreshing at the same moment — stay signed in.
- **After the window**, a replay is treated as theft: the whole device is deleted
  (refresh tokens revoked, device row gone, so the access cookie stops working on
  the next request) and a `refresh_replay` row is written to the audit log
  (*Admin → audit*). Both the thief and the legitimate client must sign in again.

The window is a deliberate trade, and it is worth knowing what it costs: a refresh
token copied out of a browser-profile backup, a synced cookie jar or an old log
and presented inside those 30 seconds is indistinguishable from the race above, so
it converts into a live session. The audit row is written on the theft path, not
on the graced one, so such a replay leaves no explicit trace. If that matters more
to you than a rare spurious sign-out, set `SONORA_REFRESH_GRACE_MS=0`: rotation
becomes strictly one-shot and every presentation of an already-used token is
theft.

The client still funnels every `401` through a single shared refresh promise
rather than firing one per request, which is what keeps the race rare in the first
place.

"Remember me" is reversible after the fact: *Account → Security* can forget a
device, which destroys its refresh token and (for the current device) re-issues
the access cookie without a `Max-Age`.

## Devices

One browser is one row, keyed by a stable id in `localStorage` (the same id the
player already uses to tell "the same device resuming" from "another device
taking over"). Signing in again from the same browser updates the row instead of
adding one.

From *Account → Security* a person can rename a device, sign it out, forget it,
sign out every other device, or sign out everywhere. All of it is per-user:
another account's devices are invisible.

`admin → users` shows a per-user passkey and device count, and an administrator's
"sign out" for a user also destroys that user's devices and refresh tokens — so a
disabled or reset account cannot quietly renew itself.

## Passkeys (WebAuthn)

Registration and authentication both use `@simplewebauthn/server`, with the
challenge stored server-side in `webauthn_challenges` and bound to a short-lived
cookie (one per ceremony — `sonora_webauthn_register` / `sonora_webauthn_login`,
5 minutes; the old shared `sonora_webauthn` name is still read so a ceremony
started before a deploy can finish). A challenge is consumed on first use,
including on a failed verification, so it cannot be replayed.

Design decisions worth knowing:

- **`userVerification: 'required'`** — a passkey sign-in is a real presence +
  verification check, not a "something you have" only flow.
- **Discoverable credentials** — login does not need a username. If a name *is*
  typed, it is only a hint: an unknown name still gets valid options, so the
  endpoint cannot be used to enumerate accounts.
- **Counter regression is rejected for single-device credentials only.** A stored
  counter that goes backwards is the clone signal, and the attempt is audited
  (`passkey_replay`). Synced credentials (iCloud Keychain, Google Password Manager)
  re-derive their counter on a new device, so a `backed_up` passkey is exempt from
  the check entirely; its counter is still stored from every assertion.
- **RP ID and origin come from the request** (`x-forwarded-host` /
  `x-forwarded-proto` honoured only while `SONORA_TRUST_PROXY` is on — the same
  switch that governs `req.ip`, so a client cannot poison the origin a passkey
  is bound to), overridable with `SONORA_RP_ID` / `SONORA_ORIGIN`. Only the *last*
  value of a comma-separated forwarding header is read — the hop in front of the
  process, never the caller's own. Behind a tunnel that rewrites `Host`, set them
  explicitly.

### Why passkeys are refused on an IP address

A passkey is scoped to a *registrable domain*. `http://localhost:8130` is a
secure context and works. `http://192.168.1.50:8130` is not, and can never be:
the browser will not even offer the prompt. Rather than failing mysteriously, the
server reports `supported: false` with a reason, and the UI shows that reason
instead of a button that cannot work.

This matters because it is the common way to open a self-hosted app on a phone.
The honest fix is a domain (a tunnel, or a reverse proxy with TLS), not a code
change.

## What the client does

- `POST /api/auth/login` with `{name, passphrase, remember, deviceId, deviceName, platform?}`.
  `deviceId` is the browser's own localStorage id, which is what keeps one browser
  one device row across many sign-ins.
- Any non-auth `/api/*` call that answers `401` triggers **one** shared
  `POST /api/auth/refresh`; on success the original request is retried once.
- A failed *login* is not a lost session: the form shows the server's message
  (`Wrong name or passphrase.`) and stays open.
- `429` is translated to "Too many attempts. Wait a minute and try again." Two
  different limiters can produce it: the per-IP window below, and a per-account
  lockout that needs no IP rotation — five wrong attempts for one name, then a
  wait that starts at 30 s and doubles per further failure, capped at 15 minutes,
  answered with `Retry-After`. That counter lives in memory, so a restart clears
  it.
- CSRF is refused server-side, not inferred. Every `/api/*` mutation that carries a
  credential cookie (session, refresh, WebAuthn ceremony or room guest) is rejected
  when `Sec-Fetch-Site` is anything but `same-origin`/`none`, and when a present
  `Origin` is not the request's own origin. Any request carrying a body must also
  declare `content-type: application/json` (`415` otherwise), which an HTML form
  cannot send without a preflight. `SameSite=Lax` is the third layer, not the
  only one.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/capabilities` | has users, passkey support + reason, token lifetimes |
| POST | `/api/auth/login` | passphrase sign-in (rate limited) |
| POST | `/api/auth/refresh` | rotate the refresh token, re-issue access (its own 60-a-minute per-IP limit) |
| POST | `/api/auth/logout` | end this device and forget it |
| GET | `/api/me` | current user, device id, remembered flag, hasPasskeys, `sessionMinutes` (what the client schedules its silent renewal from) |
| GET | `/api/auth/security` | session summary, passkeys, devices, capabilities |
| GET | `/api/auth/passkeys` | this user's registered passkeys |
| POST | `/api/auth/passkey/register/options` | start passkey registration |
| POST | `/api/auth/passkey/register/verify` | finish registration |
| POST | `/api/auth/passkey/login/options` | start passkey sign-in |
| POST | `/api/auth/passkey/login/verify` | finish sign-in |
| PATCH | `/api/auth/passkeys/:id` | rename a passkey |
| DELETE | `/api/auth/passkeys/:id` | remove a passkey |
| PATCH | `/api/auth/devices/:id` | rename, `{remembered:false}` to forget, or `{remembered:true}` to remember *this* device (`409` for another device, which this browser cannot hand a cookie to) |
| DELETE | `/api/auth/devices/:id` | sign one device out |
| POST | `/api/auth/devices/revoke-others` | sign out everything but this device |
| POST | `/api/auth/signout-all` | sign out everywhere, including here |

## Configuration

```sh
SONORA_SECRET=                 # HMAC key for the session and room-guest cookies, and the AES key for the stored YouTube jar; unset, a random per-process key is used and every session dies on restart
SONORA_SESSION_MINUTES=720     # access token lifetime
SONORA_REFRESH_DAYS=30         # how long "remember me" lasts; renewed by every rotation
SONORA_SESSION_DAYS=           # legacy alias, read only when SONORA_REFRESH_DAYS is unset; it also still feeds the admin panel's "session days" (90 when unset)
SONORA_REFRESH_GRACE_MS=30000  # a replay this soon after rotation is a race, not theft; 0 = strict
SONORA_SECURE_COOKIES=auto     # auto | always | never; auto sets Secure over HTTPS and on localhost/.localhost
SONORA_LOGIN_RATE_MAX=10       # sign-in attempts per window, per client IP
SONORA_LOGIN_RATE_WINDOW="1 minute"
SONORA_RP_ID=                  # passkey RP ID; defaults to the request hostname
SONORA_ORIGIN=                 # passkey expected origin; defaults to the request origin
SONORA_RP_NAME=sonora          # the name the browser shows in its passkey prompt
SONORA_TRUST_PROXY=0           # 0 = direct, 1 = a loopback proxy, or the proxy's own IPs/CIDRs
```

`SONORA_TRUST_PROXY` is a list of peers, not a hop count: `0` (the default) trusts
no forwarding header at all, `1` is the alias for `loopback`, and any other
deployment must name the proxy's address or network (`10.0.0.0/8`,
`fd00::/8`, …). A count above `1` and a plain `true` are rejected at boot, because
both let a client pick its own `req.ip`, `req.host` and scheme — which is a
login-rate-limit bypass and a passkey-origin poisoning in one.

`SONORA_SECURE_COOKIES` exists for the setups a request cannot describe (a TLS
terminator that does not forward the scheme). `auto` is the honest default:
`Secure` over HTTPS, and over plain HTTP only on `localhost`, which browsers treat
as a secure context — so signing in on `http://192.168.1.50:8130` works instead of
silently dropping the cookie.

## Housekeeping

At boot, and then hourly, one sweep deletes expired refresh tokens, expired
WebAuthn ceremonies, devices not seen for 60 days, and idle rooms. The device
prune spares a device that still holds an unexpired refresh token — with
`SONORA_REFRESH_DAYS` above 60 that device is legitimately signed in. Devices
cascade their refresh tokens; users cascade their devices, passkeys and ceremonies.

## Tests

- `test/auth.test.js` — HTTP-level: rotation, replay detection, the rotation grace
  window, revocation, remember/forget, per-account lockout, challenge single-use,
  no account enumeration, the per-request `Secure` decision.
- `test/passkey.test.js` — real Chromium with a CDP virtual authenticator (skipped
  when Chromium is not installed): registers a passkey, signs in with it, signs out
  everywhere, removes it.

Last verified against the working tree at `2339565` on 2026-11-12.

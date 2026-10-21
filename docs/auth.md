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
| Access token (`sonora_session`) | HttpOnly cookie, signed HMAC | `SONORA_SESSION_MINUTES` (12 h) | session-version bump, device deletion, expiry |
| Refresh token (`sonora_refresh`) | HttpOnly cookie, opaque; only its SHA-256 is stored | `SONORA_REFRESH_DAYS` (30 d) | rotation, device deletion, "forget", sign-out |
| Passkey | Public key in `passkeys`, private key on the device | until removed | removing the passkey |

The access token is **stateless** (a signed payload), which is what keeps a
phone's many ranged audio requests cheap. It carries `uid`, `ver` (the user's
`session_version`) and `sid` (the device id). Every request re-reads the user
row, so:

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
one. Presenting an already-used token is treated as theft — the entire device is
deleted, and both the thief and the legitimate client must sign in again. Two
tabs racing the same token is handled by the same rule, which is why the client
funnels every 401 through a single shared refresh promise rather than firing one
per request.

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
cookie. A challenge is consumed on first use, including on a failed verification,
so it cannot be replayed.

Design decisions worth knowing:

- **`userVerification: 'required'`** — a passkey sign-in is a real presence +
  verification check, not a "something you have" only flow.
- **Discoverable credentials** — login does not need a username. If a name *is*
  typed, it is only a hint: an unknown name still gets valid options, so the
  endpoint cannot be used to enumerate accounts.
- **Counter regression is rejected.** Many platform passkeys legitimately report
  `0` forever, so only a real decrease on a non-zero counter is treated as a
  cloned authenticator.
- **RP ID and origin come from the request** (`x-forwarded-host` /
  `x-forwarded-proto` honoured), overridable with `SONORA_RP_ID` / `SONORA_ORIGIN`.
  Behind a tunnel that rewrites `Host`, set them explicitly.

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

- `POST /api/auth/login` with `{name, passphrase, remember, deviceId, deviceName}`.
- Any non-auth `/api/*` call that answers `401` triggers **one** shared
  `POST /api/auth/refresh`; on success the original request is retried once.
- A failed *login* is not a lost session: the form shows the server's message
  (`Wrong name or passphrase.`) and stays open.
- `429` is translated to "Too many attempts. Wait a minute and try again."
- CSRF is handled by `SameSite=Lax` cookies plus a JSON-only body parser: a
  cross-origin form post cannot set `content-type: application/json` without a
  preflight.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/capabilities` | has users, passkey support + reason, token lifetimes |
| POST | `/api/auth/login` | passphrase sign-in (rate limited) |
| POST | `/api/auth/refresh` | rotate the refresh token, re-issue access |
| POST | `/api/auth/logout` | end this device and forget it |
| GET | `/api/me` | current user, device id, remembered flag, hasPasskeys |
| GET | `/api/auth/security` | session summary, passkeys, devices, capabilities |
| POST | `/api/auth/passkey/register/options` | start passkey registration |
| POST | `/api/auth/passkey/register/verify` | finish registration |
| POST | `/api/auth/passkey/login/options` | start passkey sign-in |
| POST | `/api/auth/passkey/login/verify` | finish sign-in |
| PATCH | `/api/auth/passkeys/:id` | rename a passkey |
| DELETE | `/api/auth/passkeys/:id` | remove a passkey |
| PATCH | `/api/auth/devices/:id` | rename, or `{remembered:false}` to forget |
| DELETE | `/api/auth/devices/:id` | sign one device out |
| POST | `/api/auth/devices/revoke-others` | sign out everything but this device |
| POST | `/api/auth/signout-all` | sign out everywhere, including here |

## Configuration

```sh
SONORA_SESSION_MINUTES=720   # access token lifetime
SONORA_REFRESH_DAYS=30       # how long "remember me" lasts
SONORA_LOGIN_RATE_MAX=10     # sign-in attempts per window, per client IP
SONORA_LOGIN_RATE_WINDOW="1 minute"
SONORA_RP_ID=                # passkey RP ID; defaults to the request hostname
SONORA_ORIGIN=               # passkey expected origin; defaults to the request origin
SONORA_RP_NAME=sonora        # the name the browser shows in its passkey prompt
```

## Housekeeping

At boot the server deletes expired refresh tokens, expired WebAuthn ceremonies,
and devices not seen for 60 days. Devices cascade their refresh tokens; users
cascade their devices, passkeys and ceremonies.

## Tests

- `test/auth.test.js` — HTTP-level: rotation, replay detection, revocation,
  remember/forget, challenge single-use, no account enumeration.
- `test/passkey.test.js` — real Chromium with a CDP virtual authenticator:
  registers a passkey, signs in with it, signs out everywhere, removes it.

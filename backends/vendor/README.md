# Vendored third-party code

`pocketbase.umd.js` — the PocketBase **JS SDK**, vendored so the app does not
depend on a CDN being up and so the version is pinned in the repo instead of
floating.

| | |
| --- | --- |
| package | `pocketbase` (MIT) — https://github.com/pocketbase/js-sdk |
| version | `0.28.1` (latest published at the time of writing) |
| file | `dist/pocketbase.umd.js` from the npm tarball |
| bytes | 40734 |
| sha256 | `08bb483d6d83a3b95491aa3700ac59370a960cc864ac19784acfafa68ad0b233` |
| global | exposes `window.PocketBase` |

**Why vendored rather than from a CDN.** The app is a static GitHub Pages site
with no build step, and the backend it talks to is the only network dependency
it should have. A CDN URL would add a second one (and a supply-chain hop) for a
40 KB file. `pocketbase-config.js` still has a `libUrl` field if a different
build ever needs to be tested.

**Version note.** The deployed backend reports PocketBase **0.40.4**, which is
ahead of the newest published JS SDK (`0.28.1`). Every endpoint this app uses —
`auth-methods`, `auth-with-oauth2`, `trips/trip_members/trip_invites/trip_docs`
records — is served by that SDK version correctly (verified against the live
backend; see the app README's *What was verified* section). All of them are long
stable in PocketBase. If the OAuth2 popup flow ever misbehaves, this file is the
first thing to bump: re-download from npm, update the version/sha256 above, and
nothing else changes.

**Updating it:**

```sh
npm pack pocketbase@<version>          # in a scratch dir
tar xzf pocketbase-<version>.tgz
cp package/dist/pocketbase.umd.js backends/vendor/pocketbase.umd.js
shasum -a 256 backends/vendor/pocketbase.umd.js
```

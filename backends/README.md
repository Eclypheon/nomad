# Backends — the swappable layer

`app.js` renders the trip, owns the Decisions tab and never talks to a server.
It talks to **`auth.js`**, a thin facade over exactly one *backend adapter* in
this directory.

**Deployed adapter:** `pocketbase-adapter.js` — the self-hosted PocketBase on
alienlab, addressed by `pocketbase-config.js` (the only file in the repo that
knows the backend's address) and reachable on the public internet through a
Tailscale Funnel, so a friend needs no tailnet membership and no key.

With `backendBase` empty in `pocketbase-config.js` there is no adapter to
configure, nothing loads, no request is made, and the app is the purely local,
offline site it started as: `data/*.json` on the device, picks in
`localStorage`.

## Why it is shaped this way

Local mode, the Decisions tab and the whole offline story do not depend on a
backend. Everything that does — signing in, trips, membership, documents, picks
— goes through this one interface, so replacing the backend is one new file
plus one `<script>` tag, with no changes to the UI.

## The adapter interface

An adapter registers itself as `window.TripBackends.<id>` and implements:

| method | returns / promise of |
| --- | --- |
| `id`, `label` | strings (`'pocketbase'`, `'PocketBase'`) |
| `isConfigured()` | `boolean` — true only when its config is filled in |
| `init()` | `Promise<status>` — restore a session and probe the auth methods; resolves even on failure |
| `status()` | `{configured, ready, error, user, backendBase?, oauth?}`; `user` is `{id,email,name,avatar}` or `null`, `oauth` is `{checked, ready, offline, message}` (is a sign-in method available, and why not) |
| `onChange(fn)` | call `fn(status)` whenever the signed-in user changes |
| `refresh()` | `Promise<status>` — re-ask the backend whether sign-in is available yet |
| `signIn()` / `signOut()` | `Promise` |
| `listTrips()` | `Promise<[{id,slug,name,currency,travellers,owner_id}]>` — **only trips this user may see** |
| `openTrip(key)` | `Promise<{trip, docs, members, role, canEdit}>`; `key` is a trip id or a share link / `#trip=…`; `docs` is `{trip,itinerary,accommodation,expenses,packing,recommendations,decisions}` of parsed JSON; reject with `code === 'not_found'` when the trip does not exist **or is not shared with this user** |
| `pendingInvites()` | `Promise<[{id,trip,trip_title,role,invited_email}]>` — invitations addressed to *my* email, not yet accepted |
| `acceptInvite(invite)` | `Promise` — the invitee joining (creates their own membership row) |
| `invite(tripId, email)` | `Promise` — owner only; role is not a parameter (see below) |
| `removeMember(entry)` | `Promise` — a member entry or an invitation entry: the owner removes/revokes, or a member removes themselves (leave) |
| `saveDocs(tripId, docs)` | `Promise<number>` — write the sections present in `docs`; the trip's own fields are written too when the caller is the owner |
| `loadPicks(tripId)` | `Promise<{decisionId: {option_id, picked_by, at}}>` |
| `savePick(tripId, decisionId, optionId, seed)` | `Promise` — `seed` is the app's own decisions document, used only when the trip has no decisions row yet |
| `clearPicks(tripId)` | `Promise` |
| `shareLink(slug)` | `string` — a readable, copyable link |

Errors are rejected as `Error` with a human-readable `message` (it is shown in
the UI) and an optional `code` from `not_configured`, `not_found`,
`bad_request`, `no_session`, `auth`, `db`.

Authorisation is **the server's job**. The app treats `openTrip` answering
`not_found` for a user as "not shared with this address" and says so; it never
assumes the client can be trusted to enforce membership.

## What is specific to PocketBase

* **No anon key.** The only credential the client names is the OAuth2 provider
  (`google`). The client secret lives in the backend's admin console.
* **The share key is the record id** (`gyhin4g0a03b1gq`). PocketBase's `trips`
  collection has no slug column, so `trip.slug === trip.id` and a share link is
  `…#trip=<id>`. `openTrip` also accepts a whole pasted link.
* **One row per `(trip, section)`.** `trip_docs.data` holds the whole section
  document, byte-identical to the app's `data/*.json`, so a write is a
  full-document `PATCH` (or a `POST` for the first write).
* **Membership is the access gate, and it means read *and* write.** There is no
  viewer/editor tier, so the invite UI asks for an email only.
* **Invitations are separate rows** (`trip_invites`) and the invitee joins by
  creating their own `trip_members` row — the server rule allows that only for
  a role of `member` and only when an invitation for their email exists.
  Accepting does not delete the invitation (delete is owner-only), so the
  adapter hides an invitation whose trip the user has already joined, and
  removing a member also revokes any invitation left on file for their address
  (otherwise they could accept their way back in).
* **Picks are not a collection.** A decision pick is written into the
  `decisions` document as `picked_option_id` / `picked_by` / `picked_at` on the
  decision it belongs to; those writes are serialised per trip, because a
  read-modify-write of a whole document races with itself.
* **`created` / `updated` are populated and sortable.** Fixed 2026-10-07 by the
  `dba` profile — see the migration `1791318003_add_autodate_fields.js` in the
  backend's `pb_migrations` (host: `/home/k/docker/data/pocketbase/pb_migrations`).
  The four collections built by `1791315118_init_trip_schema.js` had been created
  without any autodate fields (PocketBase only injects `created`/`updated`
  automatically for *auth* collections), so records carried neither and any
  `?sort=-created` answered `HTTP 400`. Sorting by an autodate field works
  again, and `listTrips` asks for `?sort=-created` (newest first) — the same
  list order DESIGN.md 6.2 documents. **Rows written before the
  fix carry the time the migration ran, not the time they were really created**
  — nothing had ever recorded that — so on an old row `created` means "at least
  this old". Everything written from 2026-10-07 04:25 (+08) onward is stamped by
  PocketBase itself, and `updated` moves on every write.
* The PocketBase JS SDK is **vendored** at `backends/vendor/pocketbase.umd.js`
  (version + sha256 in `backends/vendor/README.md`), pinned so the app does not
  depend on a CDN. `pocketbase-config.js` has a `libUrl` override, and an
  already-present `window.PocketBase` is used as-is.

## Swapping the backend

1. Add `backends/<name>-adapter.js` implementing the table above and
   `window.TripBackends.<name> = {...}`.
2. Load it in `index.html` before `auth.js` (after its own config file, if it
   has one).
3. Keep that adapter's own config file at the site root with **empty**
   placeholders. Only public values belong in the client.
4. Nothing else changes: `auth.js` picks the first registered adapter whose
   `isConfigured()` is true, and app.js keeps rendering.

If several adapters are registered, the first configured one in
`window.TripBackends` insertion order wins.

## What was verified, and what was not

Verified against the **live backend** in a real browser (Chromium over CDP),
with a throwaway trip and a throwaway user, both deleted afterwards — the real
trip's five documents were confirmed byte-identical before and after, by
canonical sha256:

* local mode (`backendBase: ''`): all seven tabs render from `data/*.json`, no
  SDK and no request to any backend;
* offline path (a base URL that cannot resolve): every tab still renders, the
  UI says which address is unreachable, the SDK is not loaded, nothing hangs;
* Google sign-in not configured: `auth-methods` is probed on load and the UI
  says what the owner must do next, with the exact redirect URI; `signIn()`
  rejects in ~15 ms with that message instead of hanging;
* session restore from a stored auth token, `listTrips`, `openTrip` (the tabs
  rendered the trip's *backend* documents — a known difference in the seeded
  accommodation was visible, i.e. the data really came from the server), member
  list, the invite/accept flow end to end (the invitee is told they were
  invited, joins, and the trip opens for them), pick → decisions document →
  reload → the pick comes back → reset clears it on the backend, import of all
  sections plus the trip's own fields as the owner, invite + duplicate
  handling + revoke, and removing a member (who then gets `404` and has their
  invitation revoked too).

**Not exercised:** a real Google sign-in. The Google client is not configured
on the backend yet, so the OAuth2 popup → consent → `auth-with-oauth2` leg has
only been read, not run. Session restore, every API call and the
popup-blocked message were driven through an impersonated session instead
(`POST /api/collections/users/impersonate/<id>`), which exercises the same
client code paths — but not Google's consent screen. Once the owner pastes the
client id/secret into the admin console, the first real sign-in is the thing to
try; if the popup is blocked, the UI names that as the reason.

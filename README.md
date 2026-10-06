# Vietnam trip — static trip app

A single-page static site that shows one trip in tabs: **Itinerary · Stay · Expenses ·
Packing · Ideas · Decisions · Share**.

- No build step, no framework, no bundler, no dependencies.
- No analytics, no third-party calls, no secrets. The only external links are
  "Listing / Source / Map" links you click yourself (Map uses OpenStreetMap).
- Everything you type stays on the device (browser `localStorage`) **until you sign in
  to a configured backend** — then the trip you opened and the picks you make are saved
  to that backend so the people on the trip can see them. Nothing is ever uploaded
  silently: with no backend configured, no signing in and no request at all.
- Works served over http(s) — including GitHub Pages — and from a local web server.
  Opened straight off disk (`file://`) most browsers refuse to let a page read
  neighbouring files, so the app shows a "choose the data folder" panel once and then
  remembers the files in that browser.

## Files

```
index.html        markup skeleton (header, tab bar, 7 empty sections)
app.js            all logic: load → normalise → render, local state, import/export
styles.css        mobile-first styling, light + dark
auth.js           backend facade — the only thing app.js talks to
pocketbase-config.js  the deployed adapter's config — the ONLY place the backend address lives
backends/         swappable server adapters (+ their contract, the vendored SDK)
data/*.json       the trip content (see schemas below)
README.md         this file
```

## Run it locally

```sh
cd vietnam-trip
python3 -m http.server 8000
# open http://localhost:8000/
```

Opening `index.html` directly (`file://`) also works, but see the note above about
picking the data files by hand.

## Data files

Every file is optional. A missing or empty file renders a clear empty state for that tab
("no accommodation added yet") — the app never invents content. A file that is present but
malformed (bad comma, unclosed quote) shows a visible error on **that tab only**; the other
tabs keep working.

Arrays may also be given as a bare top-level array instead of the wrapper object shown
below. Extra fields you add are ignored, not rejected.

### `data/trip.json` — drives the header

```json
{
  "title": "Vietnam, November 2026",
  "start": "2026-11-05",
  "end": "2026-11-28",
  "budget": 3000,
  "currency": "USD",
  "bases": ["Hanoi", "Hoi An", "Ho Chi Minh City"]
}
```

All keys are optional: without `trip.json` the header falls back to the dates and bases it
can infer from `itinerary.json`, and shows the budget line only once there are expenses.

### `data/itinerary.json` — one object per day

```json
{
  "days": [
    {
      "day": 1,
      "date": "2026-11-05",
      "base": "Hanoi",
      "title": "Arrival",
      "transit": "Flight SIN-HAN 09:15",
      "lodging": "Old Quarter guesthouse",
      "day_cost": 120,
      "items": [
        { "time": "14:00", "what": "Land at Noi Bai", "notes": "transfer booked", "cost": 18 },
        { "time": "19:30", "what": "Bun cha dinner", "cost": 6 }
      ]
    }
  ]
}
```

`day_cost` is optional — if it is missing the day total is the sum of the item costs.
Costs may be numbers (`18`) or short strings (`"USD 18"`); strings that are not clean
numbers are shown as written and left out of the totals.

### `data/accommodation.json`

```json
[
  {
    "name": "Old Quarter guesthouse",
    "area": "Hanoi",
    "nights": 3,
    "price_per_night": 2860000,
    "currency": "VND",
    "status": "wishlist",
    "checkin": "2026-11-05",
    "checkout": "2026-11-08",
    "link": "https://…",
    "source_url": "https://…",
    "notes": "free cancellation until 1 Nov"
  }
]
```

Field names are read loosely: `checkin`/`check_out`, `link`/`source_url`, `name`/`title`
all work. `status` is free text — `booked` and `wishlist` get their own badge colours. The
tab shows a total for all stays and a subtotal for the ones marked booked. A stay only
counts towards the total when both `nights` and `price_per_night` are numbers. `currency`
is read per stay; if stays use different currencies the totals are listed per currency
rather than added together.

### `data/expenses.json`

```json
{
  "currency": "USD",
  "planned": [
    { "category": "Flights", "item": "SIN-HAN", "amount": 180, "notes": "one way" }
  ],
  "actuals": []
}
```

`planned` is the budget from the plan. `actuals` is what was really spent — you normally
leave it out and log spend in the app instead, then **Export JSON** writes the whole file
back out (planned rows verbatim + every logged entry) so it can be committed to the repo.
Importing accepts a whole `expenses.json`, `{"actuals": [...]}`, or a bare array; a bad
entry is reported by position ("entry 2 has no numeric \"amount\"") and nothing is imported
unless every entry is usable.

### `data/packing.json`

```json
{
  "categories": [
    {
      "name": "Documents",
      "items": [
        { "item": "Passport", "notes": "valid 6 months" },
        "Travel insurance",
        { "item": "Travel adapter", "buy": true, "notes": "order before departure" }
      ]
    }
  ]
}
```

Items can be plain strings or objects. `"buy": true` (also `to_buy`, `needs_buy`,
`pre_departure`, `to_arrange`) marks an item as something to buy or arrange before
departure; those are listed in their own block at the top and stay flagged until ticked.
Ticks live in `localStorage`; **Reset** clears them.

### `data/recommendations.json`

```json
[
  {
    "title": "Banh mi stand",
    "area": "Hoi An",
    "category": "food",
    "why": "best banh mi in town, 5 min from the hotel",
    "cost_estimate": "VND 40k",
    "source_url": "https://…",
    "added_by": "mugger",
    "added_at": "2026-10-07",
    "status": "shortlisted"
  }
]
```

`name`/`title`, `cost`/`cost_estimate` and `source`/`source_url` are interchangeable, so
entries written either way render. `status` is `idea` → `shortlisted` → `planned`; the badge
cycles when you tap "Mark …". `added_by` / `added_at` are shown as provenance under each
card. The Ideas tab filters by area, category and status. `id` is not used by the app —
keep it if you like, it survives export untouched.

## Adding a recommendation without touching code

Open **Ideas → + Add recommendation**:

1. Paste an object (or an array of objects) using the fields above, or fill the small form.
2. Hit **Validate & preview** — the app names the exact problem if the JSON does not
   parse or a required field is missing/wrongly typed.
3. **Copy JSON** the result, then paste it into the array in
   `data/recommendations.json` (or hand it to whoever owns the repo). The generated entry
   is written with the same field names the repo already uses (`title`, `cost_estimate`,
   `source_url`, `added_by`), so it drops straight in.
   **Keep on this page** keeps it in this browser only, marked `local only`, if you just
   want to see it now.

## `data/decisions.json` — the Decisions tab

One entry per open question, with a **primary option** (the recommendation) and its
alternatives:

```json
[
  {
    "id": "dec-nye",
    "title": "New Year's Eve: Hanoi or Tam Coc",
    "question": "Where do you spend 31 Dec?",
    "primary_option_id": "opt-hanoi-nye",
    "status": "open",
    "decided_by": "nomad",
    "options": [
      {
        "id": "opt-hanoi-nye",
        "label": "Hanoi — fireworks over Hoan Kiem",
        "summary": "one line on what this option is",
        "changes": ["Day 8 (31 Dec) loses its Hanoi night and everything after it"],
        "cost_delta_sgd": 0,
        "booking_impact": "acc-009 must be booked by ~4 Nov 2026",
        "tradeoffs": "the scarcest, most expensive night of the window",
        "sources": ["https://…"]
      }
    ]
  }
]
```

What the tab does:

- One card per decision. The **primary option is the current choice** and carries a
  *<decided_by> recommends* badge and the alternatives underneath with their
  `cost_delta_sgd` (always relative to the primary, which is 0) and their `tradeoffs`.
- **Switch to this** makes that option current in place — the card then shows it as
  *Current* with *Your pick*, moves the recommendation down into the alternatives, and
  shows the running delta. **Back to … 's pick** undoes it in one tap. **Reset all
  picks** clears every choice (two taps, deliberately).
- `status` reads `open` until a choice is made; a card you have picked shows `decided`,
  and when a shared trip is open it records *who* picked (`Chosen by …`).
- A **trip-level delta** appears with the other summary numbers: the header line reads
  *"Decisions: 3 of 11 picked · +S$124/person vs Nomad's plan (+S$248 for 2 travellers)"*,
  and the Expenses tab repeats it against the plan total
  (*"SGD 978/person → SGD 1,102/person"*).
- `changes` are the itinerary consequences. Where one names a day (*"Day 8 (31 Dec) …"*)
  or an ISO date, the entry gets a **Day 8 →** button that jumps to that day on the
  Itinerary tab and outlines it. Days that are not in the itinerary get no button.
- Keys are read exactly as written above (`primary_option_id`, `cost_delta_sgd`,
  `booking_impact`, `tradeoffs`, `changes`, `sources`) — do not rename them, the
  researched file depends on them. Missing/absent files render an honest empty state.

## Sharing

The app runs **local-only until a backend is configured**, and that is still how it is
used day to day for anyone who has not signed in: `pocketbase-config.js` names the
public URL of the self-hosted PocketBase on alienlab (published through a Tailscale
Funnel), which is what makes the Share tab live. Empty that one value and the app is
back to the purely local, offline site it started as. The address lives in that one file
and nowhere else.

- With no backend configured: no third-party script is loaded, no request is made, the
  footer keeps its "nothing leaves this device" promise, and the Share tab explains what
  sharing will need.
- With one configured but Google sign-in not switched on at the backend: the app probes
  the auth methods on load and says exactly that, naming the redirect URI to register —
  it does not offer a button that cannot work.
- The interface an adapter must implement, the swap procedure and what is PocketBase-
  specific are documented in `backends/README.md`.
- No service-role key, secret or admin credential belongs in this repo or in the client.
  The only thing the client names is the OAuth2 provider; the client secret lives in the
  backend's admin console.
- The PocketBase JS SDK is vendored in `backends/vendor/` (version + sha256 recorded),
  so the app never depends on a CDN.

## Local state (this browser only)

| localStorage key    | what it holds                                    |
|---------------------|--------------------------------------------------|
| `vt.actuals.v1`     | spend you logged on the Expenses tab             |
| `vt.packing.v1`     | ticked packing items                             |
| `vt.recs.v1`        | recommendations kept "on this page" only         |
| `vt.recstatus.v1`   | status changes you made to recommendations       |
| `vt.decisions.v1`   | the option you picked on each decision card      |
| `vt.trip.v1`        | id of the shared trip last opened (backend mode)  |
| `vt.tab`            | last tab you had open                            |
| `vt.cache.v1`       | last copy of the data files (used offline / on `file://`) |

**Clear local entries** on the Expenses tab wipes only `vt.actuals.v1`; **Reset all
picks** on the Decisions tab clears `vt.decisions.v1`.

## What has actually been run

Verified in a real browser (Chromium over CDP) against the real `data/*.json` and the
live backend:

- All seven tabs render; the Decisions tab shows 11 cards, 23 day-jump buttons and the
  real header delta.
- Switching an option replaces the primary in place, updates the header and summary
  figures (`-SGD 31/person`, `+SGD 326/person`, `+SGD 124/person` cross-checked by hand
  against the file), records the pick, survives a reload, and the Expenses note
  recomputes (SGD 978 → SGD 1,102/person). "Back to Nomad's pick" and "Reset all picks"
  both restore the plan.
- A day jump switches to the Itinerary tab, scrolls to that day and outlines it.
- With no backend configured there are **zero** non-local network requests, no
  third-party script tag, and no JavaScript errors.
- With the backend configured but unreachable, every tab still renders, the UI names the
  address that is not answering, and nothing hangs.
- Against the **live PocketBase backend**, with a throwaway trip and throwaway user
  (both deleted afterwards; the real trip's five documents were confirmed byte-identical
  before and after by canonical sha256): session restore, the trip list, opening a
  shared trip (the tabs rendered the *backend's* documents, including a content
  difference that only exists server-side), the member list, the invite → accept flow
  end to end, a decision pick written into the trip's `decisions` document and read back
  after a reload, reset clearing it server-side, importing all sections plus the trip's
  own fields as the owner, and removing a member (who then gets `404` and whose
  invitation is revoked with them).

**Not verified / not done:** a real Google sign-in — no Google client is configured at
the backend yet, so the OAuth2 popup → consent leg has only been read, not run (the same
client code paths were driven through an impersonated session instead); no `git`
operation of any kind (deployment is someone else's job).

## Deployment

Static files, so anything that serves a directory works. It is meant to be published with
**GitHub Pages** from the repo root (`https://github.com/Eclypheon/nomad`); repository
ownership, commits and Pages settings are handled outside this app. Use relative paths
only — the app references `styles.css`, `app.js`, `auth.js`, `backends/`, the config file
and `data/*.json` and nothing else, so it works unchanged from a subpath like
`https://user.github.io/nomad/`. The backend files are inert while no adapter is
configured, so they do not change what is deployed.

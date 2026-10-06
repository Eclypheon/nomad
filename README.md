# Vietnam trip — static trip app

A single-page static site that shows one trip in tabs: **Itinerary · Stay · Expenses ·
Packing · Ideas**.

- No build step, no framework, no bundler, no dependencies.
- No analytics, no third-party calls, no secrets. The only external links are
  "Listing / Source / Map" links you click yourself (Map uses OpenStreetMap).
- Everything you type stays on the device (browser `localStorage`). Nothing is uploaded.
- Works served over http(s) — including GitHub Pages — and from a local web server.
  Opened straight off disk (`file://`) most browsers refuse to let a page read
  neighbouring files, so the app shows a "choose the data folder" panel once and then
  remembers the files in that browser.

## Files

```
index.html        markup skeleton (header, tab bar, 5 empty sections)
app.js            all logic: load → normalise → render, local state, import/export
styles.css        mobile-first styling, light + dark
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

## Local state (this browser only)

| localStorage key    | what it holds                                    |
|---------------------|--------------------------------------------------|
| `vt.actuals.v1`     | spend you logged on the Expenses tab             |
| `vt.packing.v1`     | ticked packing items                             |
| `vt.recs.v1`        | recommendations kept "on this page" only         |
| `vt.recstatus.v1`   | status changes you made to recommendations       |
| `vt.tab`            | last tab you had open                            |
| `vt.cache.v1`       | last copy of the data files (used offline / on `file://`) |

**Clear local entries** on the Expenses tab wipes only `vt.actuals.v1`.

## Deployment

Static files, so anything that serves a directory works. It is meant to be published with
**GitHub Pages** from the repo root (`https://github.com/Eclypheon/nomad`); repository
ownership, commits and Pages settings are handled outside this app. Use relative paths
only — the app references `styles.css`, `app.js` and `data/*.json` and nothing else, so it
works unchanged from a subpath like `https://user.github.io/nomad/`.

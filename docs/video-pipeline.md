# Trip video pipeline

Every trip video is rendered from one JSON file. Nothing about a trip lives in code.

```sh
python3 tools/trip_video.py check   --trip data/trips/<slug>.video.json   # offline: is this script renderable?
python3 tools/trip_video.py prepare --trip data/trips/<slug>.video.json   # geocodes, OSRM roads, Wikipedia photos
python3 tools/trip_video.py render  --trip data/trips/<slug>.video.json   # day parts, parallel across processes
python3 tools/trip_video.py concat  --trip data/trips/<slug>.video.json   # ffmpeg stream copy + one music pass
python3 tools/trip_video.py all     --trip data/trips/<slug>.video.json --workers 6
```

Output: `data/exports/<slug>/<slug>.mp4`, parts in `data/exports/<slug>/parts/` (delete one to
re-render only that day), TTS in `.../tts/` (cached, validated, retried).

## Where content comes from

| Thing | Source | Cache |
| --- | --- | --- |
| Trip, days, items, costs | PocketBase `trips` + `trip_docs` (pulled into `data/trips/<slug>.bundle.json`) | the bundle file |
| Coordinates | Nominatim, Photon fallback | `data/geocodes.json` |
| Road geometry | OSRM `/route/v1/driving` | `data/routes.json` |
| Photos + credits | Wikipedia `pageimages` + Commons `extmetadata` | `data/exports/assets/images/` |
| Music bed | CC0 track via Openverse | `data/exports/assets/music.mp3` |

Caches are global and keyed by place name / article title, so a second trip that visits Hanoi
reuses the first trip's photos and coordinates for free.

## Pulling a trip from PocketBase

The backend is members-only: anonymous reads return `[]`. Over SSH on the homelab box:

```bash
ssh k@192.168.1.119 "sqlite3 -json /home/k/docker/data/pocketbase/pb_data/data.db \
  \"select * from trips where title like '%Sapa%';\""
ssh k@192.168.1.119 "sqlite3 -json /home/k/docker/data/pocketbase/pb_data/data.db \
  \"select section, data from trip_docs where trip='<record id>';\"" > docs.json
```

Wrap both in `{"schema": "nomad.trip.bundle.v1", "trip": …, "docs": {section: …}}` and save as
`data/trips/<slug>.bundle.json` — that is the provenance record for the video script.

## `*.video.json` schema

```jsonc
{
  "slug": "hanoi-sapa-2026",
  "country": "Vietnam",          // optional: geocoding hint, no country is baked into the code
  "title": "Hanoi + Sapa",
  "subtitle": "24–29 Dec 2026 · 6 days · 5 nights · 2 travellers",
  "currency": "S$",
  "flights": { "status", "from_name", "to_name", "duration", "carriers", "fare", "dates_label" },
  "expenses": "Planned S$2,285 for two, cap S$2,500 — flights included",
  "highlights": ["…", "…", "…"],
  "intro_beats": [ { "text": "…", "focus": "title|flights|cost|highlight0|highlight1|highlight2" } ],
  "outro": { "heading": "The budget", "text": "…" },
  "days": [ {
    "n": 1, "date_label": "24 Dec", "base": "Hanoi", "title": "…", "cost": 390,
    "caveat": "optional amber line", "transit_note": "optional grey line",
    "bullets": ["…", "…", "…"],
    "beats": [
      { "kind": "place", "at": "Hanoi", "bullet": 0, "text": "narration",
        "image": "Hoàn Kiếm Lake", "caption": "Hoàn Kiếm" },
      { "kind": "transit", "leg": ["Hanoi", "Sa Pa"], "bullet": 1, "text": "narration" }
    ]
  } ]
}
```

Rules learned the hard way:

- **One beat = one narrated moment = one TTS clip.** Bullet `i` lights up when beat `i` starts,
  which is what makes the copy look narrated rather than printed.
- **`image` + `caption` must describe the same thing.** If Wikipedia's lead photo for an article
  is something else (Lào Cai Province's is a cable car), either caption it as what it shows or
  drop the image — a wrong picture is worse than no picture.
- **Narration budget:** gTTS at 1.3x runs ~3.05 words/s, so 2 minutes ≈ 370 words including the
  intro. Write to the number; don't write long and hope. Put `"target_seconds": 120` in the file and
  `check` will tell you how many words to cut or add.
- Photo-less beats still animate (pulse + panel reveal); they are not padding to be deleted.

## One pass, not five

`check` is the cheap loop. It reads only the caches, prints the word count and runtime, and names the
specific day, beat or place that would fail — a missing geocode or road route, an empty narration, a
bullet that never lights up, an image with no cached photo, a runtime far off `target_seconds`. It runs
automatically before `render` and refuses to start on hard errors, so a broken script costs seconds
instead of a half-finished render.

Two more things that used to cause a regenerate:

- The side panel auto-fits: long bullets shrink the type until everything clears the cost line instead
  of spilling over it. Over-long copy becomes small, never broken.
- Cached photos are checked against the beats: `check` warns when a beat's `image` has no file, which is
  the "wrong or missing picture" case in the rules above.

Speed: the intro/outro backdrop (the dimmed map) is built once per trip instead of once per frame — it
was 54 map rebuilds and tile downloads for a 6-beat intro. Narration for every beat is synthesised up
front across threads instead of serially inside the day workers, and it is cached, so a re-render only
re-encodes the parts whose files are missing.

## Rendering

`render` fans days across `ProcessPoolExecutor` workers (each writes `parts/dayN.mp4`), then
`concat` joins them with `ffmpeg -f concat -c copy` and mixes music in a single audio-only pass
(`-c:v copy`), so the video is encoded exactly once per part. Memory stays bounded per day;
frames are never accumulated across the whole film.

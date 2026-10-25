#!/usr/bin/env python3
"""Render a trip's itinerary guide video from one per-trip JSON file.

A trip is data, not code: `data/trips/<slug>.video.json` holds the days, beats,
narration, photos and the intro card. Everything shared (coordinates, road routes,
photos+credits, music) is cached once and reused across trips.

  python3 tools/trip_video.py prepare --trip data/trips/hanoi-sapa.video.json
  python3 tools/trip_video.py render  --trip ... [--workers 6]
  python3 tools/trip_video.py concat  --trip ...
  python3 tools/trip_video.py all     --trip ... [--workers 6]

Rendering is per part (intro, one per day, outro); `render` fans the days across
processes and `concat` joins the encoded parts with ffmpeg stream copy, then mixes
the music in a single audio-only pass, so nothing is re-encoded twice.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import staticmap
from PIL import Image, ImageDraw, ImageFont
from staticmap.staticmap import _lat_to_y, _lon_to_x

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SHARED = DATA / "exports" / "assets"
IMAGES = SHARED / "images"
MUSIC = SHARED / "music.mp3"
GEOCODES = DATA / "geocodes.json"
ROUTES = DATA / "routes.json"

W, H = 1920, 1080
MAP_W = 1184
PANEL_X = MAP_W

INK = (12, 18, 32)
PANEL = (15, 23, 42)
WHITE = (248, 250, 252)
MUTED = (148, 163, 184)
ACCENT = (239, 68, 68)
GOLD = (250, 204, 21)
DIM = (100, 116, 139)
FADED = (71, 85, 105)
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
UA = {"User-Agent": "nomadproj-trip-video/1.0 (https://github.com/eclypheon/nomad; personal trip guide)"}

CARD_W, CARD_H, CARD_CAP = 372, 212, 58
SLOTS = [(MAP_W - CARD_W - 26, H - CARD_H - CARD_CAP - 58),
         (MAP_W - CARD_W - 26, 96),
         (26, H - CARD_H - CARD_CAP - 58)]

PULSE_N, PULSE_FPS = 9, 15
SWEEP_N, SWEEP_FPS = 8, 15
ROUTE_N, ROUTE_FPS = 16, 15
INTRO_N, INTRO_FPS = 8, 15


# ---------- shared helpers ----------
def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise SystemExit(f"cannot read {path}: {exc}") from exc


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=1, ensure_ascii=False))


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    try:
        f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
        if bold:
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                pass
        return f
    except Exception:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size, index=1 if bold else 0)


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=f) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# ---------- trip model ----------
class Trip:
    def __init__(self, path: Path):
        self.path = path
        self.data = load_json(path)
        d = self.data
        self.slug = d["slug"]
        self.country = d.get("country", "")
        self.title = d.get("title", "Trip")
        self.subtitle = d.get("subtitle", "")
        self.dates = d.get("dates", {})
        self.flights = d.get("flights", {})
        self.expenses = d.get("expenses", "")
        self.highlights = d.get("highlights", [])
        self.intro_beats = d.get("intro_beats", [])
        self.outro = d.get("outro", {})
        self.days = d["days"]
        self.out = DATA / "exports" / self.slug
        self.parts = self.out / "parts"
        self.tts = self.out / "tts"
        self.final = self.out / f"{self.slug}.mp4"

    @property
    def geocodes(self) -> dict:
        return load_json(GEOCODES) if GEOCODES.exists() else {}

    @property
    def routes(self) -> dict:
        return load_json(ROUTES) if ROUTES.exists() else {}

    def places(self) -> list[str]:
        seen: list[str] = []
        for day in self.days:
            for beat in day["beats"]:
                for key in ([beat["at"]] if beat.get("at") else []) + list(beat.get("leg", [])):
                    if key and key not in seen:
                        seen.append(key)
        return seen

    def legs(self) -> list[tuple[str, str]]:
        return [tuple(b["leg"]) for day in self.days for b in day["beats"] if b.get("leg")]

    def image_titles(self) -> list[str]:
        out: list[str] = []
        for day in self.days:
            for beat in day["beats"]:
                if beat.get("image") and beat["image"] not in out:
                    out.append(beat["image"])
        return out


# ---------- prepare: coordinates, roads, photos ----------
def _api(host: str, tries: int = 4, **params) -> dict:
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise
    return {}


def geocode(name: str, query: str | None = None) -> dict | None:
    """Nominatim first, Photon second. Both are key-free; geopy's stubs are loose here."""
    from geopy.geocoders import Nominatim, Photon

    q = query or name
    attempts: list[tuple[str, Any]] = [
        ("nominatim", Nominatim(user_agent="nomadproj-trip-video/1.0")),
        ("photon", Photon(user_agent="nomadproj-trip-video/1.0")),
    ]
    for kind, geocoder in attempts:
        geo: Any = geocoder
        try:
            loc = geo.geocode(q, timeout=20) if kind == "nominatim" else geo.geocode(q, timeout=20, limit=1)
        except Exception:
            loc = None
        if loc is not None:
            lat, lon = getattr(loc, "latitude", None), getattr(loc, "longitude", None)
            if isinstance(lat, float) and isinstance(lon, float):
                return {"lat": round(lat, 5), "lon": round(lon, 5),
                        "address": str(getattr(loc, "address", ""))[:120]}
        time.sleep(1.1)
    return None


def osrm_leg(a: dict, b: dict) -> dict | None:
    url = (f"https://router.project-osrm.org/route/v1/driving/"
           f"{a['lon']},{a['lat']};{b['lon']},{b['lat']}?overview=full&geometries=geojson")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
            d = json.load(r)
    except (urllib.error.URLError, ValueError) as exc:
        print(f"  OSRM failed for {a} → {b}: {exc}", flush=True)
        return None
    if d.get("code") != "Ok" or not d.get("routes"):
        return None
    route = d["routes"][0]
    return {"coords": [[round(lat, 5), round(lon, 5)] for lon, lat in route["geometry"]["coordinates"]],
            "km": round(route["distance"] / 1000, 1), "minutes": round(route["duration"] / 60)}


def _crop_to(img: Image.Image, w: int, h: int) -> Image.Image:
    scale = max(w / img.width, h / img.height)
    resized = img.resize((max(w, round(img.width * scale)), max(h, round(img.height * scale))),
                         Image.Resampling.LANCZOS)
    left = (resized.width - w) // 2
    top = max(0, int((resized.height - h) * 0.35))
    return resized.crop((left, top, left + w, top + h))


def fetch_image(title: str, credits: dict) -> None:
    key = slug(title)
    out = IMAGES / f"{key}.jpg"
    if out.exists() and key in credits:
        return
    d = _api("en.wikipedia.org", action="query", prop="pageimages", titles=title,
             pithumbsize=1400, pilicense="any", redirects=1)
    page = next(iter(d.get("query", {}).get("pages", {}).values()), {})
    thumb = (page.get("thumbnail") or {}).get("source")
    if "missing" in page or not thumb:
        print(f"  no photo for {title!r}", flush=True)
        return
    data = urllib.request.urlopen(urllib.request.Request(thumb, headers=UA), timeout=40).read()
    tmp = IMAGES / f".{key}.src"
    tmp.write_bytes(data)
    IMAGES.mkdir(parents=True, exist_ok=True)
    _crop_to(Image.open(tmp).convert("RGB"), CARD_W - 12, CARD_H - 12).save(out, quality=88)
    tmp.unlink()
    info = _api("commons.wikimedia.org", action="query", prop="imageinfo", iiprop="extmetadata",
                titles="File:" + (page.get("pageimage") or ""))
    p2 = next(iter(info.get("query", {}).get("pages", {}).values()), {})
    meta = (p2.get("imageinfo") or [{}])[0].get("extmetadata", {}) if "missing" not in p2 else {}
    artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value") or "").strip()
    credits[key] = {"article": title, "artist": artist[:70],
                    "license": meta.get("LicenseShortName", {}).get("value") or "Wikimedia Commons"}
    print(f"  {title} — {credits[key]['license']}", flush=True)


def prepare(trip: Trip) -> None:
    geo = trip.geocodes
    for name in trip.places():
        if name in geo:
            continue
        found = geocode(name, f"{name}, {trip.country}" if trip.country else name)
        if found:
            geo[name] = found
            save_json(GEOCODES, geo)
            print(f"  geocode {name}: {found['lat']},{found['lon']}", flush=True)
        else:
            raise SystemExit(f"could not geocode {name!r} — add it to {GEOCODES} manually")
        time.sleep(1.1)

    routes = trip.routes
    for a, b in trip.legs():
        key = f"{a}>{b}"
        if key in routes:
            continue
        leg = osrm_leg(geo[a], geo[b])
        if not leg:
            raise SystemExit(f"OSRM could not route {key}")
        routes[key] = leg
        save_json(ROUTES, routes)
        print(f"  route {key}: {leg['km']} km, {leg['minutes']} min", flush=True)
        time.sleep(1.0)

    credits_path = IMAGES / "credits.json"
    credits = load_json(credits_path) if credits_path.exists() else {}
    IMAGES.mkdir(parents=True, exist_ok=True)
    for title in trip.image_titles():
        fetch_image(title, credits)
        save_json(credits_path, credits)
        time.sleep(1.3)
    if not MUSIC.exists():
        raise SystemExit(f"missing shared music bed: {MUSIC}")


# ---------- map rig ----------
class Rig:
    def __init__(self, trip: Trip, day_index: int):
        self.trip = trip
        self.day_index = day_index
        day = trip.days[day_index]
        geo, routes = trip.geocodes, trip.routes
        legs = [tuple(b["leg"]) for b in day["beats"] if b.get("leg")]
        places = [b["at"] for b in day["beats"] if b.get("at")]
        self.done_legs = [tuple(b["leg"]) for d in trip.days[:day_index] for b in d["beats"] if b.get("leg")]

        pts: list[tuple[float, float]] = []
        for leg in legs:
            pts += [(p[1], p[0]) for p in routes[f"{leg[0]}>{leg[1]}"]["coords"]]
        pts += [(geo[p]["lon"], geo[p]["lat"]) for p in set(places)]
        if not pts:
            pts = [(g["lon"], g["lat"]) for g in geo.values()]

        pad = 64 if legs else 260          # a city day with no leg needs a wider frame
        m = staticmap.StaticMap(MAP_W, H, padding_x=pad, padding_y=pad, url_template=TILE_URL,
                                headers=UA, tile_request_timeout=20)
        for lon, lat in pts[::max(1, len(pts) // 60)]:
            m.add_marker(staticmap.CircleMarker((lon, lat), "#ffffff", 1))
        m._draw_features = lambda image: None
        self.map = Image.blend(m.render().convert("RGB"),
                               Image.new("RGB", (MAP_W, H), (255, 255, 255)), 0.30)
        self._m, self.zoom = m, m.zoom

        d = ImageDraw.Draw(self.map)
        label = "© OpenStreetMap contributors · OSRM"
        f = font(18)
        d.rectangle([12, H - 40, 24 + d.textlength(label, font=f), H - 10], fill=(12, 18, 32))
        d.text((18, H - 36), label, font=f, fill=(226, 232, 240))
        self.panel_cache: dict[int, Image.Image] = {}
        self.cards: list[tuple[Image.Image, tuple[int, int]]] = []

    def px(self, place: str) -> tuple[float, float]:
        g = self.trip.geocodes[place]
        return (self._m._x_to_px(_lon_to_x(g["lon"], self.zoom)),
                self._m._y_to_px(_lat_to_y(g["lat"], self.zoom)))

    def leg_points(self, leg: tuple[str, str]) -> list[tuple[float, float]]:
        coords = self.trip.routes[f"{leg[0]}>{leg[1]}"]["coords"]
        step = max(1, len(coords) // 420)
        return [(self._m._x_to_px(_lon_to_x(lon, self.zoom)),
                 self._m._y_to_px(_lat_to_y(lat, self.zoom))) for lat, lon in coords[::step]]

    def leg_end(self, leg: tuple[str, str]) -> tuple[float, float]:
        return self.leg_points(leg)[-1]

    def draw_route(self, canvas: Image.Image, leg: tuple[str, str], progress: float) -> None:
        pts = self.leg_points(leg)
        n = max(2, int(len(pts) * min(1.0, progress)))
        if n < 2:
            return
        d = ImageDraw.Draw(canvas)
        d.line(pts[:n], fill=(185, 28, 28), width=6, joint="curve")
        head = pts[n - 1]
        d.ellipse([head[0] - 8, head[1] - 8, head[0] + 8, head[1] + 8], fill=GOLD,
                  outline=(12, 18, 32), width=2)

    def draw_place(self, canvas: Image.Image, place: str, ring: float | None) -> None:
        x, y = self.px(place)
        d = ImageDraw.Draw(canvas)
        if ring is not None:
            for phase in (ring, (ring + 0.34) % 1, (ring + 0.67) % 1):
                r = 16 + 58 * phase
                d.ellipse([x - r, y - r, x + r, y + r], outline=GOLD, width=3)
        d.ellipse([x - 11, y - 11, x + 11, y + 11], fill=GOLD, outline=WHITE, width=3)

    def draw_leader(self, canvas: Image.Image, origin: tuple[float, float], slot: int, progress: float) -> None:
        x, y = origin
        cx, cy = SLOTS[slot]
        tx, ty = cx + 20, cy + 18
        ex, ey = x + (tx - x) * progress, y + (ty - y) * progress
        d = ImageDraw.Draw(canvas)
        d.line([x, y, ex, ey], fill=GOLD, width=3)
        d.ellipse([ex - 6, ey - 6, ex + 6, ey + 6], fill=GOLD, outline=INK, width=2)

    def card(self, title: str, caption: str, credits: dict) -> Image.Image:
        layer = Image.new("RGBA", (CARD_W, CARD_H + CARD_CAP), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle([0, 0, CARD_W - 1, CARD_H + CARD_CAP - 1], 12, fill=(15, 23, 42, 236))
        src = IMAGES / f"{slug(title)}.jpg"
        if src.exists():
            photo = Image.open(src).convert("RGB").resize((CARD_W - 12, CARD_H - 12), Image.Resampling.LANCZOS)
            mask = Image.new("L", photo.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, photo.width, photo.height], 9, fill=255)
            layer.paste(photo, (6, 6), mask)
        credit = credits.get(slug(title)) or {}
        artist = (credit.get("artist") or "").split(" from ")[0].split(",")[0].strip()[:26]
        d.text((14, CARD_H + 4), caption, font=font(19, True), fill=WHITE)
        d.text((14, CARD_H + 30), " · ".join(x for x in (artist, credit.get("license"), "Wikimedia") if x),
               font=font(13), fill=MUTED)
        return layer

    def panel(self, revealed: int, active: int = -1) -> Image.Image:
        key = revealed * 100 + (active if active >= 0 else 99)
        if key in self.panel_cache:
            return self.panel_cache[key]
        day = self.trip.days[self.day_index]
        layer = Image.new("RGB", (W - PANEL_X, H), PANEL)
        d = ImageDraw.Draw(layer)
        d.rectangle([0, 0, 3, H], fill=ACCENT)
        x0, x1, y = 56, W - PANEL_X - 56, 92

        d.text((x0, y), f"DAY {day['n']}", font=font(30, True), fill=ACCENT)
        d.text((x0 + d.textlength(f"DAY {day['n']}", font=font(30, True)) + 20, y + 4),
               f"/ {len(self.trip.days)}   ·   {day.get('date_label', '')}", font=font(25), fill=MUTED)
        y += 62
        d.text((x0, y), day["base"], font=font(56, True), fill=WHITE)
        y += 84
        for line in wrap(d, day["title"], font(31), x1 - x0)[:2]:
            d.text((x0, y), line, font=font(31), fill=(226, 232, 240))
            y += 42
        y += 22
        d.line([x0, y, x1, y], fill=(51, 65, 85), width=2)
        y += 30

        bullets = day.get("bullets", [])
        bottom = 190 if (day.get("cost") or day.get("caveat")) else 60
        avail = (H - bottom) - y - (34 if day.get("transit_note") else 0)

        # auto-fit: a long script shrinks the bullets instead of spilling over the cost line
        size = 25
        while size > 16:
            total = 0
            for i, bullet in enumerate(bullets):
                fs = size + 1 if i == active else size
                total += len(wrap(d, bullet, font(fs), x1 - x0 - 28)) * round(fs * 1.32) + 8
            if total <= avail:
                break
            size -= 2

        for i, bullet in enumerate(bullets):
            on, hot = i < revealed, i == active
            col = GOLD if hot else ((226, 232, 240) if on else FADED)
            fs = size + 1 if hot else size
            step = round(fs * 1.32)
            d.ellipse([x0, y + 10, x0 + 9, y + 19], fill=col)
            for line in wrap(d, bullet, font(fs), x1 - x0 - 28):
                if y + step > H - bottom:
                    break
                d.text((x0 + 28, y), line, font=font(fs), fill=col)
                y += step
            y += 8
        if day.get("transit_note"):
            y += 10
            for line in wrap(d, day["transit_note"], font(19), x1 - x0):
                d.text((x0, y), line, font=font(19), fill=DIM)
                y += 26
        fy = H - 126
        d.line([x0, fy - 24, x1, fy - 24], fill=(51, 65, 85), width=2)
        if day.get("cost"):
            label = f"≈ {self.trip.data.get('currency', 'S$')}{day['cost']}"
            d.text((x0, fy), label, font=font(40, True), fill=WHITE)
            d.text((x0 + d.textlength(label, font=font(40, True)) + 14, fy + 12),
                   "per person, on the ground", font=font(21), fill=MUTED)
        if day.get("caveat"):
            for line in wrap(d, "⚠ " + day["caveat"], font(21), x1 - x0):
                d.text((x0, fy + 58), line, font=font(21), fill=(251, 191, 36))
                fy += 26
        self.panel_cache[key] = layer
        return layer


def compose(rig: Rig, revealed: int, active: int,
            routes: list[tuple[tuple[str, str], float]],
            place: tuple[str, float | None] | None,
            leader: tuple[tuple[float, float], int, float] | None) -> Image.Image:
    canvas = Image.new("RGB", (W, H), PANEL)
    canvas.paste(rig.map, (0, 0))
    for leg, progress in routes:
        rig.draw_route(canvas, leg, progress)
    if place:
        rig.draw_place(canvas, place[0], place[1])
    if leader:
        rig.draw_leader(canvas, *leader)
    for card, pos in rig.cards:
        canvas.paste(card, pos, card)
    canvas.paste(rig.panel(revealed, active), (PANEL_X, 0))
    return canvas


# ---------- audio ----------
def _valid_mp3(path: Path) -> bool:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
        return float(out.stdout.strip() or 0) > 0.2
    except (OSError, ValueError, subprocess.CalledProcessError):
        return False


def _tts_path(trip: Trip, name: str, speed: float = 1.3) -> Path:
    tag = "" if speed == 1.0 else f"-{speed:g}x"
    return trip.tts / f"{name}{tag}.mp3"


def narrate(trip: Trip, name: str, text: str, speed: float = 1.3, tries: int = 5) -> Path:
    from gtts import gTTS
    trip.tts.mkdir(parents=True, exist_ok=True)
    raw, fast = trip.tts / f"{name}.mp3", _tts_path(trip, name, speed)
    if fast.exists() and _valid_mp3(fast):
        return fast
    for attempt in range(tries):
        if not raw.exists() or not _valid_mp3(raw):
            raw.unlink(missing_ok=True)
            try:
                gTTS(text=text, lang="en", tld="com").save(str(raw))
            except Exception as exc:
                print(f"  tts {name} attempt {attempt + 1}: {exc}", flush=True)
                time.sleep(2 * (attempt + 1))
                continue
            time.sleep(1.0)
            if not _valid_mp3(raw):
                time.sleep(2 * (attempt + 1))
                continue
        filters = ["-filter:a", f"atempo={speed:g}"] if speed != 1.0 else []
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), *filters,
                        "-b:a", "128k", str(fast)], check=True)
        if _valid_mp3(fast):
            return fast
        fast.unlink(missing_ok=True)
    raise SystemExit(f"could not synthesise {name}")


def prefetch_tts(trip: Trip, workers: int = 4) -> None:
    """Synthesise every narration clip before rendering starts.

    Each gTTS call is a network round trip with a mandatory pause. Doing them
    one at a time inside the day workers meant minutes of waiting on audio, and
    a rate-limit failure only showed up halfway through a render.
    """
    jobs = [(f"intro{i}", b.get("text", "")) for i, b in enumerate(trip.intro_beats)] or \
           [("intro0", trip.title)]
    for day in trip.days:
        jobs += [(f"d{day['n']}b{i}", b.get("text", "")) for i, b in enumerate(day.get("beats", []))]
    jobs.append(("outro", trip.outro.get("text", "")))

    todo = [j for j in jobs if not _valid_mp3(_tts_path(trip, j[0]))]
    if not todo:
        return
    print(f"  tts: synthesising {len(todo)}/{len(jobs)} clips across {workers} threads", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        list(pool.map(lambda job: narrate(trip, job[0], job[1]), todo))


# ---------- intro / outro ----------
_BACKDROPS: dict[tuple[str, int], Image.Image] = {}


def dark_backdrop(trip: Trip, day_index: int = 0) -> Image.Image:
    """The dimmed map behind the intro/outro cards, built once per trip.

    Building it per card meant re-downloading every map tile for every intro
    frame — by far the slowest part of a render.
    """
    key = (str(trip.path), day_index)
    if key not in _BACKDROPS:
        rig = Rig(trip, day_index)
        map_img = rig.map.resize((W, H))
        _BACKDROPS[key] = Image.blend(map_img, Image.new("RGB", (W, H), INK), 0.70)
    return _BACKDROPS[key]


def intro_card(trip: Trip, focus: str | None = None, pulse: float = 0.0) -> Image.Image:
    canvas = dark_backdrop(trip, 0).copy()
    d = ImageDraw.Draw(canvas)

    def look(key: str) -> tuple[bool, float]:
        on = focus is None or focus == key or (focus.startswith("highlight") and key == "highlights")
        return on, (1.0 + 0.05 * pulse) if (focus == key) else 1.0

    # title
    _, scale = look("title")
    d.text((110, 172), trip.title, font=font(round(96 * scale), True), fill=WHITE)
    d.text((114, 292), trip.subtitle, font=font(34), fill=(226, 232, 240))

    # flight box
    f = trip.flights
    set_flights = (110, 356, 1180, 604)
    hot = focus == "flights"
    d.rounded_rectangle(set_flights, 16, fill=(15, 23, 42),
                        outline=GOLD if hot else (51, 65, 85), width=3 if hot else 2)
    x, y = set_flights[0] + 30, set_flights[1] + 22
    d.text((x, y), f.get("status", "FLIGHTS"), font=font(24, True),
           fill=GOLD if hot else (251, 191, 36))
    y += 42
    d.text((x, y), f.get("from_name", ""), font=font(38, True), fill=WHITE)
    ax = x + d.textlength(f.get("from_name", ""), font=font(38, True)) + 24
    d.text((ax, y + 4), f"✈  {f.get('duration', '')}", font=font(26), fill=GOLD if hot else MUTED)
    y += 52
    d.text((x, y), f.get("to_name", ""), font=font(38, True), fill=WHITE)
    y += 54
    for line in (f.get("carriers", ""), f.get("fare", "")):
        if line:
            d.text((x, y), line, font=font(22), fill=MUTED)
            y += 30

    # dates + expenses strip
    strip_y = 664
    d.text((110, strip_y), f.get("dates_label", ""), font=font(30, True), fill=WHITE)
    d.text((110 + d.textlength(f.get("dates_label", ""), font=font(30, True)) + 26, strip_y + 4),
           trip.expenses, font=font(27), fill=GOLD if focus == "cost" else MUTED)

    # three highlights, each lit when the narration reaches it
    y = 748
    for i, line in enumerate(trip.highlights[:3]):
        hot = focus == f"highlight{i}"
        col = GOLD if hot else (203, 213, 225 if focus in (None, "title", "flights", "cost") else 148)
        d.ellipse([112, y + 10, 112 + 9, y + 19], fill=col)
        d.text((138, y - (4 if hot else 0)), line, font=font(30 if hot else 27, hot), fill=col)
        y += 46

    d.text((110, H - 96), "Maps © OpenStreetMap · Roads © OSRM · Photos Wikimedia Commons",
           font=font(20), fill=DIM)
    return canvas


def outro_card(trip: Trip) -> Image.Image:
    canvas = dark_backdrop(trip, len(trip.days) - 1).copy()
    d = ImageDraw.Draw(canvas)
    d.text((110, 250), trip.outro.get("heading", "The budget"), font=font(78, True), fill=WHITE)
    y = 372
    for line in wrap(d, trip.outro.get("text", ""), font(35), W - 260):
        d.text((110, y), line, font=font(35), fill=(226, 232, 240))
        y += 50
    music = load_json(MUSIC.with_suffix(".json")) if MUSIC.with_suffix(".json").exists() else {}
    d.text((110, H - 190), "Maps © OpenStreetMap contributors · Roads © OSRM · Photos Wikipedia / Wikimedia Commons",
           font=font(22), fill=MUTED)
    if music:
        d.text((110, H - 152), f"Music: “{music.get('title')}” by {music.get('creator')} · "
                               f"{music.get('license')} · freesound.org", font=font(22), fill=MUTED)
    return canvas


# ---------- day / part rendering ----------
def day_clips(trip: Trip, day_index: int, credits: dict) -> list[Any]:
    import numpy as np
    from moviepy import AudioFileClip, ImageClip, ImageSequenceClip, concatenate_videoclips

    rig = Rig(trip, day_index)
    day = trip.days[day_index]
    routes: list[tuple[tuple[str, str], float]] = [(leg, 1.0) for leg in rig.done_legs]
    revealed, slot = 0, 0
    clips: list[Any] = []

    for index, beat in enumerate(day["beats"]):
        audio = AudioFileClip(str(narrate(trip, f"d{day['n']}b{index}", beat["text"])))
        budget = audio.duration + 0.3
        if beat.get("bullet") is not None and beat["bullet"] >= revealed:
            revealed = beat["bullet"] + 1
        active = beat["bullet"] if beat.get("bullet") is not None else -1
        frames: list[Any] = []

        if beat.get("leg"):
            leg = tuple(beat["leg"])
            for i in range(ROUTE_N):
                frames.append(np.array(compose(rig, revealed, active,
                                               routes + [(leg, (i + 1) / ROUTE_N)], None, None)))
            routes.append((leg, 1.0))
            anim_s = ROUTE_N / ROUTE_FPS
            card_img = pos = None
            if beat.get("image"):
                card_img = rig.card(beat["image"], beat.get("caption") or beat["image"], credits)
                pos = SLOTS[slot % len(SLOTS)]
                head = rig.leg_end(leg)
                for i in range(SWEEP_N):
                    p = (i + 1) / SWEEP_N
                    frame = compose(rig, revealed, active, routes, None, (head, slot % len(SLOTS), p))
                    faded = card_img.copy()
                    faded.putalpha(card_img.getchannel("A").point(lambda v, a=min(1.0, p * 1.5): int(v * a)))
                    frame.paste(faded, pos, faded)
                    frames.append(np.array(frame))
                rig.cards.append((card_img, pos))
                slot += 1
                anim_s += SWEEP_N / SWEEP_FPS
            hold = (routes, None, (rig.leg_end(leg), slot - 1, 1.0) if card_img is not None else None)
            fps = ROUTE_FPS
        else:
            place = beat["at"]
            for i in range(PULSE_N):
                frames.append(np.array(compose(rig, revealed, active, routes,
                                               (place, i / PULSE_N), None)))
            card_img = pos = None
            if beat.get("image"):
                card_img = rig.card(beat["image"], beat.get("caption") or beat["image"], credits)
                pos = SLOTS[slot % len(SLOTS)]
            for i in range(SWEEP_N):
                p = (i + 1) / SWEEP_N
                frame = compose(rig, revealed, active, routes, (place, 1 - 1e-6),
                                (rig.px(place), slot % len(SLOTS), p) if pos else None)
                if card_img is not None and pos is not None:
                    faded = card_img.copy()
                    faded.putalpha(card_img.getchannel("A").point(lambda v, a=min(1.0, p * 1.5): int(v * a)))
                    frame.paste(faded, pos, faded)
                frames.append(np.array(frame))
            if card_img is not None and pos is not None:
                rig.cards.append((card_img, pos))
                slot += 1
            anim_s = PULSE_N / PULSE_FPS + SWEEP_N / SWEEP_FPS
            hold = (routes, (place, None),
                    (rig.px(place), slot - 1, 1.0) if card_img is not None else None)
            fps = PULSE_FPS

        anim = ImageSequenceClip(frames, fps=fps)
        still = ImageClip(np.array(compose(rig, revealed, active, *hold))).with_duration(
            max(0.35, budget - anim_s))
        clips.append(concatenate_videoclips([anim, still], method="chain").with_audio(audio))
    return clips


def _write_part(path: Path, clip: Any) -> None:
    from moviepy import vfx
    clip = clip.with_effects([vfx.FadeIn(0.25)])
    clip.write_videofile(str(path), fps=24, codec="libx264", audio_codec="aac",
                         preset="medium", bitrate="3400k", threads=4,
                         ffmpeg_params=["-pix_fmt", "yuv420p"], logger=None)
    clip.close()


def render_intro(trip: Trip) -> Path:
    import numpy as np
    from moviepy import AudioFileClip, ImageClip, ImageSequenceClip, concatenate_videoclips

    path = trip.parts / "intro.mp4"
    if path.exists():
        return path
    trip.parts.mkdir(parents=True, exist_ok=True)
    clips = []
    beats = trip.intro_beats or [{"text": trip.title, "focus": "title"}]
    for i, beat in enumerate(beats):
        audio = AudioFileClip(str(narrate(trip, f"intro{i}", beat["text"])))
        frames = []
        for k in range(INTRO_N):
            p = (k + 1) / INTRO_N
            frames.append(np.array(intro_card(trip, beat.get("focus"), p)))
        anim = ImageSequenceClip(frames, fps=INTRO_FPS)
        still = ImageClip(np.array(intro_card(trip, beat.get("focus"), 1.0))).with_duration(
            max(0.4, audio.duration + 0.3 - INTRO_N / INTRO_FPS))
        clips.append(concatenate_videoclips([anim, still], method="chain").with_audio(audio))
    _write_part(path, concatenate_videoclips(clips, method="compose"))
    for c in clips:
        c.close()
    return path


def render_outro(trip: Trip) -> Path:
    import numpy as np
    from moviepy import AudioFileClip, ImageClip

    path = trip.parts / "outro.mp4"
    if path.exists():
        return path
    trip.parts.mkdir(parents=True, exist_ok=True)
    audio = AudioFileClip(str(narrate(trip, "outro", trip.outro.get("text", ""))))
    _write_part(path, ImageClip(np.array(outro_card(trip))).with_duration(audio.duration + 0.5)
                .with_audio(audio))
    audio.close()
    return path


def render_day(args: tuple[str, int]) -> str:
    trip_path, day_index = args
    trip = Trip(Path(trip_path))
    credits = load_json(IMAGES / "credits.json") if (IMAGES / "credits.json").exists() else {}
    path = trip.parts / f"day{trip.days[day_index]['n']:02d}.mp4"
    if path.exists():
        return str(path)
    trip.parts.mkdir(parents=True, exist_ok=True)
    clips = day_clips(trip, day_index, credits)
    _write_part(path, concatenate_or_single(clips))
    for c in clips:
        c.close()
    return str(path)


def concatenate_or_single(clips: list[Any]) -> Any:
    from moviepy import concatenate_videoclips
    return concatenate_videoclips(clips, method="compose") if len(clips) > 1 else clips[0]


def render_all(trip: Trip, workers: int) -> list[Path]:
    prefetch_tts(trip, workers)
    parts: list[Path] = [render_intro(trip)]
    with concurrent.futures.ProcessPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(render_day, (str(trip.path), i)): i for i in range(len(trip.days))}
        for fut in concurrent.futures.as_completed(futures):
            path = Path(fut.result())
            print(f"  rendered {path.name} ({path.stat().st_size / 1e6:.1f} MB)", flush=True)
            parts.append(path)
    parts.append(render_outro(trip))
    return sorted(parts, key=lambda p: (-1 if p.stem == "intro" else 99 if p.stem == "outro"
                                        else int(re.sub(r"\D", "", p.stem) or 0)))


def concat(trip: Trip, parts: list[Path]) -> Path:
    """Join encoded parts with a stream copy, then mix the music in one audio pass."""
    trip.parts.mkdir(parents=True, exist_ok=True)
    listing = trip.parts / "parts.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    joined = trip.out / "video-only.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(listing), "-c", "copy", str(joined)], check=True)

    duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                     "-of", "csv=p=0", str(joined)],
                                    capture_output=True, text=True, check=True).stdout.strip())
    fade_start = max(0.0, duration - 2.5)
    music = MUSIC
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(joined),
                    "-stream_loop", "-1", "-i", str(music),
                    "-filter_complex",
                    f"[1:a]volume=0.13,afade=t=out:st={fade_start:.1f}:d=2.5[m];"
                    f"[0:a][m]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", str(trip.final)], check=True)
    joined.unlink(missing_ok=True)
    print(f"\nwrote {trip.final}  ({duration:.0f}s, {trip.final.stat().st_size / 1e6:.1f} MB)")
    return trip.final


WORDS_PER_SEC = 3.05   # gTTS at 1.3x, measured — 2 minutes ≈ 370 words


def check(trip: Trip) -> None:
    """Report what is wrong with a script before rendering anything.

    One pass over the JSON is cheaper than rendering, watching, and regenerating:
    the report names the specific beat, day or place to fix, and it fails fast on
    the things that would otherwise crash mid-render (missing geocode or road).
    """
    errors: list[str] = []
    warns: list[str] = []
    geo, routes = trip.geocodes, trip.routes

    for name in trip.places():
        if name not in geo:
            errors.append(f"no geocode for {name!r} — run prepare (or add it to {GEOCODES.name})")
    for a, b in trip.legs():
        if f"{a}>{b}" not in routes:
            errors.append(f"no road route for {a} → {b} — run prepare")

    words = 0
    for day in trip.days:
        n = day.get("n", "?")
        for key in ("n", "base", "title"):
            if not day.get(key):
                errors.append(f"day {n}: missing {key!r}")
        beats, bullets = day.get("beats") or [], day.get("bullets") or []
        if not beats:
            errors.append(f"day {n}: no beats")
        if not bullets:
            warns.append(f"day {n}: no bullets — the side panel stays empty")
        if len(bullets) > len(beats):
            warns.append(f"day {n}: {len(bullets)} bullets but {len(beats)} beats — the last ones never light up")
        for i, beat in enumerate(beats):
            text = beat.get("text", "")
            if not text.strip():
                errors.append(f"day {n} beat {i}: empty narration")
            words += len(text.split())
            if beat.get("leg") and tuple(beat["leg"]) not in [tuple(l) for l in trip.legs()]:
                warns.append(f"day {n} beat {i}: leg {beat['leg']} not used elsewhere")
            if beat.get("image"):
                if not (IMAGES / f"{slug(beat['image'])}.jpg").exists():
                    warns.append(f"day {n} beat {i}: no photo cached for {beat['image']!r} — run prepare or drop the image")
                if not beat.get("caption"):
                    warns.append(f"day {n} beat {i}: image without a caption")
            if beat.get("image") and not (beat.get("at") or beat.get("leg")):
                warns.append(f"day {n} beat {i}: image but no place or leg to point at")

    intro_words = sum(len(b.get("text", "").split()) for b in trip.intro_beats)
    outro_words = len(trip.outro.get("text", "").split())
    total = words + intro_words + outro_words
    secs = total / WORDS_PER_SEC
    print(f"\ncheck: {len(trip.days)} days · intro {intro_words} words · outro {outro_words} words · "
          f"{total} total ≈ {secs:.0f}s ({secs / 60:.1f} min)", flush=True)

    target = trip.data.get("target_seconds")
    if target:
        delta = secs - float(target)
        if abs(delta) > 0.2 * float(target):
            warns.append(f"runtime {secs:.0f}s vs target {target:.0f}s — "
                         f"{'cut' if delta > 0 else 'add'} about {abs(delta) * WORDS_PER_SEC:.0f} words")

    for w in warns:
        print(f"  warn: {w}", flush=True)
    for e in errors:
        print(f"  ERROR: {e}", flush=True)
    if errors:
        raise SystemExit(f"{len(errors)} error(s) — fix the script, then render")
    print("  ok — script is renderable", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["prepare", "check", "render", "concat", "all", "frame"])
    ap.add_argument("--trip", required=True)
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--day", type=int, help="with action=frame: 0 = intro, N = that day")
    args = ap.parse_args()

    trip = Trip(Path(args.trip))
    if args.action in ("prepare", "all"):
        print("prepare:", flush=True)
        prepare(trip)
    if args.action in ("render", "all"):
        check(trip)
        print("render:", flush=True)
        parts = render_all(trip, args.workers)
        print("parts:", ", ".join(p.stem for p in parts), flush=True)
        if args.action == "all":
            concat(trip, parts)
    elif args.action == "check":
        check(trip)
    elif args.action == "concat":
        parts = sorted(trip.parts.glob("*.mp4"),
                       key=lambda p: (-1 if p.stem == "intro" else 99 if p.stem == "outro"
                                      else int(re.sub(r"\D", "", p.stem) or 0)))
        concat(trip, parts)
    elif args.action == "frame":
        credits = load_json(IMAGES / "credits.json") if (IMAGES / "credits.json").exists() else {}
        out = trip.out / "frames"
        out.mkdir(parents=True, exist_ok=True)
        if not args.day:
            img = intro_card(trip, "highlight1", 1.0)
        else:
            rig = Rig(trip, args.day - 1)
            day = trip.days[args.day - 1]
            slot = 0
            for beat in day["beats"]:
                if beat.get("image"):
                    rig.cards.append((rig.card(beat["image"], beat.get("caption") or beat["image"], credits),
                                      SLOTS[slot % len(SLOTS)]))
                    slot += 1
            routes = [(tuple(b["leg"]), 1.0) for d in trip.days[:args.day] for b in d["beats"] if b.get("leg")]
            last = next((b["at"] for b in reversed(day["beats"]) if b.get("at")), None)
            img = compose(rig, len(day.get("bullets", [])), -1, routes,
                          (last, None) if last else None,
                          (rig.px(last), max(0, slot - 1), 1.0) if last and slot else None)
        path = out / f"frame-{args.day or 0:02d}.png"
        img.save(path)
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())

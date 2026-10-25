#!/usr/bin/env python3
"""Bundle a trip's local data/*.json snapshot into one portable trip document.

A bundle is the unit the app moves between three places:
  - the PocketBase rows (`trips` + one `trip_docs` row per section),
  - a file on the user's machine (this script's output),
  - the browser's offline cache (localStorage, seeded from the same shape).

Usage:  python3 tools/bundle_trip.py [--id vietnam-2026] [--out data/trips]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SCHEMA = "nomad.trip.bundle.v1"
SECTIONS = ("itinerary", "accommodation", "expenses", "packing",
            "recommendations", "decisions", "travellers")


def load(name: str):
    path = DATA / f"{name}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError as exc:
        raise SystemExit(f"{path}: {exc}") from exc


def build_bundle(trip_id: str) -> dict:
    trip = load("trip") or {}
    docs = {}
    for section in SECTIONS:
        value = load(section)
        if value is not None:
            docs[section] = value
    return {
        "schema": SCHEMA,
        "trip_id": trip_id,
        "exported_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        # `id` is the bundle's local identity; the server assigns its own 15-char record id
        "trip": {**trip, "id": trip_id},
        "docs": docs,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default="vietnam-2026")
    ap.add_argument("--out", default=str(DATA / "trips"))
    args = ap.parse_args()

    bundle = build_bundle(args.id)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{args.id}.json"
    path.write_text(json.dumps(bundle, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    sizes = {name: len(json.dumps(v, ensure_ascii=False)) for name, v in bundle["docs"].items()}
    print(f"wrote {path}  ({path.stat().st_size / 1024:.0f} KB)")
    print(f"trip: {bundle['trip'].get('title', '?')}  sections: {len(bundle['docs'])}")
    for name, size in sorted(sizes.items(), key=lambda kv: -kv[1]):
        print(f"  {name:16s} {size / 1024:6.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

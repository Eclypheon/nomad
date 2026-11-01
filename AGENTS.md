# AGENTS.md — nomadproj

## Overview & Architecture
Vanilla JS mobile-first travel itinerary and fare discovery application with PocketBase backend and offline service worker support.

- `app.js`: Main application logic, screen rendering, and event dispatching.
- `auth.js`: User authentication and session persistence.
- `backends/`: PocketBase / local storage adapters.
- `pocketbase-config.js`: PocketBase endpoint configuration.
- `styles.css`: Pure CSS design tokens, responsive layouts, and animations.
- `sw.js`: Service worker for offline caching.

## Agent Rules
- **No Build Step:** Direct vanilla ES modules / scripts; do not add unnecessary bundlers or transpilers unless requested.
- **Selective Inspection:** `app.js` is large (~270 KB); do NOT load the entire file into context. Use `rg -n "function_or_symbol"` followed by bounded line reads (`read_file`).
- **State Integrity:** Keep offline service worker sync behaviors intact when editing data routines.

# Nomad — Collaborative Trip & Travel Companion

Nomad is a modern, reactive, mobile-first travel planning companion designed for friends and solo travelers alike. It pairs an AI-curated suggested baseline itinerary with interactive swapping of ideas, stays, live group decision polls, and real-time expense headroom tracking — synced securely to your private cloud backend.

Deployed to GitHub Pages: [eclypheon.github.io/nomad](https://eclypheon.github.io/nomad/)

---

## Key Features

1. **AI-Suggested Itinerary & Swappable Activities**:
   - Day-by-day schedules pre-planned with smart timing, transit legs, night lodging, and cost estimates.
   - **1-Tap Idea Swap**: Easily swap or insert recommendations (Michelin eateries, viewpoints, specialty cafes, cultural walks) directly into any day.

2. **Curated Stays & Lodging**:
   - Filter stays by city, neighborhood, or base.
   - Detailed night counts, room rates, status tags (*Booked*, *Planning*, *Wishlist*, *Splurge*), and direct booking links.

3. **Dynamic Group Decisions & Budget Headroom**:
   - Vote or decide on key trip trade-offs (e.g. flight dates, tour formats, room splurges, NYE locations).
   - **Live Budget Linking**: Picking an option automatically applies its cost delta (e.g. `-S$154` or `+S$50`) to the trip's planned spend, recalculating remaining budget headroom and banner metrics reactively.
   - Outlines exact itinerary and accommodation impact for each choice.

4. **Shared Expenses & Multi-Currency Tracking**:
   - Visual spend breakdown across Lodging, Transit, Activities, Food, and Contingency.
   - Itemized expense records with category filters, payment tracking, and status.

5. **Trip Switcher & Multi-Trip Hub**:
   - Switch seamlessly between multiple adventures (e.g. *Vietnam 2026*, *Japan Autumn*, *Bali Getaway*).
   - Fast deep-linking via URL hash (e.g. `#trip=<trip_id>`).

6. **Private & Secure Cloud Backend**:
   - Unauthenticated visitors see only a clean landing view; trip details and itineraries remain strictly access-controlled.
   - Seamless Google OAuth sign-in powered by self-hosted PocketBase behind a Tailscale Funnel and Caddy reverse proxy.

---

## Project Structure

```
nomadproj/
├── index.html                # App shell, landing view, trip dashboard, and action sheets
├── app.js                    # Reactive state manager, tab renderers, idea swapper & budget math
├── styles.css                # Dark-first glassmorphic stylesheet with responsive mobile navigation
├── auth.js                   # Backend facade interface for auth and sync
├── pocketbase-config.js      # Backend endpoint configuration (Tailscale Funnel URL)
├── backends/
│   ├── pocketbase-adapter.js # PocketBase client adapter (OAuth, trip docs, member permissions)
│   └── vendor/               # Vendored PocketBase JS SDK
├── data/                     # Optional local schema seed templates (trip, itinerary, stays, etc.)
└── README.md                 # This documentation
```

---

## Running Locally

To run the application locally:

```sh
cd nomadproj
python3 -m http.server 8000
# Open http://localhost:8000/
```

---

## Backend Configuration

Nomad communicates with a self-hosted [PocketBase](https://pocketbase.io) instance. The connection is configured in `pocketbase-config.js`:

```javascript
window.POCKETBASE_CONFIG = {
  backendBase: 'https://alienlab.tailbed832.ts.net:10000',
  libUrl: ''
};
```

When authenticated, Nomad syncs six document collections under `trip_docs`:
* `itinerary`: Day-by-day activities, transit details, and night stays.
* `accommodation`: Hotel and guesthouse options, rates, and statuses.
* `expenses`: Itemized planned budget and actual spend.
* `decisions`: Open group choices with signed cost deltas and plan changes.
* `recommendations`: Ideas pool of food spots, sights, and hidden gems.
* `packing`: Categorized packing checklist with local completion states.

/* ==========================================================================
   PocketBase CONFIG — the ONLY place the backend's address appears.

   This is the whole client-side configuration of the backend. There is no
   key here on purpose: a self-hosted PocketBase has no "anon key". The only
   credential the client ever names is
   the OAuth2 provider name ('google'), which lives in the adapter, and the
   Google client SECRET lives in the backend's admin console — never in this
   repo, never in a browser.

     backendBase  Origin of the PocketBase backend, no trailing slash.
                  PocketBase behind Caddy behind a Tailscale Funnel, so it is
                  reachable from anywhere on the internet — a non-tailnet
                  friend opening the GitHub Pages app needs nothing installed.
                  LEAVE THIS EMPTY and the app is the purely local, offline
                  site it started as: data/*.json, localStorage, no backend
                  request, no third-party script, no sign-in UI.

     libUrl       Optional override for the PocketBase JS SDK <script>.
                  Empty = the copy vendored in backends/vendor/ (pinned, no
                  CDN request). Set it only to test against another build.

   Changing the backend = changing backendBase. Nothing else in the app reads
   this file, and no other file hardcodes the hostname.
   ========================================================================== */
window.POCKETBASE_CONFIG = {
  backendBase: 'https://alienlab.tailbed832.ts.net:10000',
  libUrl: ''
};

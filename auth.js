/* ==========================================================================
   Trip app — backend facade.

   app.js never talks to a server. It talks to this file. This file talks to
   exactly one *adapter* (backends/<name>.js) and, when no adapter is
   configured, to nothing at all.

   TODAY: the adapter is backends/pocketbase-adapter.js — the self-hosted
   PocketBase on alienlab (reachable on the public internet through a Tailscale
   Funnel), addressed by pocketbase-config.js. Nothing outside this file and
   backends/ knows that: keep the method names and the adapter can be swapped
   again without touching the UI.

   HARD RULE: with no adapter configured this file makes no third-party
   script load and no network request. The app is then the purely local,
   offline site it was before any of this existed.

   Contract + swap procedure: backends/README.md
   ========================================================================== */
(function (global) {
'use strict';

var DOC_NAMES = ['trip', 'itinerary', 'accommodation', 'expenses', 'packing', 'recommendations', 'decisions'];

/* registered adapters, in preference order */
function registry() {
  var all = global.TripBackends || {}, out = [];
  Object.keys(all).forEach(function (k) {
    var a = all[k];
    if (a && typeof a.isConfigured === 'function') out.push(a);
  });
  return out;
}
function configured() {
  var all = registry();
  for (var i = 0; i < all.length; i++) if (all[i].isConfigured()) return all[i];
  return null;
}

var BACKEND = null;          /* the adapter in use, or null = local mode */
var listeners = [];
var ST = {
  ready: false, error: '', user: null, base: '',
  /* why sign-in is off, straight from the adapter: until the owner authorises
     a Google client the backend answers "not configured" to every auth call,
     and the Share tab says so instead of offering a button that cannot work */
  oauth: { checked: false, ready: false, offline: false, message: '' }
};

function msg(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || e.msg || e.error_description || e.details || String(e);
}
function noBackend() {
  var e = new Error('No backend is configured, so there is nothing to share yet — see backends/README.md.');
  e.code = 'not_configured';
  return e;
}
function status() {
  return {
    configured: !!BACKEND,
    ready: ST.ready,
    error: ST.error,
    user: ST.user,
    backend: BACKEND ? BACKEND.id : '',
    backendLabel: BACKEND ? (BACKEND.label || BACKEND.id) : '',
    /* the address the adapter is talking to: shown in the UI, and the only
       thing the user needs to see when it is not answering */
    backendBase: ST.base || '',
    oauth: {
      checked: !!(ST.oauth && ST.oauth.checked),
      ready: !!(ST.oauth && ST.oauth.ready),
      offline: !!(ST.oauth && ST.oauth.offline),
      message: (ST.oauth && ST.oauth.message) || ''
    }
  };
}
function emit() {
  var s = status();
  listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* one bad listener must not break auth */ } });
}
function copy(st) {
  ST.ready = !!(st && st.ready);
  ST.error = (st && st.error) || '';
  ST.user = (st && st.user) || null;
  if (st && st.backendBase) ST.base = st.backendBase;
  if (st && st.oauth) {
    ST.oauth = {
      checked: !!st.oauth.checked,
      ready: !!st.oauth.ready,
      offline: !!st.oauth.offline,
      message: st.oauth.message || ''
    };
  }
  return status();
}

function init() {
  BACKEND = configured();
  if (!BACKEND) {
    ST.ready = true;
    emit();
    return Promise.resolve(status());
  }
  BACKEND.onChange(function (st) { copy(st); emit(); });
  return BACKEND.init().then(function (st) { copy(st); ST.ready = true; emit(); return status(); },
    function (e) {
      ST.ready = true;
      ST.error = msg(e);
      emit();
      return status();
    });
}

/* every call is a straight pass-through; with no backend each one answers
   truthfully instead of pretending */
function call(method, args) {
  if (!BACKEND) return Promise.reject(noBackend());
  var fn = BACKEND[method];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('The configured backend does not implement ' + method + '().'));
  }
  try {
    var out = fn.apply(BACKEND, args || []);
    return (out && typeof out.then === 'function') ? out : Promise.resolve(out);
  } catch (e) {
    return Promise.reject(e);
  }
}
function read(method, args, fallback) {
  if (!BACKEND) return Promise.resolve(fallback);
  return call(method, args);
}

global.TripAuth = {
  init: init,
  status: status,
  onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); if (ST.ready) fn(status()); } },
  backends: function () { return registry().map(function (a) { return { id: a.id, label: a.label || a.id, configured: !!a.isConfigured() }; }); },
  backendName: function () { return BACKEND ? (BACKEND.label || BACKEND.id) : ''; },
  /* ask the backend again whether any sign-in method is available yet */
  refreshAuthMethods: function () { return read('refresh', [], status()); },

  signIn: function (opts) { return call('signIn', [opts]); },
  signInWithPassword: function (identity, password) { return call('signInWithPassword', [identity, password]); },
  signOut: function () { return read('signOut', [], false); },
  listTrips: function () { return read('listTrips', [], []); },
  createTrip: function (tripData) { return call('createTrip', [tripData]); },
  openTrip: function (key) { return call('openTrip', [key]); },
  joinTrip: function (tripId) { return call('joinTrip', [tripId]); },
  pendingInvites: function () { return read('pendingInvites', [], []); },
  acceptInvite: function (invite) { return call('acceptInvite', [invite]); },
  invite: function (tripId, email) { return call('invite', [tripId, email]); },
  removeMember: function (entry) { return call('removeMember', [entry]); },
  saveDocs: function (tripId, docs) { return call('saveDocs', [tripId, docs]); },
  loadPicks: function (tripId) { return read('loadPicks', [tripId], {}); },
  /* `seed` is the app's own decisions document: the adapter uses it to create
     the section row the first time somebody picks on a trip that has none */
  savePick: function (tripId, decisionId, optionId, seed) { return call('savePick', [tripId, decisionId, optionId, seed]); },
  clearPicks: function (tripId) { return read('clearPicks', [tripId], false); },
  shareLink: function (slug) {
    if (BACKEND && typeof BACKEND.shareLink === 'function') return BACKEND.shareLink(slug);
    return location.origin + location.pathname + '#trip=' + encodeURIComponent(String(slug || ''));
  },
  docNames: DOC_NAMES
};

})(window);

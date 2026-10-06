/* ==========================================================================
   Backend adapter — PocketBase (self-hosted on alienlab).

   This is the one file in the app that talks to a server. app.js never does:
   it goes through auth.js, which delegates to the adapter registered as
   window.TripBackends.pocketbase. The contract is backends/README.md.

   Target: PocketBase behind Caddy behind a Tailscale Funnel, so the base URL
   is on the public internet — no tailnet membership, no VPN, no key. This
   backend has NO anon key: the only credential the client ever names is the
   OAuth2 PROVIDER ('google'). The Google client secret lives in the backend's
   admin console and never in this repo.

   RULES this file keeps:
   * Nothing here runs, and no request or third-party script is loaded, until
     pocketbase-config.js holds a base URL. With it empty the app stays the
     purely local, offline site it was before any of this existed.
   * Every failure is an Error with a human-readable `message` (the UI shows
     it) and an optional `code`: not_configured | not_found | bad_request |
     no_session | auth | db.
   * Authorisation is the SERVER's job (collection rules). Nothing here tries
     to enforce it client-side.

   Data model it codes against — one row per (trip, section), the whole JSON
   document in `data`, exactly the shape of the app's data/*.json:
     trips, trip_members, trip_invites, trip_docs
   Decisions picks are not a collection of their own: a pick is written into
   the decisions document as `picked_option_id` / `picked_by` / `picked_at` on
   the decision it belongs to (see savePick below).
   ========================================================================== */
(function (global) {
'use strict';

var DOC_NAMES = ['trip', 'itinerary', 'accommodation', 'expenses', 'packing', 'recommendations', 'decisions'];
var SECTIONS  = ['itinerary', 'accommodation', 'expenses', 'packing', 'recommendations', 'decisions'];
var PROVIDER  = 'google';                    /* the only "key" in the client */
var STORE_KEY = 'pocketbase_auth';           /* PocketBase JS SDK default store key */
var DEFAULT_LIB = 'backends/vendor/pocketbase.umd.js';   /* vendored, see backends/vendor/README.md */

var CFG = global.POCKETBASE_CONFIG || {};
var BASE = normBase(CFG.backendBase);

var ST = {
  ready: false,
  error: '',
  user: null,
  lib: false,
  libError: '',
  pb: null,
  oauth: { checked: false, ready: false, offline: false, message: '' },
  roles: {}                    /* trip id -> role, remembered from openTrip  */
};
var listeners = [];

/* ------------------------------------------------------------------ helpers */

function normBase(v) {
  var s = typeof v === 'string' ? v.trim() : '';
  return s ? s.replace(/\/+$/, '') : '';
}
function isConfigured() { return !!BASE; }
function libUrl() {
  var s = typeof CFG.libUrl === 'string' ? CFG.libUrl.trim() : '';
  return s || DEFAULT_LIB;
}
function msg(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e.data && typeof e.data === 'object') {
    /* PocketBase field-level validation: surface the first useful sentence */
    var keys = Object.keys(e.data);
    for (var i = 0; i < keys.length; i++) {
      var f = e.data[keys[i]];
      if (f && f.message) return keys[i] + ': ' + f.message;
    }
  }
  return e.message || e.msg || e.error_description || e.details || String(e);
}
function err(message, code) {
  var e = new Error(message);
  if (code) e.code = code;
  return e;
}
function quote(v) { return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function copyJson(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function isPBId(s) { return /^[a-z0-9]{15}$/i.test(String(s || '').trim()); }
/* a pasted share link, a '#trip=…' hash or a bare id all resolve to the id */
function keyFrom(text) {
  var s = String(text == null ? '' : text).trim();
  if (!s) return '';
  var m = /(?:^|[#?&/])trip=([^&\s]+)/i.exec(s);
  if (m) { try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; } }
  s = s.trim().replace(/\/+$/, '');
  if (isPBId(s)) return s;
  var tail = s.split('/').pop();
  return tail && tail !== s && isPBId(tail) ? tail : s;
}
function notConfigured() {
  return err('No backend is configured, so there is nothing to share yet — set backendBase in pocketbase-config.js.', 'not_configured');
}
function oauthHelpMessage() {
  return 'Google sign-in is not switched on for this backend yet. The owner has to authorise the Google ' +
    'client (client ID + secret) in the PocketBase admin console — Settings → Auth providers → Google — with ' +
    'the redirect URI ' + (BASE ? BASE + '/api/oauth2-redirect' : 'the base URL + /api/oauth2-redirect') +
    '. Until then the backend answers “not configured” and no sign-in method is available.';
}
function wireError(e) {
  var m = msg(e);
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) {
    return err('Could not reach the backend at ' + BASE + ' (' + m + '). Local mode still works: every tab renders from data/*.json.', 'db');
  }
  return e instanceof Error ? e : err(m, 'db');
}
function friendly(e) {
  var m = msg(e);
  if (/not configured to allow OAuth2|Missing or invalid provider/i.test(m)) return err(oauthHelpMessage(), 'auth');
  if (e && e.status === 401) return err('Your session is no longer valid — sign in again.', 'auth');
  if (e && e.status === 404) return err('The backend has no such record (404). ' + m, 'not_found');
  return wireError(e);
}

function status() {
  return {
    configured: isConfigured(),
    ready: ST.ready,
    error: ST.error,
    user: ST.user,
    libLoaded: ST.lib,
    backendBase: BASE,
    oauth: { checked: !!ST.oauth.checked, ready: !!ST.oauth.ready, offline: !!ST.oauth.offline, message: ST.oauth.message || '' }
  };
}
function emit() {
  var s = status();
  listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* one bad listener must not break auth */ } });
}
function userFrom(record) {
  if (!record) return null;
  return {
    id: record.id,
    email: String(record.email || ''),
    name: String(record.name || ''),
    avatar: String(record.avatar || '')
  };
}
function setUser(u) {
  ST.user = u || null;
  emit();
}

/* --------------------------------------------------------------- the SDK */

function loadLib() {
  return new Promise(function (resolve, reject) {
    if (global.PocketBase) { ST.lib = true; return resolve(global.PocketBase); }
    if (typeof document === 'undefined') return reject(err('No DOM: cannot load the PocketBase SDK.', 'lib'));
    var s = document.createElement('script');
    s.src = libUrl();
    s.async = true;
    s.onload = function () {
      if (global.PocketBase) { ST.lib = true; resolve(global.PocketBase); }
      else reject(err('The PocketBase SDK loaded from ' + s.src + ' but did not define window.PocketBase.', 'lib'));
    };
    s.onerror = function () {
      reject(err('Could not load the PocketBase SDK from ' + s.src + '. Offline?', 'lib'));
    };
    document.head.appendChild(s);
  });
}
function pb() {
  if (!isConfigured()) return Promise.reject(notConfigured());
  return loadLib().then(function (lib) {
    if (!ST.pb) ST.pb = new lib(BASE);
    return ST.pb;
  });
}
/* a plain fetch, so the "is Google configured?" probe costs no SDK load */
function probeAuthMethods() {
  if (typeof fetch !== 'function') return Promise.reject(err('This browser has no fetch().', 'db'));
  return fetch(BASE + '/api/collections/users/auth-methods', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw err('auth-methods returned HTTP ' + r.status, 'db');
      return r.json();
    });
}
function setOauthFrom(methods) {
  var o = (methods && methods.oauth2) || {};
  var providers = (o.providers || []).map(function (p) { return p && p.name; });
  var ready = !!o.enabled && providers.indexOf(PROVIDER) !== -1;
  ST.oauth = { checked: true, ready: ready, offline: false, message: ready ? '' : oauthHelpMessage() };
  return ST.oauth;
}

/* ------------------------------------------------------------------- init */

function storedToken() {
  try {
    var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
    if (!raw) return '';
    var v = JSON.parse(raw);
    return (v && v.token) || '';
  } catch (e) { return ''; }
}

function init() {
  if (!isConfigured()) {
    ST.ready = true;
    ST.oauth = { checked: true, ready: false, offline: false, message: 'No backend is configured (backendBase is empty in pocketbase-config.js).' };
    emit();
    return Promise.resolve(status());
  }
  return probeAuthMethods().then(function (methods) {
    setOauthFrom(methods);
    emit();
  }, function (e) {
    ST.oauth = { checked: false, ready: false, offline: true, message: '' };
    ST.error = msg(wireError(e));
    emit();
  }).then(function () {
    return storedToken() ? restoreSession() : null;
  }).then(function () {
    ST.ready = true;
    emit();
    return status();
  }, function (e) {
    ST.ready = true;
    ST.error = msg(wireError(e));
    emit();
    return status();
  });
}

function restoreSession() {
  return pb().then(function (p) {
    if (!p.authStore.isValid) { p.authStore.clear(); return null; }
    setUser(userFrom(p.authStore.record));
    p.authStore.onChange(function () { setUser(userFrom(p.authStore.record)); });
    return p.collection('users').authRefresh().then(function (res) {
      setUser(userFrom(res && res.record));
      return null;
    }, function (e) {
      /* an expired or revoked token is not an error worth shouting about */
      p.authStore.clear();
      setUser(null);
      if (e && e.status && e.status !== 401 && e.status !== 403) ST.error = msg(wireError(e));
      return null;
    });
  });
}

/* ------------------------------------------------------------------- auth */

function signIn() {
  if (!isConfigured()) return Promise.reject(notConfigured());
  var before = { blockedPopup: false };
  return probeAuthMethods().then(function (methods) {
    var st = setOauthFrom(methods);
    if (!st.ready) throw err(oauthHelpMessage(), 'auth');
    return pb();
  }).then(function (p) {
    var origOpen = global.open;
    if (typeof origOpen === 'function') {
      global.open = function () {
        var w = origOpen.apply(global, arguments);
        if (!w) before.blockedPopup = true;
        return w;
      };
    }
    function done() { if (typeof origOpen === 'function') global.open = origOpen; }
    return p.collection('users').authWithOAuth2({ provider: PROVIDER })
      .then(function (res) { done(); setUser(userFrom(res && res.record)); return null; },
        function (e) {
          done();
          if (before.blockedPopup) {
            throw err('Your browser blocked the sign-in window. Allow pop-ups for this site (the Google ' +
              'consent screen opens in a small window) and click Sign in again.', 'auth');
          }
          throw friendly(e);
        });
  }).catch(function (e) { throw friendly(e); });
}
function signOut() {
  var p = ST.pb;
  ST.roles = {};
  if (!p) { setUser(null); return Promise.resolve(false); }
  try { p.authStore.clear(); } catch (e) { /* nothing to clear */ }
  setUser(null);
  return Promise.resolve(true);
}

/* --------------------------------------------------------------- mapping */

function mapTrip(rec) {
  return {
    id: rec.id,
    /* PocketBase trips have no slug column; the record id IS the share key —
       it is what the share link carries and what openTrip resolves. */
    slug: rec.id,
    name: String(rec.title || ''),
    currency: String(rec.currency || ''),
    travellers: rec.travellers == null ? null : rec.travellers,
    owner_id: rec.owner || '',
    created_at: rec.created || '',
    record: rec
  };
}
/* trips columns -> the shape of the app's data/trip.json */
function tripDoc(rec) {
  return {
    id: rec.id,
    title: rec.title,
    travellers: rec.travellers,
    origin: rec.origin,
    start: dateOnly(rec.start_date),
    end: dateOnly(rec.end_date),
    bases: rec.bases,
    budget: rec.budget,
    currency: rec.currency,
    budget_per_person: rec.budget_per_person,
    budget_currency: rec.budget_currency,
    excludes: rec.excludes,
    notes: rec.notes,
    owner: rec.owner,
    updated: rec.updated || ''
  };
}
function dateOnly(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}
/* data/trip.json -> trips columns (PK fields that are actually columns) */
function tripColumns(doc) {
  var out = {};
  function put(from, to, kind) {
    var v = doc[from];
    if (v === undefined || v === null || v === '') return;
    out[to] = kind === 'date' ? dateOnly(v) : v;
  }
  put('title', 'title');
  put('travellers', 'travellers');
  put('origin', 'origin');
  put('start', 'start_date', 'date');
  put('start_date', 'start_date', 'date');
  put('end', 'end_date', 'date');
  put('end_date', 'end_date', 'date');
  put('bases', 'bases');
  put('budget', 'budget');
  put('currency', 'currency');
  put('budget_per_person', 'budget_per_person');
  put('budget_currency', 'budget_currency');
  put('excludes', 'excludes');
  put('notes', 'notes');
  return out;
}
function mapMember(rec) {
  return {
    id: rec.id,
    kind: 'member',
    trip: rec.trip || '',
    role: rec.role || 'member',
    user_id: rec.member || '',
    invited_email: String(rec.member_email || ''),
    name: String(rec.member_name || ''),
    avatar: String(rec.member_avatar || ''),
    /* PocketBase has no per-membership status: a trip_members row IS access.
       Invitations are separate rows and are surfaced as kind:'invite'. */
    status: 'active'
  };
}
function mapInvite(rec) {
  return {
    id: rec.id,
    kind: 'invite',
    role: rec.role || 'member',
    user_id: '',
    invited_email: String(rec.invite_email || ''),
    name: '',
    avatar: '',
    trip: rec.trip || '',
    trip_title: String(rec.trip_title || ''),
    status: 'invited'
  };
}
function docMap(rows) {
  var docs = {};
  (rows || []).forEach(function (r) { if (r && r.section) docs[r.section] = r.data; });
  return docs;
}

/* ---------------------------------------------------------------- trips */

function listTrips() {
  return pb().then(function (p) {
    /* sort by title, NOT by -created: on this backend the autodate fields of
       the Base collections are empty, and sorting by one answers
       HTTP 400 "Something went wrong while processing your request" (verified
       against the live API with an owner token). */
    return p.collection('trips').getFullList({ sort: 'title', requestKey: null });
  }).then(function (rows) { return (rows || []).map(mapTrip); }, function (e) { throw friendly(e); });
}

function openTrip(key) {
  var k = keyFrom(key);
  if (!k) return Promise.reject(err('No trip given.', 'bad_request'));
  return pb().then(function (p) {
    return p.collection('trips').getOne(k, { requestKey: null }).then(function (trip) {
      var f = 'trip = ' + quote(trip.id);
      return Promise.all([
        p.collection('trip_docs').getFullList({ filter: f, perPage: 100, requestKey: null }),
        p.collection('trip_members').getFullList({ filter: f, perPage: 100, requestKey: null }),
        p.collection('trip_invites').getFullList({ filter: f, perPage: 100, requestKey: null })
      ]).then(function (all) {
        var docs = docMap(all[0]);
        docs.trip = tripDoc(trip);
        var members = (all[1] || []).map(mapMember);
        var mine = members.filter(function (m) { return ST.user && m.user_id === ST.user.id; })[0] || null;
        var role = (ST.user && trip.owner === ST.user.id) ? 'owner' : (mine ? mine.role : 'member');
        /* pending invitations are only visible to the owner; an invite whose
           address is already a member is already accepted — do not show it twice */
        var emails = {};
        members.forEach(function (m) { if (m.invited_email) emails[m.invited_email.toLowerCase()] = 1; });
        var invites = (all[2] || []).filter(function (r) {
          var e = String(r.invite_email || '').toLowerCase();
          return e && !emails[e];
        }).map(mapInvite);
        ST.roles[trip.id] = role;
        return {
          trip: mapTrip(trip),
          docs: docs,
          members: members.concat(invites),
          role: role,
          /* membership IS read+write in this backend (the rules say so) */
          canEdit: role === 'owner' || role === 'member'
        };
      });
    }, function (e) {
      if (e && e.status === 404) {
        var who = (ST.user && (ST.user.email || ST.user.id)) || 'this account';
        throw err('No trip “' + k + '” is visible to ' + who + '. Either it does not exist, or it has not been ' +
          'shared with that address yet (ask the owner to invite ' + who + ').', 'not_found');
      }
      throw friendly(e);
    });
  });
}

/* --------------------------------------------------- members & invitations */

function invite(tripId, email, role) {
  var to = String(email || '').trim().toLowerCase();
  if (!to || to.indexOf('@') === -1) return Promise.reject(err('That does not look like an email address.', 'bad_request'));
  return pb().then(function (p) {
    return p.collection('trips').getOne(tripId, { requestKey: null }).then(function (trip) {
      if (ST.user && trip.owner !== ST.user.id) {
        throw err('Only the trip owner can invite someone to it — you are a member.', 'auth');
      }
      /* The backend's unique index (trip, invite_email) rejects a duplicate
         with a bare "Failed to create record.", which says nothing useful, so
         check first and say what is actually true. Membership is checked
         before invitations: an accepted invitation row lingers (only the owner
         may delete it), so the member check gives the truer answer. */
      var f = 'trip = ' + quote(tripId);
      return Promise.all([
        p.collection('trip_invites').getFullList({ filter: f, requestKey: null }),
        p.collection('trip_members').getFullList({ filter: f, requestKey: null })
      ]).then(function (both) {
        var member = (both[1] || []).some(function (r) { return String(r.member_email || '').toLowerCase() === to; });
        if (member) throw err(to + ' is already a member of this trip.', 'bad_request');
        var invited = (both[0] || []).some(function (r) { return String(r.invite_email || '').toLowerCase() === to; });
        if (invited) throw err(to + ' has already been invited to this trip.', 'bad_request');
        return p.collection('trip_invites').create({
          trip: tripId,
          invite_email: to,
          /* the backend has exactly one owner per trip; everyone else joins as
             a member, and membership carries read AND write (see DESIGN.md 1.2) */
          role: 'member',
          trip_title: String(trip.title || '').slice(0, 200),
          invited_by: ST.user ? ST.user.id : null
        }, { requestKey: null });
      });
    });
  }).then(mapInvite, function (e) {
    throw friendly(e);
  });
}

/* Removing is one call either way: a member row or a pending invitation.
   Removing a MEMBER also revokes any invitation still on file for that
   address — otherwise the lingering invitation row (which only the owner can
   delete) would let them accept their way back in (§ DESIGN 5). */
function removeMember(entry) {
  var kind = entry && typeof entry === 'object' ? entry.kind : 'member';
  var id = entry && typeof entry === 'object' ? entry.id : entry;
  var email = entry && typeof entry === 'object' ? String(entry.invited_email || '').toLowerCase() : '';
  if (!id) return Promise.reject(err('No member or invitation given.', 'bad_request'));
  var coll = kind === 'invite' ? 'trip_invites' : 'trip_members';
  return pb().then(function (p) {
    return p.collection(coll).delete(id, { requestKey: null }).then(function () {
      if (kind === 'invite' || !email) return true;
      /* best effort: a stray invite must not make the removal useless */
      return p.collection('trip_invites').getFullList({ filter: 'trip = ' + quote(tripIdOfEntry(entry)), requestKey: null })
        .then(function (rows) {
          var stray = (rows || []).filter(function (r) { return String(r.invite_email || '').toLowerCase() === email; });
          return stray.reduce(function (chain, r) {
            return chain.then(function () {
              return p.collection('trip_invites').delete(r.id, { requestKey: null }).then(function () { return true; }, function () { return true; });
            });
          }, Promise.resolve(true));
        }, function () { return true; });
    });
  }).then(function () { return true; }, function (e) { throw friendly(e); });
}
function tripIdOfEntry(entry) {
  return entry && typeof entry === 'object' ? String(entry.trip || '') : '';
}

/* `invite` here is the app's own invite row (see pendingInvites). Accepting is
   POST trip_members by the invitee themselves — the server rule allows that
   only because a pending invitation for their email exists. */
function acceptInvite(inv) {
  if (!inv || !inv.trip) return Promise.reject(err('No invitation given.', 'bad_request'));
  if (!ST.user) return Promise.reject(err('Sign in first.', 'no_session'));
  return pb().then(function (p) {
    return p.collection('trip_members').create({
      trip: inv.trip,
      member: ST.user.id,
      role: 'member',                       /* the rule refuses anything else */
      member_email: ST.user.email || '',
      member_name: ST.user.name || ST.user.email || '',
      member_avatar: ST.user.avatar || ''
    }, { requestKey: null });
  }).then(function (rec) {
    /* the invitation row is the owner's to clean up; the invitee cannot delete it */
    return mapMember(rec);
  }, function (e) {
    var m = msg(e);
    if (e && e.status === 400 && /unique/i.test(m)) {
      return err('You are already a member of that trip.', 'bad_request');
    }
    throw friendly(e);
  });
}

/* The signed-in user's own pending invitations (the trip_invites rule lets
   them read rows addressed to their email, and nothing else). An invitation
   whose trip already has a membership row for me is consumed: accepting does
   not delete it (delete is owner-only), so it is filtered out here rather than
   shown as if it were still open. */
function pendingInvites() {
  if (!ST.user || !ST.user.email) return Promise.resolve([]);
  return pb().then(function (p) {
    return Promise.all([
      p.collection('trip_invites').getFullList({ filter: 'invite_email = ' + quote(ST.user.email), requestKey: null }),
      p.collection('trip_members').getFullList({ filter: 'member = ' + quote(ST.user.id), requestKey: null })
    ]).then(function (both) {
      var mine = {};
      (both[1] || []).forEach(function (m) { mine[m.trip] = 1; });
      return (both[0] || []).filter(function (r) { return !mine[r.trip]; }).map(mapInvite);
    });
  }, function (e) { throw friendly(e); });
}
/* Accepting does not delete the invitation (delete is owner-only), so the
   invitation row lingers until the owner clears it; the app treats an
   invitation whose address is already a member as consumed and hides it. */

/* -------------------------------------------------------------- documents */

/* Write one section document. Create when the row is missing, replace the
   whole `data` when it exists (a full-document write, as the document shape
   is the app's own file). */
function writeSection(p, tripId, section, data) {
  return p.collection('trip_docs').getFirstListItem('trip = ' + quote(tripId) + ' && section = ' + quote(section), { requestKey: null })
    .then(function (rec) {
      return p.collection('trip_docs').update(rec.id, { data: data, schema_version: 1 }, { requestKey: null });
    }, function (e) {
      if (!e || e.status !== 404) throw e;
      return p.collection('trip_docs').create({ trip: tripId, section: section, data: data, schema_version: 1 }, { requestKey: null });
    });
}

function saveDocs(tripId, docs) {
  if (!tripId) return Promise.reject(err('No trip given.', 'bad_request'));
  var wanted = SECTIONS.filter(function (n) { return docs && docs[n] !== undefined && docs[n] !== null; });
  var hasMeta = !!(docs && docs.trip !== undefined && docs.trip !== null);
  if (!wanted.length && !hasMeta) return Promise.reject(err('Nothing to write — no sections are loaded.', 'bad_request'));
  return pb().then(function (p) {
    var chain = Promise.resolve(0);
    wanted.forEach(function (name) {
      chain = chain.then(function (n) {
        return writeSection(p, tripId, name, docs[name]).then(function () { return n + 1; });
      });
    });
    return chain.then(function (n) {
      if (!hasMeta) return n;
      /* the trip's own fields are columns on the trips record, and the rule
         lets only the OWNER change them */
      var cols = tripColumns(docs.trip);
      if (!Object.keys(cols).length) return n;
      return p.collection('trips').update(tripId, cols, { requestKey: null })
        .then(function () { return n + 1; }, function (e) {
          if (ST.roles[tripId] === 'owner') throw friendly(e);
          return n;     /* a member may write content, not the trip's own details */
        });
    });
  }).then(function (n) { return n; }, function (e) { throw friendly(e); });
}

/* ---------------------------------------------------------------- picks */

/* A decision pick lives inside the decisions section document — the backend
   has no picks collection and this app must not invent one. Read-modify-write
   of the whole document, serialised per trip so two quick taps cannot lose
   each other. */
var writeQ = {};
function queued(tripId, fn) {
  var key = String(tripId || '');
  var prev = writeQ[key] || Promise.resolve();
  var next = prev.then(function () { return fn(); }, function () { return fn(); });
  writeQ[key] = next.then(function () { return null; }, function () { return null; });
  return next;
}
function decisionsList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.decisions)) return data.decisions;
  return null;
}
function picksFrom(data) {
  var out = {};
  var list = decisionsList(data) || [];
  list.forEach(function (d) {
    if (!d || typeof d !== 'object') return;
    var id = d.id == null ? '' : String(d.id);
    if (!id || !d.picked_option_id) return;
    out[id] = {
      option_id: String(d.picked_option_id),
      picked_by: String(d.picked_by || ''),
      at: d.picked_at ? (Date.parse(d.picked_at) || null) : null
    };
  });
  return out;
}
function mutatePick(data, decisionId, optionId, who) {
  var list = decisionsList(data);
  if (!list) return { data: data, found: false, changed: false };
  var want = String(decisionId);
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (!d || typeof d !== 'object' || String(d.id) !== want) continue;
    if (optionId === null || optionId === undefined || optionId === '') {
      if (!d.picked_option_id) return { data: data, found: true, changed: false };
      delete d.picked_option_id; delete d.picked_by; delete d.picked_at;
      return { data: data, found: true, changed: true };
    }
    if (String(d.picked_option_id || '') === String(optionId) && String(d.picked_by || '') === String(who || '')) {
      return { data: data, found: true, changed: false };
    }
    d.picked_option_id = String(optionId);
    d.picked_by = String(who || '');
    d.picked_at = new Date().toISOString();
    return { data: data, found: true, changed: true };
  }
  return { data: data, found: false, changed: false };
}
function loadDecisionsDoc(p, tripId) {
  return p.collection('trip_docs')
    .getFirstListItem('trip = ' + quote(tripId) + ' && section = "decisions"', { requestKey: null })
    .then(function (rec) { return rec; }, function (e) {
      if (e && e.status === 404) return null;
      throw e;
    });
}
function writeDecisions(p, tripId, data, existing) {
  if (existing) return p.collection('trip_docs').update(existing.id, { data: data, schema_version: 1 }, { requestKey: null });
  return p.collection('trip_docs').create({ trip: tripId, section: 'decisions', data: data, schema_version: 1 }, { requestKey: null });
}
var NO_DOC = 'That trip has no decisions document in the backend yet, so there is nothing to record a choice against. ' +
             'Open Share → “Import this page’s data into the trip” once, then pick again.';

function loadPicks(tripId) {
  if (!tripId) return Promise.resolve({});
  return pb().then(function (p) { return loadDecisionsDoc(p, tripId); })
    .then(function (rec) { return rec ? picksFrom(rec.data) : {}; }, function (e) { throw friendly(e); });
}
/* `seed` is the app's own decisions document, used to create the row the first
   time somebody picks on a trip whose decisions were never imported. */
function savePick(tripId, decisionId, optionId, seed) {
  if (!tripId) return Promise.reject(err('No trip given.', 'bad_request'));
  var who = (ST.user && (ST.user.email || ST.user.name)) || 'a member';
  return queued(tripId, function () {
    return pb().then(function (p) {
      return loadDecisionsDoc(p, tripId).then(function (rec) {
        var source = rec ? copyJson(rec.data) : (seed == null ? null : copyJson(seed));
        if (source == null) throw err(NO_DOC, 'not_found');
        var res = mutatePick(source, decisionId, optionId, who);
        if (!res.found) {
          throw err('The backend’s decisions document has no decision “' + decisionId + '”, so the choice was not saved.',
            'not_found');
        }
        if (!res.changed) return { ok: true, changed: false };
        return writeDecisions(p, tripId, res.data, rec).then(function () { return { ok: true, changed: true }; });
      });
    });
  }).then(function (r) { return r; }, function (e) { throw friendly(e); });
}
function clearPicks(tripId) {
  if (!tripId) return Promise.resolve(false);
  return queued(tripId, function () {
    return pb().then(function (p) {
      return loadDecisionsDoc(p, tripId).then(function (rec) {
        if (!rec) return false;
        var data = copyJson(rec.data);
        var list = decisionsList(data) || [];
        var changed = false;
        list.forEach(function (d) {
          if (d && typeof d === 'object' && d.picked_option_id) {
            delete d.picked_option_id; delete d.picked_by; delete d.picked_at;
            changed = true;
          }
        });
        if (!changed) return false;
        return writeDecisions(p, tripId, data, rec).then(function () { return true; });
      });
    });
  }).then(function (r) { return r; }, function (e) { throw friendly(e); });
}

/* ---------------------------------------------------------------- share */

function shareLink(slug) {
  return global.location.origin + global.location.pathname + '#trip=' + encodeURIComponent(String(slug || ''));
}

/* ------------------------------------------------------------------ export */

global.TripBackends = global.TripBackends || {};
global.TripBackends.pocketbase = {
  id: 'pocketbase',
  label: 'PocketBase',
  isConfigured: isConfigured,
  init: init,
  status: status,
  onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); if (ST.ready) fn(status()); } },
  refresh: function () {                     /* re-probe "is Google configured?" */
    if (!isConfigured()) return Promise.resolve(status());
    return probeAuthMethods().then(function (m) { setOauthFrom(m); ST.error = ''; emit(); return status(); },
      function (e) { ST.error = msg(wireError(e)); emit(); return status(); });
  },
  signIn: signIn,
  signOut: signOut,
  listTrips: listTrips,
  openTrip: openTrip,
  pendingInvites: pendingInvites,
  acceptInvite: acceptInvite,
  invite: invite,
  removeMember: removeMember,
  saveDocs: saveDocs,
  loadPicks: loadPicks,
  savePick: savePick,
  clearPicks: clearPicks,
  shareLink: shareLink,
  docNames: DOC_NAMES
};

})(window);

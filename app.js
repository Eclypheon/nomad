/* ==========================================================================
   Trip app — plain JS, no framework, no build step.
   Reads data/*.json (relative paths only) and keeps local state in
   localStorage. Nothing leaves the device unless a backend is configured in
   pocketbase-config.js and you sign in — see auth.js + backends/.
   ========================================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------------- helpers */

var FILES = ['trip', 'itinerary', 'accommodation', 'expenses', 'packing', 'recommendations', 'decisions'];
var TABS  = ['itinerary', 'accommodation', 'expenses', 'packing', 'recommendations', 'decisions', 'share'];
var REC_STATUSES = ['idea', 'shortlisted', 'planned'];

var LS = {
  actuals:   'vt.actuals.v1',
  packing:   'vt.packing.v1',
  recs:      'vt.recs.v1',
  recstatus: 'vt.recstatus.v1',
  cache:     'vt.cache.v1',
  decisions: 'vt.decisions.v1',
  trip:      'vt.trip.v1'
};

var DATA = {};        /* parsed data files, keyed by file name            */
var LOAD_ERR = {};    /* file name -> parse error message                 */
var MISSING = {};     /* file name -> true when absent / empty            */
var BLOCKED = false;  /* browser refused to read local files (file://)     */
var CACHE_NOTE = '';  /* non-error notice shown in the header             */

/* decisions: the option the user has picked, per decision id.
   { 'dec-nye': {option_id:'opt-y', picked_by:'someone@example.com', at: 1791…} } */
var PICKS = {};
var PICKS_CLOUD = false;   /* true once picks live in a shared trip's rows  */
var DIRTY = {};            /* tab name -> needs re-render before showing    */
var RENDERERS = {};        /* tab name -> its render function (filled in init) */
var REPO = {};             /* the data/*.json copy, kept so a shared trip's
                              documents can be dropped again on sign-out    */

/* account / sharing — app.js only ever talks to auth.js (the backend facade);
   with no adapter configured this is all inert and the page stays local      */
var AUTH = {
  ready: false,
  configured: false,
  error: '',
  user: null,
  trip: null,       /* {id, slug, name, currency, travellers} when shared  */
  role: '',         /* owner | member — membership IS read+write here     */
  canEdit: false,
  members: [],      /* members AND pending invitations (kind: member/invite) */
  trips: null,      /* null = not loaded, [] = loaded empty                */
  invites: null,    /* null = not loaded; my own pending invitations        */
  busy: false,
  msg: null,        /* {kind:'good'|'bad', text:''} shown on the Share tab */
  oauth: { checked: false, ready: false, offline: false, message: '' }
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function ce(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null && text !== '') n.textContent = String(text);
  return n;
}
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
function txt(v) { return v == null ? '' : String(v); }
function has(v) { return v != null && String(v).trim() !== ''; }

/* number, or null when the value isn't cleanly numeric (never guess) */
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null) return null;
  var s = String(v).trim();
  if (!s) return null;
  s = s.replace(/^[^\d\-+]+/, '').replace(/,/g, '');
  if (!/^[+-]?\d*\.?\d+$/.test(s)) return null;
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function money(n, cur) {
  if (n == null) return '';
  var s;
  try { s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n); }
  catch (e) { s = String(Math.round(n * 100) / 100); }
  return cur ? cur + ' ' + s : s;
}
function sum(list) {
  var t = 0, any = false;
  list.forEach(function (v) { var n = num(v); if (n != null) { t += n; any = true; } });
  return any ? t : null;
}
/* "+USD 20" / "-USD 5" / "USD 0" — sign in front so it reads as a delta */
function fmtVariance(v, cur) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '-' : '')) + money(Math.abs(v), cur);
}

function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v).trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(d, long) {
  if (!d) return '';
  try {
    return d.toLocaleDateString(undefined, long
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
      : { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (e) { return d.toDateString(); }
}
function iso(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function daysBetween(a, b) {
  var MS = 86400000;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
                     Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / MS);
}
function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/* pull the first array found under any of the given keys */
function asArray(v, keys) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (var i = 0; i < keys.length; i++) if (Array.isArray(v[keys[i]])) return v[keys[i]];
  }
  return [];
}
function pick(o, keys) {
  if (!o || typeof o !== 'object') return undefined;
  for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]];
  return undefined;
}
function firstString(o, keys) {
  var v = pick(o, keys);
  if (v == null) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}
function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') {
    var s = v.trim().toLowerCase();
    return s && s !== 'false' && s !== 'no' && s !== '0' && s !== 'none';
  }
  if (typeof v === 'number') return v > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}
function isBuyFlag(o) {
  if (!o || typeof o !== 'object') return false;
  var keys = ['buy', 'to_buy', 'tobuy', 'needs_buy', 'need_buy', 'pre_departure',
              'before_departure', 'to_arrange', 'arrange', 'buy_before', 'todo'];
  for (var i = 0; i < keys.length; i++) if (truthy(o[keys[i]])) return true;
  var tags = o.tags || o.tag;
  if (Array.isArray(tags)) {
    return tags.some(function (t) { return /buy|arrang|purchase|before departure|todo/i.test(String(t)); });
  }
  if (typeof tags === 'string' && /buy|arrang|purchase/i.test(tags)) return true;
  return false;
}

/* ---------------------------------------------------------------- storage */

function lsGet(key, fallback) {
  try {
    var v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
}
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

/* ------------------------------------------------------------------ input */

function fetchText(url) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    function ok(t) { if (!settled) { settled = true; resolve(t); } }
    function no(msg) { if (!settled) { settled = true; reject(new Error(msg)); } }
    function viaXHR() {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.onload = function () {
          if (x.status >= 400) return no('HTTP ' + x.status);
          if (!x.responseText) return no('empty response');
          ok(x.responseText);
        };
        x.onerror = function () { no('unreadable'); };
        x.send();
      } catch (e) { no(e && e.message ? e.message : 'unreadable'); }
    }
    if (typeof fetch === 'function') {
      fetch(url, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(ok, viaXHR);
    } else viaXHR();
  });
}

function loadAll() {
  return Promise.all(FILES.map(function (name) {
    return fetchText('data/' + name + '.json').then(function (t) {
      if (!t || !t.trim()) return { name: name, missing: true };
      try { return { name: name, data: JSON.parse(t) }; }
      catch (e) {
        return { name: name, error: 'not valid JSON (' + e.message + ')' };
      }
    }, function () { return { name: name, missing: true }; });
  })).then(function (results) {
    var found = 0;
    results.forEach(function (r) {
      if (r.error) LOAD_ERR[r.name] = r.error;
      else if (r.data === undefined) MISSING[r.name] = true;
      else { DATA[r.name] = r.data; found++; }
    });
    if (found) saveCache();

    BLOCKED = (found === 0) && location.protocol === 'file:';
    if (found === 0) applyCache();
  });
}

function saveCache() {
  var files = {};
  FILES.forEach(function (n) { if (DATA[n] !== undefined) files[n] = DATA[n]; });
  lsSet(LS.cache, { saved: Date.now(), files: files });
}
function applyCache() {
  var c = lsGet(LS.cache, null);
  if (!c || !c.files) return false;
  var got = 0;
  FILES.forEach(function (n) {
    if (DATA[n] === undefined && c.files[n] !== undefined) { DATA[n] = c.files[n]; delete MISSING[n]; got++; }
  });
  if (got) CACHE_NOTE = 'Showing the copy saved in this browser on ' +
      fmtDate(new Date(c.saved), true) + ' — load the files again to refresh.';
  return got > 0;
}

/* ------------------------------------------------------------- normalising */

function normDays() {
  return asArray(DATA.itinerary, ['days', 'itinerary', 'itineraries'])
    .map(function (d, i) {
      if (d == null) return null;
      if (typeof d !== 'object') return { title: String(d), index: i };
      d.__i = i;
      return d;
    })
    .filter(Boolean);
}
function normStays() {
  return asArray(DATA.accommodation, ['stays', 'accommodation', 'items', 'bookings', 'hotels'])
    .filter(function (s) { return s && typeof s === 'object'; });
}
function normExpenses() {
  var e = DATA.expenses;
  var cur = (e && typeof e === 'object' && typeof e.currency === 'string') ? e.currency : '';
  function row(r) {
    if (!r || typeof r !== 'object') return null;
    var raw = pick(r, ['amount', 'cost', 'price', 'total']);
    return {
      category: firstString(r, ['category', 'type', 'kind']) || 'Uncategorised',
      item: firstString(r, ['item', 'what', 'name', 'title', 'label', 'description', 'notes']),
      notes: firstString(r, ['notes', 'note', 'comment']),
      amount: num(raw),
      amountRaw: raw
    };
  }
  return {
    currency: cur,
    planned: asArray(e, ['planned', 'expenses', 'items', 'plan']).map(row).filter(Boolean),
    repoActuals: asArray(e, ['actuals', 'actual', 'spent']).map(function (r) {
      if (!r || typeof r !== 'object') return null;
      return {
        id: 'repo-' + (r.id != null ? r.id : Math.random().toString(36).slice(2, 8)),
        fromFile: true,
        date: firstString(r, ['date', 'when']),
        category: firstString(r, ['category', 'type', 'kind']) || 'Uncategorised',
        item: firstString(r, ['item', 'what', 'name', 'title', 'label', 'description']),
        notes: firstString(r, ['notes', 'note', 'comment']),
        currency: firstString(r, ['currency', 'cur']) || cur,
        amount: num(pick(r, ['amount', 'cost', 'price', 'total']))
      };
    }).filter(Boolean)
  };
}
function normPacking() {
  var raw = DATA.packing;
  var cats = asArray(raw, ['categories', 'groups', 'sections']);
  var out = [];
  function itemOf(v) {
    if (v == null) return null;
    if (typeof v === 'string') return { label: v, buy: false, notes: '' };
    if (typeof v !== 'object') return { label: String(v), buy: false, notes: '' };
    var label = firstString(v, ['item', 'name', 'label', 'title', 'what']);
    if (!label) return null;
    return { label: label, buy: isBuyFlag(v), notes: firstString(v, ['notes', 'note', 'comment', 'why']) };
  }
  if (cats.length) {
    cats.forEach(function (c) {
      if (c == null) return;
      if (typeof c === 'string') { out.push({ name: c, items: [] }); return; }
      var items = asArray(c, ['items', 'list', 'things']).map(itemOf).filter(Boolean);
      out.push({ name: firstString(c, ['name', 'category', 'group', 'title']) || 'Packing', items: items });
    });
  } else {
    var flat = asArray(raw, ['items', 'packing', 'list']);
    flat.forEach(function (v) {
      var it = itemOf(v);
      if (!it) return;
      var cat = (v && typeof v === 'object' ? firstString(v, ['category', 'group', 'section']) : '') || 'Packing';
      var bucket = out.filter(function (c) { return c.name === cat; })[0];
      if (!bucket) { bucket = { name: cat, items: [] }; out.push(bucket); }
      bucket.items.push(it);
    });
  }
  return out.filter(function (c) { return c.items.length; });
}
function normRecs() {
  var list = asArray(DATA.recommendations, ['recommendations', 'items', 'recs', 'ideas'])
    .map(function (r) { return normalizeRec(r, false, 0); })
    .filter(Boolean);
  return list;
}
function recKey(r) { return (r.name || '') + '\u0000' + (r.area || ''); }
function normalizeRec(o, local, i) {
  if (o == null) return null;
  if (typeof o === 'string') o = { name: o };
  if (typeof o !== 'object' || Array.isArray(o)) return null;
  var name = firstString(o, ['name', 'title', 'what', 'place']);
  if (!name) return null;
  var status = firstString(o, ['status', 'state']).toLowerCase().trim();
  if (REC_STATUSES.indexOf(status) === -1) status = '';
  return {
    name: name,
    area: firstString(o, ['area', 'city', 'town', 'location', 'where']),
    category: firstString(o, ['category', 'type', 'kind', 'tag']),
    why: firstString(o, ['why', 'reason', 'notes_why', 'description', 'desc']),
    cost: firstString(o, ['cost', 'cost_estimate', 'price', 'budget']),
    source: firstString(o, ['source', 'link', 'url', 'source_url', 'ref']),
    notes: firstString(o, ['notes', 'note', 'comment']),
    by: firstString(o, ['added_by', 'by', 'who']),
    added: firstString(o, ['added_at', 'added', 'date_added']),
    status: status,
    local: !!local,
    key: recKey({ name: name, area: firstString(o, ['area', 'city', 'town', 'location', 'where']) })
  };
}
function allRecs() {
  var local = lsGet(LS.recs, []);
  local = Array.isArray(local) ? local.map(function (r) { return normalizeRec(r, true, 0); }).filter(Boolean) : [];
  return normRecs().concat(local);
}
function recStatus(r) {
  var over = lsGet(LS.recstatus, {}) || {};
  var s = over[r.key];
  if (REC_STATUSES.indexOf(s) !== -1) return s;
  return r.status || 'idea';
}
function localActuals() {
  var a = lsGet(LS.actuals, []);
  if (!Array.isArray(a)) return [];
  return a.filter(function (r) { return r && typeof r === 'object'; });
}
function allActuals() { return normExpenses().repoActuals.concat(localActuals()); }

/* -------------------------------------------------------------- rendering */

function content(name) {
  var sec = document.getElementById('tab-' + name);
  return sec ? sec.querySelector('[data-content]') : null;
}
function errBanner(name) {
  if (!LOAD_ERR[name]) return null;
  var d = ce('div', 'alert err');
  d.textContent = 'Could not read data/' + name + '.json — ' + LOAD_ERR[name] +
    '. Fix the file (a missing comma or quote is the usual cause) or the tab stays empty.';
  return d;
}
function emptyState(msg, path) {
  var d = ce('div', 'empty');
  d.appendChild(ce('div', null, msg));
  if (path) {
    var line = ce('div');
    line.appendChild(ce('code', null, path));
    d.appendChild(line);
  }
  return d;
}
function flash(btn, msg) {
  if (!btn) return;
  var old = btn.getAttribute('data-label') || btn.textContent;
  btn.setAttribute('data-label', old);
  btn.textContent = msg;
  setTimeout(function () { btn.textContent = btn.getAttribute('data-label'); }, 1400);
}
function copyFrom(source, btn) {
  var ta = (typeof source === 'string') ? null : source;
  var text = (typeof source === 'string') ? source : ta.value;
  if (ta) {
    var ok = false;
    try { ta.focus(); ta.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (ok) { flash(btn, 'Copied'); return; }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { flash(btn, 'Copied'); },
      function () { flash(btn, 'Select & copy'); });
  } else flash(btn, 'Select & copy');
}
function link(url, label, cls) {
  var a = ce('a', cls || 'btn ghost tiny', label);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
function isUrl(s) { return /^https?:\/\//i.test(txt(s)); }
function mapUrl(q) { return 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(q); }

/* ------------------------------------------------------------------ header */

function renderHeader() {
  var t = (DATA.trip && typeof DATA.trip === 'object' && !Array.isArray(DATA.trip)) ? DATA.trip : {};
  var days = normDays().map(function (d) { return parseDate(pick(d, ['date', 'day_date', 'when'])); }).filter(Boolean);
  var start = parseDate(pick(t, ['start', 'start_date', 'from', 'dates_from'])) ||
              (days.length ? new Date(Math.min.apply(null, days)) : null);
  var end = parseDate(pick(t, ['end', 'end_date', 'to', 'dates_to'])) ||
            (days.length ? new Date(Math.max.apply(null, days)) : null);

  var title = firstString(t, ['title', 'name', 'trip']) || 'Vietnam trip';
  document.title = title;
  $('#hd-title').textContent = title;

  var dates = '';
  if (start && end) dates = fmtDate(start, true) + ' → ' + fmtDate(end, true);
  else if (start) dates = 'from ' + fmtDate(start, true);
  $('#hd-dates').textContent = dates;

  var facts = [];
  function fact(text) {
    var s = ce('span', 'fact');
    s.appendChild(document.createTextNode(text));
    facts.push(s);
  }

  var dayCount = num(pick(t, ['days', 'day_count', 'nights_days']));
  if (dayCount == null && start && end) dayCount = daysBetween(start, end) + 1;
  if (dayCount == null && normDays().length) dayCount = normDays().length;
  if (dayCount != null) {
    var nights = (start && end) ? daysBetween(start, end) : dayCount - 1;
    fact(dayCount + (dayCount === 1 ? ' day' : ' days') +
      (nights > 0 ? ' · ' + nights + (nights === 1 ? ' night' : ' nights') : ''));
  }

  var bases = pick(t, ['bases', 'base', 'cities']);
  if (typeof bases === 'string') bases = bases.split(/[,·|]/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!Array.isArray(bases) || !bases.length) {
    var seen = {}, list = [];
    normDays().forEach(function (d) {
      var b = firstString(d, ['base', 'city', 'location', 'where']);
      if (b && !seen[b.toLowerCase()]) { seen[b.toLowerCase()] = 1; list.push(b); }
    });
    bases = list;
  }
  if (Array.isArray(bases) && bases.length) fact('bases: ' + bases.join(' · '));

  if (start) {
    var t0 = today();
    var dStart = daysBetween(t0, start), dEnd = end ? daysBetween(t0, end) : 0;
    if (dStart > 0) fact(dStart + (dStart === 1 ? ' day' : ' days') + ' to go');
    else if (dEnd >= 0) fact('day ' + (daysBetween(start, t0) + 1) + ' of the trip');
    else fact('trip finished');
  }

  var fw = $('#hd-facts');
  clear(fw);
  facts.forEach(function (f) { fw.appendChild(f); });

  /* budget vs spend */
  var exp = normExpenses();
  var cur = exp.currency || firstString(t, ['currency', 'cur']);
  var planned = sum(exp.planned.map(function (r) { return r.amount; }));
  var actual = sum(allActuals().map(function (r) { return r.amount; }));
  var budget = num(pick(t, ['budget', 'budget_total', 'spend_budget']));
  var bw = $('#hd-budget');
  clear(bw);
  if (budget == null && planned == null && actual == null) {
    bw.hidden = true;
  } else {
    bw.hidden = false;
    var spent = actual != null ? actual : planned;
    var line = ce('div');
    var bits = [];
    if (budget != null) bits.push('budget ' + money(budget, cur));
    if (planned != null) bits.push('planned ' + money(planned, cur));
    if (actual != null) bits.push('actual ' + money(actual, cur));
    line.textContent = bits.join(' · ');
    bw.appendChild(line);
    if (budget != null && spent != null && budget > 0) {
      var bar = ce('div', 'bar');
      var pct = Math.min(100, Math.round(spent / budget * 100));
      var fill = ce('span', spent > budget ? 'over' : 'spent');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      bw.appendChild(bar);
      bw.appendChild(ce('div', 'small muted', pct + '% of budget' + (spent > budget ? ' — over' : '')));
    }
  }

  /* decisions: the trip-level delta belongs with the other summary numbers */
  var dw = $('#hd-decisions');
  if (dw) {
    clear(dw);
    var dline = decisionsSummaryLine();
    if (!dline) dw.hidden = true;
    else {
      dw.hidden = false;
      var row = ce('div', 'hd-dec');
      row.appendChild(ce('span', 'decsum', dline));
      var jb = ce('button', 'chipbtn', 'Review');
      jb.addEventListener('click', function () {
        showTab('decisions', true); lsSet('vt.tab', 'decisions'); window.scrollTo(0, 0);
      });
      row.appendChild(jb);
      dw.appendChild(row);
    }
  }

  var alert = $('#hd-alert');
  clear(alert);
  var msgs = [];
  if (CACHE_NOTE) msgs.push(CACHE_NOTE);
  if (AUTH.trip) msgs.push('Shared trip \u201c' + (txt(AUTH.trip.name) || txt(AUTH.trip.slug)) + '\u201d \u00b7 you are ' + (AUTH.role || 'a member') + '.');
  if (AUTH.msg && AUTH.msg.kind === 'bad') msgs.push(AUTH.msg.text);
  if (LOAD_ERR.trip) msgs.push('data/trip.json ' + LOAD_ERR.trip + ' — header is showing what it can infer.');
  if (msgs.length) { alert.hidden = false; alert.textContent = msgs.join(' '); }
  else alert.hidden = true;

  renderAuthChip();
}

/* --------------------------------------------------------------- itinerary */

function renderItinerary() {
  var box = content('itinerary');
  clear(box);
  var err = errBanner('itinerary'); if (err) box.appendChild(err);

  var days = normDays();
  if (!days.length) {
    box.appendChild(emptyState(MISSING.itinerary || LOAD_ERR.itinerary
      ? 'No itinerary yet — add days to data/itinerary.json.'
      : 'No days in the itinerary yet.', 'data/itinerary.json'));
    return;
  }

  days.forEach(function (d, i) {
    var card = ce('article', 'card day');
    var head = ce('div', 'dayhead');
    var left = ce('div');
    var dayNo = num(pick(d, ['day', 'day_number', 'n']));
    if (dayNo == null) dayNo = i + 1;
    var dateS = firstString(d, ['date', 'day_date', 'when']);
    var dt = parseDate(dateS);
    d.__n = dayNo;
    /* anchor + date, so the Decisions tab can jump straight here */
    card.id = 'day-' + dayNo;
    card.setAttribute('data-day', dayNo);
    if (dateS) card.setAttribute('data-date', dateS);
    left.appendChild(ce('div', 'daynum', 'Day ' + dayNo +
      (dt ? ' · ' + fmtDate(dt) : (dateS ? ' · ' + dateS : ''))));
    var base = firstString(d, ['base', 'city', 'location', 'where']);
    var title = firstString(d, ['title', 'name', 'summary']);
    var sub = [base, title].filter(Boolean).join(' — ');
    if (sub) left.appendChild(ce('div', 'daysub', sub));
    head.appendChild(left);
    var cost = dayCost(d);
    if (cost != null && cost > 0) head.appendChild(ce('span', 'badge', '~' + money(cost, tripCurrency())));
    card.appendChild(head);

    var items = asArray(d, ['items', 'schedule', 'plan', 'activities']);
    if (items.length) {
      var ul = ce('ul', 'items');
      items.forEach(function (it) {
        var li = ce('li');
        var o = (it && typeof it === 'object') ? it : { what: it };
        li.appendChild(ce('div', 't', firstString(o, ['time', 'at', 'when'])));
        var w = ce('div', 'w');
        w.appendChild(ce('div', null, firstString(o, ['what', 'title', 'name', 'item', 'activity']) || txt(it)));
        var notes = firstString(o, ['notes', 'note', 'comment', 'detail']);
        if (notes) w.appendChild(ce('div', 'n', notes));
        li.appendChild(w);
        var c = pick(o, ['cost', 'price', 'amount']);
        li.appendChild(ce('div', 'c', c == null || c === '' ? '' : money(num(c) == null ? c : num(c), tripCurrency())));
        ul.appendChild(li);
      });
      card.appendChild(ul);
    } else {
      card.appendChild(ce('div', 'muted small', 'No items listed for this day.'));
    }

    var meta = ce('div', 'daymeta');
    var transit = firstString(d, ['transit', 'transport', 'travel', 'getting_there']);
    var lodging = firstString(d, ['lodging', 'accommodation', 'stay', 'sleep', 'hotel']);
    if (transit) { var a = ce('div'); a.appendChild(ce('b', null, 'Transit: ')); a.appendChild(document.createTextNode(transit)); meta.appendChild(a); }
    if (lodging) { var b = ce('div'); b.appendChild(ce('b', null, 'Lodging: ')); b.appendChild(document.createTextNode(lodging)); meta.appendChild(b); }
    if (cost != null && cost > 0) {
      var c2 = ce('div');
      c2.appendChild(ce('b', null, 'Day cost'));
      c2.appendChild(document.createTextNode(' ~' + money(cost, tripCurrency())));
      meta.appendChild(c2);
    }
    if (meta.childNodes.length) card.appendChild(meta);
    box.appendChild(card);
  });
}
function tripCurrency() {
  var e = DATA.expenses, t = DATA.trip;
  if (e && typeof e === 'object' && has(e.currency)) return String(e.currency);
  if (t && typeof t === 'object' && has(t.currency)) return String(t.currency);
  return '';
}
function dayCost(d) {
  var v = pick(d, ['day_cost', 'dayCost', 'cost', 'cost_estimate', 'estimated_cost']);
  var n = num(v);
  if (n != null) return n;
  var items = asArray(d, ['items', 'schedule', 'plan', 'activities']);
  var vals = items.map(function (it) {
    return (it && typeof it === 'object') ? pick(it, ['cost', 'price', 'amount']) : null;
  });
  return sum(vals);
}

/* ----------------------------------------------------------- accommodation */

function renderAccommodation() {
  var box = content('accommodation');
  clear(box);
  var err = errBanner('accommodation'); if (err) box.appendChild(err);

  var stays = normStays();
  if (!stays.length) {
    box.appendChild(emptyState('No accommodation added yet.', 'data/accommodation.json'));
    return;
  }
  var totals = {};   /* currency -> { all, booked } — never sum across currencies */
  var rows = [];
  function addTotal(cur, booked, v) {
    var t = totals[cur] = totals[cur] || { all: 0, booked: 0 };
    t.all += v;
    if (booked) t.booked += v;
  }

  stays.forEach(function (s) {
    var cur = firstString(s, ['currency', 'cur']) || tripCurrency();
    var card = ce('article', 'card');
    var head = ce('div', 'row');
    var h = ce('h3', null, firstString(s, ['name', 'title', 'hotel', 'place']) || 'Accommodation');
    head.appendChild(h);
    var status = firstString(s, ['status', 'state']).toLowerCase();
    if (status) head.appendChild(ce('span', 'badge ' + status.replace(/[^a-z]/g, ''), status));
    card.appendChild(head);

    var area = firstString(s, ['area', 'city', 'location', 'where', 'base']);
    var nights = num(pick(s, ['nights', 'nights_count', 'n']));
    var pn = num(pick(s, ['price_per_night', 'pricePerNight', 'nightly', 'per_night', 'price']));
    var cin = firstString(s, ['check_in', 'checkin', 'from']);
    var cout = firstString(s, ['check_out', 'checkout', 'to']);
    var line = [];
    if (area) line.push(area);
    if (cin || cout) {
      var cd1 = parseDate(cin), cd2 = parseDate(cout);
      line.push([cd1 ? fmtDate(cd1) : cin, cd2 ? fmtDate(cd2) : cout].filter(Boolean).join(' → '));
    }
    if (nights != null) line.push(nights + (nights === 1 ? ' night' : ' nights'));
    if (pn != null) line.push(money(pn, cur) + '/night');
    if (line.length) card.appendChild(ce('div', 'muted', line.join(' · ')));

    var total = (nights != null && pn != null) ? nights * pn : null;
    if (total != null) {
      card.appendChild(ce('div', null, 'Total ' + money(total, cur)));
      addTotal(cur, /book/.test(status), total);
      rows.push({ name: firstString(s, ['name', 'title', 'hotel', 'place']), total: total, status: status, currency: cur });
    }

    var notes = firstString(s, ['notes', 'note', 'comment']);
    if (notes) card.appendChild(ce('p', 'muted small', notes));

    var actions = ce('div', 'actions');
    var url = firstString(s, ['link', 'url', 'booking', 'source', 'website']);
    if (isUrl(url)) actions.appendChild(link(url, 'Listing'));
    if (area) actions.appendChild(link(mapUrl(area + ' Vietnam'), 'Map'));
    if (actions.childNodes.length) card.appendChild(actions);

    box.appendChild(card);
  });

  var foot = ce('div', 'card');
  foot.appendChild(ce('h3', null, 'Accommodation total'));
  var tkeys = Object.keys(totals).filter(function (k) { return totals[k] && totals[k].all != null; });
  if (!tkeys.length) {
    foot.appendChild(ce('div', 'muted', 'No prices given yet, so there is no total to show.'));
  } else {
    tkeys.forEach(function (k) {
      var t = totals[k];
      foot.appendChild(ce('div', null, (tkeys.length > 1 ? (k || 'no currency') + ': ' : 'All stays: ') + money(t.all, k)));
      if (t.booked > 0) foot.appendChild(ce('div', 'muted', 'Booked so far: ' + money(t.booked, k)));
      if (tkeys.length === 1 && t.all - t.booked > 0) {
        foot.appendChild(ce('div', 'muted', 'Still wishlist: ' + money(t.all - t.booked, k)));
      }
    });
    if (tkeys.length > 1) foot.appendChild(ce('div', 'muted small', 'Mixed currencies — listed per currency rather than summed.'));
  }
  box.appendChild(foot);
}

/* --------------------------------------------------------------- expenses */

function expenseCategories() {
  var exp = normExpenses(), seen = {}, out = [];
  exp.planned.concat(allActuals()).forEach(function (r) {
    var c = r.category || 'Uncategorised';
    if (!seen[c.toLowerCase()]) { seen[c.toLowerCase()] = 1; out.push(c); }
  });
  return out;
}
function renderExpenses() {
  var box = content('expenses');
  clear(box);
  var err = errBanner('expenses'); if (err) box.appendChild(err);

  var exp = normExpenses();
  var cur = exp.currency;
  var actuals = allActuals();
  var planned = exp.planned;

  if (!planned.length && !actuals.length && !MISSING.expenses) {
    box.appendChild(emptyState('No expenses recorded yet.', 'data/expenses.json'));
    return;
  }

  /* ---- per-category totals ---- */
  var cats = expenseCategories();
  var table = ce('table', 'totals');
  var thead = ce('thead');
  var hr = ce('tr');
  ['Category', 'Planned', 'Actual', 'Variance'].forEach(function (h, i) {
    hr.appendChild(ce('th', i ? 'num' : '', h));
  });
  thead.appendChild(hr); table.appendChild(thead);
  var tb = ce('tbody');
  var totP = 0, totA = 0, anyP = false, anyA = false;
  cats.forEach(function (c) {
    var p = sum(planned.filter(function (r) { return (r.category || '').toLowerCase() === c.toLowerCase(); }).map(function (r) { return r.amount; }));
    var a = sum(actuals.filter(function (r) { return (r.category || '').toLowerCase() === c.toLowerCase(); }).map(function (r) { return r.amount; }));
    if (p != null) { totP += p; anyP = true; }
    if (a != null) { totA += a; anyA = true; }
    var tr = ce('tr');
    tr.appendChild(ce('td', null, c));
    tr.appendChild(ce('td', 'num', p == null ? '—' : money(p, cur)));
    tr.appendChild(ce('td', 'num', a == null ? '—' : money(a, cur)));
    var v = (p != null && a != null) ? a - p : null;
    var vc = ce('td', 'num' + (v == null ? '' : (v > 0 ? ' bad' : ' good')), fmtVariance(v, cur));
    tr.appendChild(vc);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  var tf = ce('tfoot');
  var ftr = ce('tr');
  ftr.appendChild(ce('td', null, 'Total'));
  ftr.appendChild(ce('td', 'num', anyP ? money(totP, cur) : '—'));
  ftr.appendChild(ce('td', 'num', anyA ? money(totA, cur) : '—'));
  var tv = (anyP && anyA) ? totA - totP : null;
  ftr.appendChild(ce('td', 'num' + (tv == null ? '' : (tv > 0 ? ' bad' : ' good')), fmtVariance(tv, cur)));
  tf.appendChild(ftr); table.appendChild(tf);

  var sumCard = ce('div', 'card');
  sumCard.appendChild(ce('h3', null, 'Planned vs actual'));
  if (!cats.length) sumCard.appendChild(ce('div', 'muted', 'Nothing to compare yet — add an expense below.'));
  else {
    var wrap = ce('div', 'tablewrap');
    wrap.appendChild(table);
    sumCard.appendChild(wrap);
    if (!actuals.length) sumCard.appendChild(ce('p', 'muted small', 'No actual spend logged yet — the Actual column fills in as you add entries below.'));
  }
  /* the decisions delta sits with the summary numbers, not in its own tab */
  if (anyP) {
    var dnote = decisionsDeltaNote(totP, cur);
    if (dnote) sumCard.appendChild(dnote);
  }
  box.appendChild(sumCard);

  /* ---- add / edit form ---- */
  var form = ce('div', 'card');
  form.appendChild(ce('h3', null, 'Add actual spend'));
  var fid = { value: '' };
  var fgrid = ce('div', 'fgrid two');
  function field(label, input) {
    var l = ce('label', 'fld', label);
    l.appendChild(input);
    fgrid.appendChild(l);
    return input;
  }
  var inDate = document.createElement('input');
  inDate.type = 'date'; inDate.value = iso(today());
  var inCat = document.createElement('input');
  inCat.type = 'text'; inCat.placeholder = 'Food';
  inCat.setAttribute('list', 'catlist');
  var dl = document.createElement('datalist');
  dl.id = 'catlist';
  expenseCategories().forEach(function (c) { var o = document.createElement('option'); o.value = c; dl.appendChild(o); });
  var inItem = document.createElement('input');
  inItem.type = 'text'; inItem.placeholder = 'Dinner at Bun Cha Huong Lien';
  var inAmt = document.createElement('input');
  inAmt.type = 'number'; inAmt.step = '0.01'; inAmt.placeholder = '250000';
  var inCur = document.createElement('input');
  inCur.type = 'text'; inCur.placeholder = 'VND'; inCur.value = cur || '';
  var inNotes = document.createElement('input');
  inNotes.type = 'text'; inNotes.placeholder = 'optional';

  field('Date', inDate);
  field('Category', inCat);
  fgrid.appendChild(dl);
  field('What', inItem);
  field('Amount', inAmt);
  field('Currency', inCur);
  field('Notes', inNotes);
  form.appendChild(fgrid);

  var msg = ce('div', 'small', '');
  var submit = ce('button', 'btn tiny', 'Add entry');
  var cancel = ce('button', 'btn tiny ghost', 'Cancel edit');
  cancel.hidden = true;
  var actions = ce('div', 'actions');
  actions.appendChild(submit); actions.appendChild(cancel);
  form.appendChild(actions);
  form.appendChild(msg);

  function resetForm() {
    cancel.hidden = true;
    submit.textContent = 'Add entry';
    inDate.value = iso(today()); inCat.value = ''; inItem.value = '';
    inAmt.value = ''; inNotes.value = ''; inCur.value = cur || '';
  }
  function save(ev) {
    ev.preventDefault();
    msg.className = 'small';
    var amount = num(inAmt.value);
    if (!inCat.value.trim() && !inItem.value.trim()) { msg.className = 'small bad'; msg.textContent = 'Give the entry a category or a description.'; return; }
    if (amount == null) { msg.className = 'small bad'; msg.textContent = 'Amount must be a number (e.g. 250000).'; return; }
    var row = {
      id: fid.value || 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: inDate.value || iso(today()),
      category: inCat.value.trim() || 'Uncategorised',
      item: inItem.value.trim(),
      amount: amount,
      currency: inCur.value.trim(),
      notes: inNotes.value.trim()
    };
    var list = localActuals();
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === row.id) at = i;
    if (at >= 0) list[at] = row; else list.push(row);
    if (!lsSet(LS.actuals, list)) { msg.className = 'small bad'; msg.textContent = 'This browser refused to store the entry (private mode?).'; return; }
    renderExpenses(); renderHeader();
  }
  submit.addEventListener('click', save);
  cancel.addEventListener('click', function (ev) { ev.preventDefault(); fid.value = ''; resetForm(); msg.textContent = ''; });
  box.appendChild(form);

  /* stable ids so the form is easy to drive from a test or another tool */
  inDate.id = 'exp-date'; inCat.id = 'exp-cat'; inItem.id = 'exp-item';
  inAmt.id = 'exp-amount'; inCur.id = 'exp-cur'; inNotes.id = 'exp-notes';
  submit.id = 'exp-save'; cancel.id = 'exp-cancel'; msg.id = 'exp-msg';

  /* ---- planned rows ---- */
  var pcard = ce('div', 'card');
  pcard.appendChild(ce('h3', null, 'Planned (from data/expenses.json)'));
  if (!planned.length) pcard.appendChild(ce('div', 'muted', 'No planned expenses in the file yet.'));
  else {
    var ulp = ce('ul', 'rows');
    planned.forEach(function (r) {
      var li = ce('li');
      li.appendChild(ce('div', null, r.item || r.category));
      li.appendChild(ce('div', 'amt', r.amount == null ? txt(r.amountRaw) : money(r.amount, cur)));
      li.appendChild(ce('div', 'meta', [r.category, r.notes].filter(Boolean).join(' · ')));
      ulp.appendChild(li);
    });
    pcard.appendChild(ulp);
  }
  box.appendChild(pcard);

  /* ---- actuals ---- */
  var acard = ce('div', 'card');
  acard.appendChild(ce('h3', null, 'Logged spend'));
  if (!actuals.length) acard.appendChild(ce('div', 'muted', 'Nothing logged yet. Entries you add here live only in this browser until you export them.'));
  else {
    var ula = ce('ul', 'rows');
    actuals.slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })
      .forEach(function (r) {
        var li = ce('li');
        li.appendChild(ce('div', null, r.item || r.category));
        li.appendChild(ce('div', 'amt', r.amount == null ? '—' : money(r.amount, r.currency || cur)));
        li.appendChild(ce('div', 'meta', [r.date, r.category, r.notes, r.fromFile ? 'from data/expenses.json' : ''].filter(Boolean).join(' · ')));
        if (!r.fromFile) {
          var tools = ce('div', 'tools');
          var eb = ce('button', 'btn ghost tiny', 'Edit');
          eb.addEventListener('click', function () {
            fid.value = r.id;
            inDate.value = r.date || ''; inCat.value = r.category || '';
            inItem.value = r.item || ''; inAmt.value = r.amount == null ? '' : r.amount;
            inCur.value = r.currency || '';
            inNotes.value = r.notes || '';
            submit.textContent = 'Save changes';
            cancel.hidden = false;
            form.scrollIntoView({ block: 'center' });
          });
          var db = ce('button', 'btn danger tiny', 'Delete');
          db.addEventListener('click', function () {
            if (db.getAttribute('data-armed') !== '1') {
              db.setAttribute('data-armed', '1');
              db.textContent = 'Tap again to delete';
              setTimeout(function () { db.setAttribute('data-armed', '0'); db.textContent = 'Delete'; }, 3000);
              return;
            }
            var list = localActuals().filter(function (x) { return x.id !== r.id; });
            lsSet(LS.actuals, list);
            renderExpenses(); renderHeader();
          });
          tools.appendChild(eb); tools.appendChild(db);
          li.appendChild(tools);
        }
        ula.appendChild(li);
      });
    acard.appendChild(ula);
  }

  /* export / import */
  var io = ce('div', 'actions');
  var expBtn = ce('button', 'btn tiny', 'Export JSON');
  var copyBtn = ce('button', 'btn ghost tiny', 'Copy JSON');
  var impBtn = ce('button', 'btn ghost tiny', 'Import JSON…');
  var clrBtn = ce('button', 'btn danger tiny', 'Clear local entries');
  io.appendChild(expBtn); io.appendChild(copyBtn); io.appendChild(impBtn); io.appendChild(clrBtn);
  acard.appendChild(io);
  acard.appendChild(ce('p', 'muted small', 'Export gives you the whole expenses.json (planned rows + everything you logged) — hand it to whoever owns the repo to commit it, or import it on another device.'));

  var ioPanel = ce('div', 'stack');
  ioPanel.hidden = true;
  var ta = document.createElement('textarea');
  ta.placeholder = 'Paste expenses JSON here (an array of entries, {"actuals": [...]}, or a whole expenses.json)';
  var impMsg = ce('div', 'small', '');
  var doImport = ce('button', 'btn tiny', 'Import');
  var fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.hidden = true;
  var fileLabel = ce('label', 'btn ghost tiny', 'Choose a file');
  fileLabel.setAttribute('for', fileInput.id = 'exp-import-file');
  var iActions = ce('div', 'actions');
  iActions.appendChild(doImport); iActions.appendChild(fileLabel); iActions.appendChild(fileInput);
  ioPanel.appendChild(ta); ioPanel.appendChild(iActions); ioPanel.appendChild(impMsg);
  acard.appendChild(ioPanel);

  function exportObj() {
    var rawPlanned = asArray(DATA.expenses, ['planned', 'expenses', 'items', 'plan']);
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      currency: cur,
      /* keep the file's own planned rows verbatim when there are any, so nothing is lost */
      planned: rawPlanned.length ? rawPlanned : planned.map(function (r) {
        return { category: r.category, item: r.item, amount: r.amount, notes: r.notes };
      }),
      actuals: actuals.map(function (r) {
        return { id: r.id, date: r.date, category: r.category, item: r.item, amount: r.amount, currency: r.currency, notes: r.notes };
      })
    };
  }
  function exportText() { return JSON.stringify(exportObj(), null, 2); }
  expBtn.addEventListener('click', function () {
    try {
      var blob = new Blob([exportText()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'expenses-' + iso(today()) + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
      flash(expBtn, 'Saved');
    } catch (e) { flash(expBtn, 'Download blocked'); ta.value = exportText(); ioPanel.hidden = false; }
  });
  copyBtn.addEventListener('click', function () {
    ta.value = exportText(); ioPanel.hidden = false;
    copyFrom(ta, copyBtn);
  });
  impBtn.addEventListener('click', function () {
    ioPanel.hidden = !ioPanel.hidden;
    if (!ioPanel.hidden) ta.focus();
  });
  clrBtn.addEventListener('click', function () {
    if (clrBtn.getAttribute('data-armed') !== '1') {
      clrBtn.setAttribute('data-armed', '1');
      clrBtn.textContent = 'Tap again to clear';
      setTimeout(function () { clrBtn.setAttribute('data-armed', '0'); clrBtn.textContent = 'Clear local entries'; }, 3000);
      return;
    }
    lsSet(LS.actuals, []);
    renderExpenses(); renderHeader();
  });

  function importText(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { impMsg.className = 'small bad'; impMsg.textContent = 'Not valid JSON — ' + e.message; return; }
    var rows;
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.actuals)) rows = parsed.actuals;
    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.expenses)) rows = parsed.expenses;
    else {
      impMsg.className = 'small bad';
      impMsg.textContent = 'Expected an array of entries, or an object with an "actuals" (or "expenses") array.';
      return;
    }
    var problems = [], good = [];
    rows.forEach(function (r, i) {
      if (!r || typeof r !== 'object') { problems.push('entry ' + (i + 1) + ' is not an object'); return; }
      var amount = num(pick(r, ['amount', 'cost', 'price', 'total']));
      if (amount == null) { problems.push('entry ' + (i + 1) + ' has no numeric "amount"'); return; }
      good.push({
        id: (typeof r.id === 'string' || typeof r.id === 'number') ? 'imp-' + r.id : 'a' + Date.now().toString(36) + i,
        date: firstString(r, ['date', 'when']),
        category: firstString(r, ['category', 'type', 'kind']) || 'Uncategorised',
        item: firstString(r, ['item', 'what', 'name', 'title', 'label', 'description']),
        amount: amount,
        currency: firstString(r, ['currency', 'cur']),
        notes: firstString(r, ['notes', 'note', 'comment'])
      });
    });
    if (problems.length) {
      impMsg.className = 'small bad';
      impMsg.textContent = 'Nothing imported. ' + problems.slice(0, 4).join('; ') + (problems.length > 4 ? ' (+' + (problems.length - 4) + ' more)' : '');
      return;
    }
    var list = localActuals();
    var added = 0, replaced = 0;
    good.forEach(function (r) {
      var at = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === r.id) at = i;
      if (at >= 0) { list[at] = r; replaced++; } else { list.push(r); added++; }
    });
    lsSet(LS.actuals, list);
    var note = 'Imported ' + added + ' new, replaced ' + replaced + '.';
    renderExpenses(); renderHeader();
    /* the tab re-renders from scratch, so re-open the panel and re-apply the note */
    var nta = document.getElementById('exp-io'), nmsg = document.getElementById('exp-import-msg');
    if (nta) { nta.parentNode.hidden = false; nta.value = text; }
    if (nmsg) { nmsg.className = 'small good'; nmsg.textContent = note; }
  }
  doImport.addEventListener('click', function () { importText(ta.value); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { ta.value = String(fr.result); importText(ta.value); };
    fr.readAsText(f);
  });

  expBtn.id = 'exp-export'; copyBtn.id = 'exp-copy'; impBtn.id = 'exp-toggle';
  clrBtn.id = 'exp-clear'; ta.id = 'exp-io'; doImport.id = 'exp-import';
  impMsg.id = 'exp-import-msg'; fileLabel.id = 'exp-file-label';
  box.appendChild(acard);
}

/* ----------------------------------------------------------------- packing */

function packingKey(cat, label, i) { return cat + '\u0000' + label + '\u0000' + i; }

function renderPacking() {
  var box = content('packing');
  clear(box);
  var err = errBanner('packing'); if (err) box.appendChild(err);

  var cats = normPacking();
  var state = lsGet(LS.packing, {}) || {};
  if (!cats.length) {
    box.appendChild(emptyState('No packing list yet.', 'data/packing.json'));
    return;
  }
  var flat = [];
  cats.forEach(function (c) { c.items.forEach(function (it, i) { flat.push({ cat: c.name, item: it, i: i, key: packingKey(c.name, it.label, i) }); }); });
  var done = flat.filter(function (f) { return state[f.key]; }).length;

  var head = ce('div', 'card');
  var hrow = ce('div', 'row');
  hrow.appendChild(ce('h3', null, 'Packed ' + done + ' / ' + flat.length));
  var resetBtn = ce('button', 'btn danger tiny', 'Reset');
  resetBtn.addEventListener('click', function () {
    if (resetBtn.getAttribute('data-armed') !== '1') {
      resetBtn.setAttribute('data-armed', '1');
      resetBtn.textContent = 'Tap again to reset';
      setTimeout(function () { resetBtn.setAttribute('data-armed', '0'); resetBtn.textContent = 'Reset'; }, 3000);
      return;
    }
    lsDel(LS.packing);
    renderPacking();
  });
  hrow.appendChild(resetBtn);
  head.appendChild(hrow);
  var bar = ce('div', 'progress');
  var fill = ce('span');
  fill.style.width = (flat.length ? Math.round(done / flat.length * 100) : 0) + '%';
  bar.appendChild(fill);
  head.appendChild(bar);
  var buys = flat.filter(function (f) { return f.item.buy && !state[f.key]; });
  head.appendChild(ce('div', 'small ' + (buys.length ? 'bad' : 'muted'),
    buys.length ? buys.length + ' item' + (buys.length === 1 ? '' : 's') + ' still to buy or arrange before departure'
                : 'Nothing marked as needing to be bought before departure.'));
  box.appendChild(head);

  if (buys.length) {
    var bc = ce('div', 'card');
    bc.appendChild(ce('h3', null, 'Buy / arrange before departure'));
    var bl = ce('ul', 'rows');
    buys.forEach(function (f) {
      var li = ce('li');
      li.appendChild(ce('div', null, f.item.label));
      li.appendChild(ce('span', 'badge buy', 'to buy'));
      li.appendChild(ce('div', 'meta', [f.cat, f.item.notes].filter(Boolean).join(' · ')));
      bl.appendChild(li);
    });
    bc.appendChild(bl);
    box.appendChild(bc);
  }

  cats.forEach(function (c) {
    var card = ce('div', 'card');
    var catDone = c.items.filter(function (it, i) { return state[packingKey(c.name, it.label, i)]; }).length;
    card.appendChild(ce('h3', null, c.name + ' (' + catDone + '/' + c.items.length + ')'));
    c.items.forEach(function (it, i) {
      var key = packingKey(c.name, it.label, i);
      var label = ce('label', 'pitem' + (state[key] ? ' done' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state[key];
      cb.addEventListener('change', function () {
        var s = lsGet(LS.packing, {}) || {};
        if (cb.checked) s[key] = 1; else delete s[key];
        lsSet(LS.packing, s);
        renderPacking();
      });
      label.appendChild(cb);
      var lb = ce('span', 'lbl', it.label);
      if (it.notes) lb.appendChild(ce('div', 'pnotes', it.notes));
      label.appendChild(lb);
      if (it.buy) label.appendChild(ce('span', 'badge buy', 'to buy'));
      card.appendChild(label);
    });
    box.appendChild(card);
  });
}

/* --------------------------------------------------------- recommendations */

function renderRecommendations() {
  var box = content('recommendations');
  clear(box);
  var err = errBanner('recommendations'); if (err) box.appendChild(err);

  var recs = allRecs();
  var selArea = box.getAttribute('data-area') || 'all';
  var selCat = box.getAttribute('data-cat') || 'all';
  var selStatus = box.getAttribute('data-status') || 'all';

  function uniq(fn) {
    var seen = {}, out = [];
    recs.forEach(function (r) { var v = fn(r); if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } });
    return out.sort();
  }
  var areas = uniq(function (r) { return r.area; });
  var catsU = uniq(function (r) { return r.category; });

  var filters = ce('div', 'filters');
  function mkSelect(label, options, current, onchange) {
    var s = document.createElement('select');
    s.setAttribute('aria-label', label);
    var o0 = document.createElement('option'); o0.value = 'all'; o0.textContent = label; s.appendChild(o0);
    options.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; s.appendChild(o); });
    if (options.indexOf(current) === -1 && current !== 'all') { var o = document.createElement('option'); o.value = current; o.textContent = current; s.appendChild(o); }
    s.value = current;
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }
  filters.appendChild(mkSelect('All areas', areas, selArea, function (v) {
    box.setAttribute('data-area', v); renderRecommendations();
  }));
  filters.appendChild(mkSelect('All categories', catsU, selCat, function (v) {
    box.setAttribute('data-cat', v); renderRecommendations();
  }));
  filters.appendChild(mkSelect('Any status', recs.length ? ['idea', 'shortlisted', 'planned'] : [], selStatus, function (v) {
    box.setAttribute('data-status', v); renderRecommendations();
  }));
  if (recs.length) box.appendChild(filters);

  var shown = recs.filter(function (r) {
    if (selArea !== 'all' && r.area !== selArea) return false;
    if (selCat !== 'all' && r.category !== selCat) return false;
    if (selStatus !== 'all' && recStatus(r) !== selStatus) return false;
    return true;
  });

  if (!recs.length) {
    box.appendChild(emptyState('No recommendations collected yet.', 'data/recommendations.json'));
  } else if (!shown.length) {
    box.appendChild(ce('div', 'empty', 'Nothing matches those filters.'));
  }

  shown.forEach(function (r) {
    var card = ce('article', 'card');
    var head = ce('div', 'row');
    head.appendChild(ce('h3', null, r.name));
    var st = recStatus(r);
    var badge = ce('span', 'badge ' + st, st);
    if (r.local) badge.setAttribute('title', 'added in this browser only');
    head.appendChild(badge);
    card.appendChild(head);

    var sub = [r.area, r.category].filter(Boolean).join(' · ');
    if (sub) card.appendChild(ce('div', 'muted small', sub));
    if (r.why) card.appendChild(ce('p', null, r.why));
    if (r.cost) card.appendChild(ce('div', 'small', 'Cost: ' + r.cost));
    if (r.by || r.added) card.appendChild(ce('div', 'muted small', ['added by ' + r.by, r.added].filter(Boolean).join(' · ')));
    if (r.notes) card.appendChild(ce('div', 'muted small', r.notes));

    var actions = ce('div', 'actions');
    if (isUrl(r.source)) actions.appendChild(link(r.source, 'Source'));
    else if (r.source) actions.appendChild(ce('span', 'muted small', r.source));
    if (r.area) actions.appendChild(link(mapUrl(r.name + ' ' + r.area + ' Vietnam'), 'Map'));
    var next = REC_STATUSES[(REC_STATUSES.indexOf(st) + 1) % REC_STATUSES.length];
    var cycle = ce('button', 'btn ghost tiny', 'Mark ' + next);
    cycle.addEventListener('click', function () {
      var over = lsGet(LS.recstatus, {}) || {};
      over[r.key] = next;
      lsSet(LS.recstatus, over);
      renderRecommendations();
    });
    actions.appendChild(cycle);
    if (r.local) {
      actions.appendChild(ce('span', 'badge local', 'local only'));
    }
    card.appendChild(actions);
    box.appendChild(card);
  });

  box.appendChild(addRecPanel());
}

function addRecPanel() {
  var panel = ce('div', 'card');
  panel.id = 'addrec';
  panel.appendChild(ce('h3', null, '+ Add recommendation'));
  panel.appendChild(ce('p', 'muted small',
    'Paste a finding as JSON (an object or an array), or fill the form. Validate, then copy the result into data/recommendations.json — or keep it on this page for now.'));

  var template = { title: 'Banh mi stand', area: 'Hoi An', category: 'food', why: 'Best banh mi in town, 5 min from the hotel', cost_estimate: 'VND 40k', source_url: 'https://…', added_by: 'mugger', status: 'idea' };
  var ta = document.createElement('textarea');
  ta.value = JSON.stringify(template, null, 2);
  ta.setAttribute('aria-label', 'Paste recommendation JSON');
  panel.appendChild(ce('label', 'fld', 'Paste JSON (object or array of objects)')).appendChild(ta);

  var msg = ce('div', 'small', '');
  var preview = ce('div', 'stack');
  var out = document.createElement('textarea');
  out.readOnly = true;
  out.setAttribute('aria-label', 'Resulting JSON entry');
  out.placeholder = 'The validated entry shows up here, ready to copy.';

  var pending = [];

  var bValidate = ce('button', 'btn tiny', 'Validate & preview');
  var bTemplate = ce('button', 'btn ghost tiny', 'Reset to template');
  var bCopy = ce('button', 'btn tiny', 'Copy JSON');
  var bLocal = ce('button', 'btn ghost tiny', 'Keep on this page');
  var bClearLocal = ce('button', 'btn danger tiny', 'Remove page-only entries');

  var actions1 = ce('div', 'actions');
  actions1.appendChild(bValidate); actions1.appendChild(bTemplate);
  panel.appendChild(actions1);
  panel.appendChild(msg);

  /* --- small form --- */
  var grid = ce('div', 'fgrid two');
  function field(label, ph, val) {
    var i = document.createElement('input');
    i.type = 'text'; i.placeholder = ph || ''; if (val) i.value = val;
    var l = ce('label', 'fld', label);
    l.appendChild(i);
    grid.appendChild(l);
    return i;
  }
  var fName = field('Name *', 'Banh mi stand');
  var fArea = field('Area', 'Hoi An');
  var fCat = field('Category', 'food / sight / bar / stay');
  var fCost = field('Cost estimate', 'VND 40k');
  var fSrc = field('Source link', 'https://…');
  var fBy = field('Added by', 'mugger / nomad / me');
  var fWhy = field('Why', 'Best in town, near the hotel');
  panel.appendChild(grid);
  var grid2 = ce('div', 'fgrid');
  var lStatus = ce('label', 'fld', 'Status');
  var fStatus = document.createElement('select');
  REC_STATUSES.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; fStatus.appendChild(o); });
  lStatus.appendChild(fStatus);
  grid2.appendChild(lStatus);
  panel.appendChild(grid2);

  var bBuild = ce('button', 'ghost btn tiny', 'Build entry from form');
  var actions2 = ce('div', 'actions');
  actions2.appendChild(bBuild);
  panel.appendChild(actions2);

  panel.appendChild(ce('label', 'fld', 'Result')).appendChild(out);
  var actions3 = ce('div', 'actions');
  actions3.appendChild(bCopy); actions3.appendChild(bLocal); actions3.appendChild(bClearLocal);
  panel.appendChild(actions3);
  panel.appendChild(preview);

  /* write it the way data/recommendations.json is already written, so it drops straight in */
  function canonical(r) {
    var o = {};
    if (r.name) o.title = r.name;
    ['area', 'category', 'why'].forEach(function (k) { if (r[k]) o[k] = r[k]; });
    if (r.cost) o.cost_estimate = r.cost;
    if (r.source) o.source_url = r.source;
    if (r.by) o.added_by = r.by;
    if (r.notes) o.notes = r.notes;
    o.status = r.status || 'idea';
    return o;
  }
  function show(entries, note) {
    pending = entries;
    out.value = JSON.stringify(entries.length === 1 ? canonical(entries[0]) : entries.map(canonical), null, 2);
    clear(preview);
    entries.forEach(function (r) {
      var c = ce('div', 'card');
      c.appendChild(ce('h3', null, r.name));
      var sub = [r.area, r.category].filter(Boolean).join(' · ');
      if (sub) c.appendChild(ce('div', 'muted small', sub));
      if (r.why) c.appendChild(ce('p', null, r.why));
      if (r.cost) c.appendChild(ce('div', 'small', 'Cost: ' + r.cost));
      preview.appendChild(c);
    });
    msg.className = 'small good';
    msg.textContent = note || ('Looks good — ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ' ready. Copy JSON into data/recommendations.json (inside the "recommendations" array), or keep it on this page.');
  }
  function fail(texts) {
    pending = [];
    out.value = '';
    clear(preview);
    msg.className = 'small bad';
    msg.textContent = texts.join(' • ');
  }
  function validate(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      fail(['Not valid JSON — ' + e.message + '. Check for a missing comma, a single-quoted string, or a trailing comma.']);
      return;
    }
    var arr = Array.isArray(parsed) ? parsed : [parsed];
    var good = [], problems = [];
    arr.forEach(function (o, i) {
      var p = [];
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        problems.push('entry ' + (i + 1) + ': expected an object like ' + JSON.stringify(template));
        return;
      }
      if (!firstString(o, ['name', 'title', 'what', 'place'])) p.push('missing "name"');
      ['area', 'category', 'why', 'cost', 'source', 'link', 'notes', 'status'].forEach(function (k) {
        if (o[k] != null && typeof o[k] === 'object') p.push('"' + k + '" must be a string');
      });
      var st = txt(o.status).trim().toLowerCase();
      if (st && REC_STATUSES.indexOf(st) === -1) p.push('"status" must be one of ' + REC_STATUSES.join(' / ') + ' (got "' + txt(o.status) + '")');
      if (p.length) { problems.push('entry ' + (i + 1) + ': ' + p.join('; ')); return; }
      var n = normalizeRec(o, true, i);
      if (!n) { problems.push('entry ' + (i + 1) + ': could not read it'); return; }
      good.push(n);
    });
    if (!good.length) {
      problems.push('nothing usable — expected ' + JSON.stringify(template));
      fail(problems);
      return;
    }
    show(good, problems.length ? problems.join(' • ') : '');
  }

  bValidate.addEventListener('click', function () { validate(ta.value); });
  bTemplate.addEventListener('click', function () { ta.value = JSON.stringify(template, null, 2); msg.textContent = ''; out.value = ''; clear(preview); pending = []; });
  bBuild.addEventListener('click', function () {
    if (!fName.value.trim()) { msg.className = 'small bad'; msg.textContent = 'The form needs at least a name.'; return; }
    var o = { name: fName.value.trim(), area: fArea.value.trim(), category: fCat.value.trim(), why: fWhy.value.trim(), cost: fCost.value.trim(), source: fSrc.value.trim(), by: fBy.value.trim(), status: fStatus.value };
    var n = normalizeRec(o, true, 0);
    if (!n) { msg.className = 'small bad'; msg.textContent = 'Could not read the form entry.'; return; }
    show([n]);
    ta.value = JSON.stringify(canonical(n), null, 2);
  });
  bCopy.addEventListener('click', function () {
    if (!out.value.trim()) { msg.className = 'small bad'; msg.textContent = 'Nothing to copy yet — validate some JSON or build an entry first.'; return; }
    copyFrom(out, bCopy);
  });
  bLocal.addEventListener('click', function () {
    if (!pending.length) { msg.className = 'small bad'; msg.textContent = 'Nothing to keep yet — validate or build an entry first.'; return; }
    var list = lsGet(LS.recs, []);
    if (!Array.isArray(list)) list = [];
    pending.forEach(function (r) {
      list = list.filter(function (x) { return recKey(normalizeRec(x)) !== r.key; });
      list.push(canonical(r));
    });
    lsSet(LS.recs, list);
    var box = content('recommendations');
    renderRecommendations();
    flash(bLocal, 'Kept');
    void box;
  });
  bClearLocal.addEventListener('click', function () {
    if (bClearLocal.getAttribute('data-armed') !== '1') {
      bClearLocal.setAttribute('data-armed', '1');
      bClearLocal.textContent = 'Tap again to remove';
      setTimeout(function () { bClearLocal.setAttribute('data-armed', '0'); bClearLocal.textContent = 'Remove page-only entries'; }, 3000);
      return;
    }
    lsDel(LS.recs);
    renderRecommendations();
  });

  ta.id = 'rec-paste'; out.id = 'rec-out'; msg.id = 'rec-msg';
  fName.id = 'rec-name'; fArea.id = 'rec-area'; fCat.id = 'rec-cat'; fCost.id = 'rec-cost';
  fSrc.id = 'rec-source'; fWhy.id = 'rec-why'; fStatus.id = 'rec-status'; fBy.id = 'rec-by';
  bValidate.id = 'rec-validate'; bCopy.id = 'rec-copy'; bLocal.id = 'rec-local';
  bClearLocal.id = 'rec-clear'; bBuild.id = 'rec-build'; bTemplate.id = 'rec-template';
  return panel;
}

/* --------------------------------------------------------------- decisions */
/* data/decisions.json — one entry per open question, with a primary option
   (Nomad's recommendation, cost_delta_sgd always 0) and its alternatives.
   Picks live in localStorage; on a shared trip they are written into that
   trip's decisions document on the backend (the backend has no picks table —
   one row per section, and a pick is one field of the decision it belongs to).
   Nothing here is inferred: a decision with no options renders as such.      */

function normDecisions() {
  var raw = DATA.decisions;
  if (raw == null) return [];
  var list = Array.isArray(raw) ? raw : asArray(raw, ['decisions', 'items', 'list']);
  return list.filter(function (d) { return d && typeof d === 'object' && !Array.isArray(d); });
}
function decisionOptions(d) {
  return (d && Array.isArray(d.options) ? d.options : [])
    .filter(function (o) { return o && typeof o === 'object' && !Array.isArray(o); });
}
function optionById(d, id) {
  var want = txt(id);
  var found = decisionOptions(d).filter(function (o) { return txt(o.id) === want; });
  return found.length ? found[0] : null;
}
function decisionPrimary(d) {
  var opts = decisionOptions(d);
  return optionById(d, d.primary_option_id) || opts[0] || null;
}
function recommenderName() {
  var ds = normDecisions();
  for (var i = 0; i < ds.length; i++) {
    var b = firstString(ds[i], ['decided_by', 'by', 'recommended_by']);
    if (b) return b.charAt(0).toUpperCase() + b.slice(1);
  }
  return 'Nomad';
}
function optionsCurrency() { return tripCurrency() || 'SGD'; }

function pickOf(d) {
  var p = PICKS[txt(d.id)];
  if (!p) return null;
  return optionById(d, typeof p === 'object' ? p.option_id : p);
}
function currentOption(d) { return pickOf(d) || decisionPrimary(d); }
function deltaOf(o) { if (!o) return 0; var n = num(o.cost_delta_sgd); return n == null ? 0 : n; }

/* one pass over the decisions, with the current pick already resolved */
function picksState() {
  return normDecisions().map(function (d) {
    var p = PICKS[txt(d.id)] || null;
    var cur = currentOption(d), prim = decisionPrimary(d);
    return {
      d: d,
      pick: p,
      current: cur,
      primary: prim,
      switched: !!(p && cur && prim && txt(cur.id) !== txt(prim.id)),
      delta: deltaOf(cur),
      status: p ? 'decided' : (txt(d.status).toLowerCase() || 'open')
    };
  });
}
function tripDelta() {
  var st = picksState();
  if (!st.length) return null;
  var t = 0;
  st.forEach(function (s) { t += s.delta; });
  return t;
}
function travellers() {
  var t = DATA.trip;
  if (!t || typeof t !== 'object') return null;
  return num(pick(t, ['travellers', 'travelers', 'pax', 'people']));
}
/* "on Nomad's plan" / "+S$145/person vs Nomad's plan (S$290 for 2)" */
function deltaSentence() {
  var st = picksState();
  if (!st.length) return '';
  var d = tripDelta() || 0, cur = optionsCurrency();
  if (!d) return 'on ' + recommenderName() + '\u2019s plan';
  var tv = travellers();
  return fmtVariance(d, cur) + '/person vs ' + recommenderName() + '\u2019s plan' +
    (tv && tv > 1 ? ' (' + fmtVariance(d * tv, cur) + ' for ' + tv + ' travellers)' : '');
}
function decisionsSummaryLine() {
  var st = picksState();
  if (!st.length) return '';
  var picked = st.filter(function (s) { return !!s.pick; }).length;
  return 'Decisions: ' + picked + ' of ' + st.length + ' picked \u00b7 ' + deltaSentence();
}

/* ---------------------------------------------------------------- day refs */

function changeText(c) {
  if (c == null) return '';
  if (typeof c === 'object') return firstString(c, ['text', 'what', 'change', 'description', 'summary', 'detail']);
  return String(c);
}
function changeDayNo(c) {
  if (c && typeof c === 'object') {
    var n = num(pick(c, ['day', 'day_number', 'n']));
    if (n != null) return n;
  }
  var m = /\bday\s*(\d+)\b/i.exec(changeText(c));
  return m ? parseInt(m[1], 10) : null;
}
function changeDate(c) {
  var m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(changeText(c));
  return m ? m[1] : null;
}
/* Only offer a jump when that day is actually on the Itinerary tab. */
function dayAnchor(no, dateS) {
  if (no != null && document.getElementById('day-' + no)) return document.getElementById('day-' + no);
  if (dateS) {
    var all = $$('[data-date]');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-date') === dateS) return all[i];
  }
  return null;
}
function jumpToDay(no, dateS) {
  showTab('itinerary', true);
  lsSet('vt.tab', 'itinerary');
  var el = dayAnchor(no, dateS);
  if (!el) return false;
  window.scrollTo(0, 0);
  try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
  el.classList.add('target');
  setTimeout(function () { el.classList.remove('target'); }, 2200);
  return true;
}

/* ----------------------------------------------------------------- picking */

function pickerName() {
  if (AUTH.user && AUTH.user.email) return AUTH.user.email;
  if (AUTH.user && AUTH.user.name) return AUTH.user.name;
  return 'this device';
}
function pickLabel(p) {
  if (!p) return '';
  var who = typeof p === 'object' ? txt(p.picked_by) : '';
  return who || 'this device';
}
function savePick(d, option) {
  var id = txt(d.id);
  if (!id || !option) return;
  PICKS[id] = { option_id: txt(option.id), picked_by: pickerName(), at: Date.now() };
  if (PICKS_CLOUD && AUTH.trip) {
    AUTH.busy = true;
    renderHeader(); renderDecisions(); markDirty('expenses'); markDirty('share');
    /* DATA.decisions rides along as the seed: the first pick on a trip whose
       decisions were never imported creates that section row from this copy */
    TripAuth.savePick(AUTH.trip.id, id, txt(option.id), DATA.decisions).then(function () {
      AUTH.busy = false;
      renderAll();
    }, function (e) {
      AUTH.busy = false;
      AUTH.msg = { kind: 'bad', text: 'Could not save that choice to the shared trip: ' + (e && e.message ? e.message : e) };
      renderAll();
    });
  } else {
    lsSet(LS.decisions, PICKS);
    renderHeader(); renderDecisions(); markDirty('expenses'); markDirty('share');
  }
}
function loadPicksLocal() {
  var p = lsGet(LS.decisions, {});
  PICKS = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  PICKS_CLOUD = false;
}
function anyPicks() {
  for (var k in PICKS) if (Object.prototype.hasOwnProperty.call(PICKS, k)) return true;
  return false;
}

/* -------------------------------------------------------------- decisions UI */

function renderDecisions() {
  var box = content('decisions');
  clear(box);
  var err = errBanner('decisions'); if (err) box.appendChild(err);

  var st = picksState();
  if (!st.length) {
    box.appendChild(emptyState((MISSING.decisions || LOAD_ERR.decisions)
      ? 'No decisions to review yet \u2014 they arrive in data/decisions.json.'
      : 'data/decisions.json has no decisions in it yet.', 'data/decisions.json'));
    return;
  }
  box.appendChild(decisionSummaryCard(st));
  st.forEach(function (s) { box.appendChild(decisionCard(s)); });
}

function decisionSummaryCard(st) {
  var cur = optionsCurrency(), d = tripDelta() || 0;
  var card = ce('div', 'card dectotal');
  card.appendChild(ce('h3', null, 'Your picks'));
  var open = st.filter(function (s) { return !s.pick; }).length;
  card.appendChild(ce('div', 'dectotal-line', deltaSentence()));
  card.appendChild(ce('p', 'muted small',
    (st.length - open) + ' of ' + st.length + ' decided' +
    (open ? ' \u00b7 ' + open + ' still open' : ' \u00b7 nothing left to pick')));
  if (d !== 0) {
    var tv = travellers();
    card.appendChild(ce('p', 'muted small',
      'That is ' + fmtVariance(d * (tv || 1), cur) + ' in total' + (tv && tv > 1 ? ' for ' + tv : '') +
      ' against the researched plan.'));
  }
  if (AUTH.trip) card.appendChild(ce('p', 'muted small',
    'Shared trip \u00b7 ' + AUTH.trip.name + (AUTH.role ? ' \u00b7 you are ' + AUTH.role : '')));
  if (anyPicks()) {
    var reset = ce('button', 'btn tiny ghost', 'Reset all picks');
    reset.addEventListener('click', function () {
      if (reset.getAttribute('data-armed') !== '1') {
        reset.setAttribute('data-armed', '1');
        reset.textContent = 'Tap again to reset';
        setTimeout(function () {
          reset.setAttribute('data-armed', '0');
          reset.textContent = 'Reset all picks';
        }, 3000);
        return;
      }
      for (var k in PICKS) if (Object.prototype.hasOwnProperty.call(PICKS, k)) delete PICKS[k];
      if (PICKS_CLOUD && AUTH.trip) {
        /* the picks are in the trip's decisions document: clear them there, or
           they come back on the next load */
        AUTH.busy = true;
        TripAuth.clearPicks(AUTH.trip.id).then(function () {
          AUTH.busy = false;
          markDirty('expenses'); markDirty('share');
          renderAll();
        }, function (e) {
          AUTH.busy = false;
          AUTH.msg = { kind: 'bad', text: 'Picks were cleared here but not on the shared trip: ' + (e && e.message ? e.message : e) };
          renderAll();
        });
        return;
      }
      lsSet(LS.decisions, PICKS);
      markDirty('expenses'); markDirty('share');
      renderAll();
    });
    card.appendChild(ce('div', 'actions')).appendChild(reset);
  }
  return card;
}

function decisionCard(s) {
  var d = s.d, cur = optionsCurrency();
  var card = ce('article', 'card decision');
  card.setAttribute('data-decision', txt(d.id));

  var head = ce('div', 'dechead');
  head.appendChild(ce('h3', null, txt(d.title) || txt(d.question) || 'Decision ' + txt(d.id)));
  card.appendChild(head);

  var badges = ce('div', 'decbadges');
  badges.appendChild(ce('span', 'badge ' + slugClass(s.status), s.status));
  if (s.current && s.primary && txt(s.current.id) === txt(s.primary.id)) {
    badges.appendChild(ce('span', 'badge nomad', recommenderName() + ' recommends'));
  }
  if (s.switched) badges.appendChild(ce('span', 'badge yours', 'Your pick'));
  if (s.delta) badges.appendChild(ce('span', 'badge delta', fmtVariance(s.delta, cur) + ' /person'));
  card.appendChild(badges);

  if (has(d.question)) card.appendChild(ce('p', 'decq', txt(d.question)));
  if (s.pick) {
    card.appendChild(ce('div', 'small muted pickline',
      'Chosen by ' + pickLabel(s.pick) +
      (s.pick && s.pick.at ? ' \u00b7 ' + fmtDate(new Date(s.pick.at), true) : '')));
  }
  if (PICKS_CLOUD && AUTH.busy) card.appendChild(ce('div', 'small muted', 'Saving\u2026'));

  card.appendChild(optionBlock(d, s.current, true));

  var alts = decisionOptions(d).filter(function (o) {
    return !s.current || txt(o.id) !== txt(s.current.id);
  });
  if (alts.length) {
    card.appendChild(ce('h4', 'althead', 'Alternatives'));
    alts.forEach(function (o) { card.appendChild(optionBlock(d, o, false)); });
  }
  if (s.switched && s.primary) {
    var back = ce('button', 'btn tiny ghost backbtn', 'Back to ' + recommenderName() + '\u2019s pick');
    back.addEventListener('click', function () { savePick(d, s.primary); });
    var act = ce('div', 'actions');
    act.appendChild(back);
    card.appendChild(act);
  }
  return card;
}

function optionBlock(d, o, isCurrent) {
  var cur = optionsCurrency();
  var box = ce('div', 'opt' + (isCurrent ? ' current' : ' alt'));
  if (!o) { box.appendChild(ce('div', 'muted small', 'This decision has no options to show.')); return box; }

  var head = ce('div', 'opthead');
  head.appendChild(ce('div', 'optlabel', txt(o.label) || txt(o.id)));
  if (isCurrent) head.appendChild(ce('span', 'badge current-badge', 'Current'));
  head.appendChild(ce('span', 'optdelta' + (deltaOf(o) > 0 ? ' up' : (deltaOf(o) < 0 ? ' down' : '')),
    deltaOf(o) === 0 ? 'in ' + recommenderName() + '\u2019s plan' : fmtVariance(deltaOf(o), cur) + ' /person'));
  box.appendChild(head);

  if (has(o.summary)) box.appendChild(ce('p', 'optsum', txt(o.summary)));

  var facts = ce('div', 'optfacts');
  if (has(o.booking_impact)) {
    var b = ce('div');
    b.appendChild(ce('b', null, 'Booking: '));
    b.appendChild(document.createTextNode(txt(o.booking_impact)));
    facts.appendChild(b);
  }
  if (has(o.tradeoffs)) {
    var t = ce('div');
    t.appendChild(ce('b', null, 'Trade-offs: '));
    t.appendChild(document.createTextNode(txt(o.tradeoffs)));
    facts.appendChild(t);
  }
  if (facts.childNodes.length) box.appendChild(facts);

  var changes = Array.isArray(o.changes) ? o.changes
    : (has(o.changes) ? [o.changes] : []);
  var texts = changes.map(changeText).filter(has);
  if (texts.length) {
    var h = ce('div', 'optsub', 'What changes on the itinerary');
    box.appendChild(h);
    var ul = ce('ul', 'changes');
    changes.forEach(function (c, i) {
      var text = changeText(c);
      if (!has(text)) return;
      var li = ce('li');
      li.appendChild(ce('span', 'ctext', text));
      var no = changeDayNo(c), dateS = changeDate(c);
      if (dayAnchor(no, dateS)) {
        var j = ce('button', 'btn tiny ghost dayjump', no != null ? 'Day ' + no + ' \u2192' : 'That day \u2192');
        j.setAttribute('data-day', no != null ? no : '');
        j.addEventListener('click', function () { jumpToDay(no, dateS); });
        li.appendChild(j);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  var srcs = Array.isArray(o.sources) ? o.sources.filter(isUrl) : [];
  if (srcs.length) {
    var links = ce('div', 'optsrc');
    srcs.forEach(function (u) { links.appendChild(link(u, 'Source')); });
    box.appendChild(links);
  }

  if (!isCurrent) {
    var act = ce('div', 'actions');
    if (PICKS_CLOUD && AUTH.trip && !AUTH.canEdit) {
      /* the backend only shares a trip with the owner and its members, so a
         trip you can read but not change should not be happening: say so
         rather than failing on tap */
      var ro = ce('button', 'btn tiny ghost', 'Read-only');
      ro.disabled = true;
      ro.title = 'The backend is not giving this account write access to the trip (you are ' + (AUTH.role || 'a member') + ').';
      act.appendChild(ro);
    } else {
      var sw = ce('button', 'btn tiny', 'Switch to this');
      sw.addEventListener('click', function () { savePick(d, o); });
      act.appendChild(sw);
    }
    box.appendChild(act);
  }
  return box;
}

function slugClass(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'open';
}

/* The trip-level delta, shown with the other summary numbers (Expenses tab). */
function decisionsDeltaNote(planTotal, cur) {
  var st = picksState();
  if (!st.length) return null;
  var d = tripDelta() || 0;
  var box = ce('div', 'deltanote');
  var tv = travellers();
  box.appendChild(ce('div', null, 'If you take your current picks: ' + deltaSentence() + '.'));
  if (d && planTotal != null) {
    box.appendChild(ce('div', 'muted small',
      'This plan is ' + money(planTotal, cur) + '/person, so your picks put it at ' +
      money(planTotal + d, cur) + '/person' + (tv && tv > 1 ? ' (' + money((planTotal + d) * tv, cur) + ' for ' + tv + ')' : '') + '.'));
  }
  var j = ce('button', 'btn tiny ghost', 'Review the decisions');
  j.addEventListener('click', function () { showTab('decisions', true); lsSet('vt.tab', 'decisions'); window.scrollTo(0, 0); });
  var act = ce('div', 'actions');
  act.appendChild(j);
  box.appendChild(act);
  return box;
}

/* ------------------------------------------------------- account / sharing */

function markDirty(name) { DIRTY[name] = true; }
function authReady() { return !!(window.TripAuth); }

function accountLine() {
  if (!authReady() || !AUTH.configured) return 'Local mode \u2014 no backend is configured, so everything stays on this device.';
  if (!AUTH.ready) return 'Connecting to ' + (TripAuth.backendName() || 'the backend') + '\u2026';
  if (!AUTH.user) return 'Not signed in \u2014 the app is showing only the local data files.';
  return 'Signed in as ' + (AUTH.user.email || AUTH.user.name || AUTH.user.id);
}
/* Why the sign-in button cannot work yet. Straight from the backend's
   /api/collections/users/auth-methods, which answers "no providers" until the
   owner has pasted a Google client id/secret into the admin console. */
function noSignInReason() {
  if (AUTH.oauth.offline) return backendLabel() + ' is not answering right now.';
  if (AUTH.oauth.message) return AUTH.oauth.message;
  return 'no sign-in method is available yet.';
}

function doSignIn() {
  if (!authReady()) return;
  AUTH.msg = null;
  AUTH.busy = true;
  renderShare(); renderHeader();
  TripAuth.signIn().then(function () {
    AUTH.busy = false;
    renderAll();
  }, function (e) {
    AUTH.busy = false;
    AUTH.msg = { kind: 'bad', text: 'Sign-in did not start: ' + (e && e.message ? e.message : e) };
    renderAll();
  });
}
function doSignOut() {
  if (!authReady()) return;
  TripAuth.signOut().then(function () {
    AUTH.user = null; AUTH.trip = null; AUTH.role = ''; AUTH.canEdit = false;
    AUTH.members = []; AUTH.trips = null; AUTH.invites = null; AUTH.msg = null;
    lsDel(LS.trip);
    restoreRepo();
    loadPicksLocal();
    renderAll();
  });
}
function loadTrips() {
  if (!authReady() || !AUTH.user) { AUTH.trips = null; return; }
  TripAuth.listTrips().then(function (rows) {
    AUTH.trips = Array.isArray(rows) ? rows : [];
    markDirty('share');
    if (currentTabName() === 'share') renderShare();
  }, function (e) {
    AUTH.trips = [];
    AUTH.msg = { kind: 'bad', text: 'Could not list your trips: ' + (e && e.message ? e.message : e) };
    markDirty('share');
    if (currentTabName() === 'share') renderShare();
  });
}
/* invitations addressed to my own email, which the backend lets me read
   before I am a member of anything (that is the whole point of the row) */
function loadInvites() {
  if (!authReady() || !AUTH.user) { AUTH.invites = null; return; }
  TripAuth.pendingInvites().then(function (rows) {
    AUTH.invites = Array.isArray(rows) ? rows : [];
    markDirty('share');
    if (currentTabName() === 'share') renderShare();
  }, function (e) {
    AUTH.invites = [];
    AUTH.msg = { kind: 'bad', text: 'Could not check for invitations: ' + (e && e.message ? e.message : e) };
    markDirty('share');
    if (currentTabName() === 'share') renderShare();
  });
}
function doAcceptInvite(inv) {
  AUTH.busy = true;
  AUTH.msg = null;
  renderShare(); renderHeader();
  TripAuth.acceptInvite(inv).then(function () {
    AUTH.busy = false;
    var label = txt(inv.trip_title) || ('trip ' + txt(inv.trip));
    AUTH.msg = { kind: 'good', text: 'Joined \u201c' + label + '\u201d. Opening it\u2026' };
    loadInvites();
    loadTrips();
    loadSharedTrip(inv.trip, 'You are now a member of \u201c' + label + '\u201d. Everyone on a trip can read and change it.');
  }, function (e) {
    AUTH.busy = false;
    AUTH.msg = { kind: 'bad', text: 'Could not accept that invitation: ' + (e && e.message ? e.message : e) };
    renderAll();
  });
}
function doLeaveTrip() {
  var mine = null;
  AUTH.members.forEach(function (m) {
    if (!mine && m.kind === 'member' && AUTH.user && m.user_id === AUTH.user.id) mine = m;
  });
  if (!mine) return;
  AUTH.busy = true;
  renderShare(); renderHeader();
  TripAuth.removeMember(mine).then(function () {
    AUTH.busy = false;
    AUTH.trip = null; AUTH.role = ''; AUTH.canEdit = false; AUTH.members = [];
    PICKS_CLOUD = false;
    lsDel(LS.trip);
    restoreRepo();
    loadPicksLocal();
    AUTH.msg = { kind: 'good', text: 'You left that trip. It is no longer on your list; ask the owner to invite you again if that was a mistake.' };
    loadTrips(); loadInvites();
    renderAll();
  }, function (e) {
    AUTH.busy = false;
    AUTH.msg = { kind: 'bad', text: 'Could not leave: ' + (e && e.message ? e.message : e) };
    renderAll();
  });
}
function requestedSlug() {
  var m = /(?:^|[#&?])trip=([^&]+)/.exec(String(location.hash || ''));
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  return lsGet(LS.trip, '') || '';
}
function loadSharedTrip(key, notice) {
  if (!authReady() || !AUTH.user || !AUTH.configured || !has(key)) return;
  AUTH.busy = true;
  AUTH.msg = null;
  renderShare(); renderHeader();
  TripAuth.openTrip(key).then(function (res) {
    AUTH.trip = res.trip;
    AUTH.role = res.role || 'member';
    AUTH.canEdit = !!res.canEdit;
    AUTH.members = res.members || [];
    restoreRepo();
    applyDocs(res.docs);
    lsSet(LS.trip, res.trip.id);
    /* a caller that just did something (invited, imported, removed) keeps its
       own confirmation; otherwise say what is on screen now */
    AUTH.msg = notice
      ? { kind: 'good', text: notice }
      : {
        kind: AUTH.canEdit ? 'good' : 'warn',
        text: 'Showing the shared trip \u201c' + res.trip.name + '\u201d. You are ' + AUTH.role +
          (AUTH.canEdit
            ? ' \u2014 everyone on this trip can read and change it.'
            : ' \u2014 the backend is not giving you access to this trip.')
      };
    return TripAuth.loadPicks(res.trip.id).then(function (picks) {
      PICKS = picks || {};
      PICKS_CLOUD = true;
    });
  }).then(function () {
    AUTH.busy = false;
    renderAll();
  }, function (e) {
    AUTH.busy = false;
    AUTH.trip = null;
    AUTH.canEdit = false;
    AUTH.members = [];
    PICKS_CLOUD = false;
    loadPicksLocal();
    AUTH.msg = { kind: 'bad', text: (e && e.message) ? e.message : String(e) };
    renderAll();
  });
}
/* Cloud documents win over the local files; anything a trip does not carry
   falls back to the copy in data/ so a half-seeded trip still renders. */
function applyDocs(docs) {
  if (!docs) return 0;
  var n = 0;
  FILES.forEach(function (name) {
    if (docs[name] !== undefined && docs[name] !== null) {
      DATA[name] = docs[name];
      delete MISSING[name];
      delete LOAD_ERR[name];
      n++;
    }
  });
  return n;
}
function snapshotRepo() {
  REPO = {};
  FILES.forEach(function (name) { if (DATA[name] !== undefined) REPO[name] = DATA[name]; });
}
function restoreRepo() {
  FILES.forEach(function (name) {
    if (REPO[name] !== undefined) DATA[name] = REPO[name];
  });
}
function docPayload() {
  var out = {};
  FILES.forEach(function (name) { if (DATA[name] !== undefined) out[name] = DATA[name]; });
  return out;
}

function renderShare() {
  var box = content('share');
  clear(box);
  box.appendChild(accountCard());
  if (!authReady() || !AUTH.configured) { box.appendChild(setupCard()); return; }
  if (AUTH.msg) box.appendChild(ce('div', 'alert ' + (AUTH.msg.kind === 'bad' ? 'err' : (AUTH.msg.kind === 'good' ? 'ok' : 'warn')), AUTH.msg.text));
  if (!AUTH.user) { box.appendChild(signInCard()); return; }
  box.appendChild(invitedCard());
  box.appendChild(tripsCard());
  box.appendChild(sharedTripCard());
  box.appendChild(membersCard());
  box.appendChild(inviteCard());
  box.appendChild(importCard());
}

function accountCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Account'));
  card.appendChild(ce('div', null, accountLine()));
  if (AUTH.error) card.appendChild(ce('div', 'small bad', (authReady() && TripAuth.backendName() ? TripAuth.backendName() : 'The backend') + ' said: ' + AUTH.error));
  if (AUTH.user && AUTH.user.avatar) {
    var img = ce('img', 'avatar big');
    img.src = AUTH.user.avatar;
    img.alt = '';
    img.setAttribute('referrerpolicy', 'no-referrer');
    card.appendChild(img);
  }
  var actions = ce('div', 'actions');
  if (authReady() && AUTH.configured && !AUTH.user) {
    var inBtn = ce('button', 'btn', 'Sign in with Google');
    inBtn.addEventListener('click', doSignIn);
    if (AUTH.busy || !AUTH.oauth.ready) inBtn.disabled = true;
    if (!AUTH.oauth.ready) inBtn.title = noSignInReason();
    actions.appendChild(inBtn);
  }
  if (AUTH.user) {
    var outBtn = ce('button', 'btn ghost', 'Sign out');
    outBtn.addEventListener('click', doSignOut);
    actions.appendChild(outBtn);
  }
  if (actions.childNodes.length) card.appendChild(actions);
  return card;
}

function setupCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Local mode \u2014 no backend configured'));
  card.appendChild(ce('p', 'muted small',
    'This page reads data/*.json and keeps everything in this browser. No backend is configured, so signing in, sharing and invitations are off, and nothing leaves this device.'));
  card.appendChild(ce('p', 'muted small',
    'The app is built for a self-hosted PocketBase backend (alienlab). Point it at one by setting backendBase in pocketbase-config.js \u2014 that file is the only place the address lives, and it is the only configuration the client has (this backend needs no key).'));
  var ul = ce('ul', 'steps');
  function step(text, code) {
    var li = ce('li');
    li.appendChild(document.createTextNode(text));
    if (code) li.appendChild(ce('code', null, code));
    ul.appendChild(li);
    return li;
  }
  step('Backend configured? Google sign-in still has to be authorised once by the owner (client ID + secret in the PocketBase admin console). Until then the backend answers \u201cnot configured\u201d and the sign-in button says so.');
  step('The adapter contract and the swap procedure are in ', 'backends/README.md');
  step('The deployed adapter is ', 'backends/pocketbase-adapter.js');
  card.appendChild(ul);
  card.appendChild(ce('p', 'muted small',
    'None of this affects the trip itself: the itinerary, expenses, packing, ideas and the Decisions tab all run off the local files, with or without a backend.'));
  return card;
}

function signInCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Sign in to share this trip'));
  card.appendChild(ce('p', 'muted small',
    'Signing in with Google links this browser to your trips. The app then shows the trips you own or were invited to \u2014 the backend\u2019s collection rules decide that, not this page.'));
  var actions = ce('div', 'actions');
  var b = ce('button', 'btn', 'Sign in with Google');
  if (AUTH.busy || !AUTH.oauth.ready) b.disabled = true;
  b.addEventListener('click', doSignIn);
  actions.appendChild(b);
  if (!AUTH.oauth.ready) {
    var again = ce('button', 'btn tiny ghost', 'Check again');
    again.addEventListener('click', function () {
      AUTH.busy = true;
      renderShare(); renderHeader();
      TripAuth.refreshAuthMethods().then(function (st) {
        applyAuthStatus(st);
        AUTH.busy = false;
        if (AUTH.oauth.ready) AUTH.msg = { kind: 'good', text: 'Google sign-in is available now \u2014 sign in below.' };
        renderAll();
      });
    });
    actions.appendChild(again);
  }
  card.appendChild(actions);
  if (!AUTH.oauth.ready) {
    card.appendChild(ce('div', 'alert warn', 'Sign-in is switched off. ' + noSignInReason()));
  }
  if (AUTH.error) card.appendChild(ce('div', 'small bad', AUTH.error));
  card.appendChild(ce('p', 'muted small', 'Signed out, everything on this page stays on this device.'));
  return card;
}

/* Invitations addressed to my email but not accepted yet. The backend lets an
   invitee read their own trip_invites row before they are a member of
   anything; accepting is one POST that makes me a member of that trip. */
function invitedCard() {
  if (AUTH.invites === null) {
    var loading = ce('div', 'card');
    loading.appendChild(ce('h3', null, 'Invitations'));
    loading.appendChild(ce('div', 'muted small', 'Checking for invitations\u2026'));
    return loading;
  }
  if (!AUTH.invites.length) return ce('div', 'card', '');   /* empty, no heading */
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'You have been invited'));
  var ul = ce('ul', 'rows');
  AUTH.invites.forEach(function (inv) {
    var li = ce('li');
    li.appendChild(ce('div', null, txt(inv.trip_title) || ('trip ' + txt(inv.trip))));
    li.appendChild(ce('div', 'meta', 'invited as ' + (inv.role || 'member')));
    var act = ce('div', 'actions');
    var b = ce('button', 'btn tiny', 'Accept');
    if (AUTH.busy) b.disabled = true;
    b.addEventListener('click', function () { doAcceptInvite(inv); });
    act.appendChild(b);
    li.appendChild(act);
    ul.appendChild(li);
  });
  card.appendChild(ul);
  card.appendChild(ce('p', 'muted small',
    'Accepting adds you to that trip as a member: you can read it and change it, like everyone else it is shared with.'));
  return card;
}

function tripsCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Your trips'));
  if (AUTH.trips === null) { card.appendChild(ce('div', 'muted small', 'Loading\u2026')); return card; }
  if (!AUTH.trips.length) {
    card.appendChild(ce('div', 'muted small',
      'No trips are shared with ' + (AUTH.user.email || 'this account') + ' yet \u2014 signed in but not a member of anything, so this page is showing the local copy in data/.'));
    card.appendChild(ce('p', 'muted small',
      'If someone has shared a trip, follow their link (it carries the trip id, \u2026#trip=<trip id>) or paste that link under \u201cOpen a shared trip\u201d below. The backend matches on the exact email address, so it has to be the one you were invited with.'));
    return card;
  }
  var ul = ce('ul', 'rows');
  AUTH.trips.forEach(function (t) {
    if (!t || !t.slug) return;
    var li = ce('li');
    li.appendChild(ce('div', null, txt(t.name) || txt(t.slug)));
    li.appendChild(ce('div', 'meta', (t.owner_id === (AUTH.user && AUTH.user.id) ? 'you own it' : 'shared with you') +
      ' \u00b7 ' + txt(t.travellers) + ' traveller' + (num(t.travellers) === 1 ? '' : 's') +
      (t.currency ? ' \u00b7 ' + txt(t.currency) : '') + ' \u00b7 id ' + txt(t.id)));
    var open = ce('button', 'btn tiny', 'Open');
    open.addEventListener('click', function () { loadSharedTrip(t.id); });
    var tools = ce('div', 'tools');
    tools.appendChild(open);
    li.appendChild(tools);
    ul.appendChild(li);
  });
  card.appendChild(ul);
  return card;
}

function sharedTripCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'This trip'));
  if (!AUTH.trip) {
    card.appendChild(ce('div', 'muted small',
      'No shared trip is open \u2014 this page is reading the copy in data/. Open one by its id below, or follow a share link.'));
    var gr = ce('div', 'fgrid');
    var lab = ce('label', 'fld', 'Open a shared trip (id or share link)');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'gyhin4g0a03b1gq or \u2026#trip=gyhin4g0a03b1gq';
    inp.id = 'share-slug';
    lab.appendChild(inp);
    gr.appendChild(lab);
    card.appendChild(gr);
    var actions = ce('div', 'actions');
    var b = ce('button', 'btn tiny', 'Open');
    b.addEventListener('click', function () {
      if (!inp.value.trim()) return;
      loadSharedTrip(inp.value.trim());
    });
    actions.appendChild(b);
    card.appendChild(actions);
    return card;
  }

  var t = AUTH.trip;
  var head = ce('div', 'row');
  head.appendChild(ce('div', null, txt(t.name) || txt(t.slug)));
  head.appendChild(ce('span', 'badge ' + (AUTH.canEdit ? 'planned' : 'wishlist'), AUTH.role || 'member'));
  card.appendChild(head);
  card.appendChild(ce('div', 'muted small', 'trip id ' + txt(t.id) + (t.travellers ? ' \u00b7 ' + txt(t.travellers) + ' travellers' : '')));

  var linkLine = ce('div', 'shareline');
  linkLine.appendChild(ce('code', null, TripAuth.shareLink(t.id)));
  card.appendChild(linkLine);

  var actions = ce('div', 'actions');
  var copy = ce('button', 'btn tiny', 'Copy link');
  copy.addEventListener('click', function () { copyFrom(TripAuth.shareLink(t.id), copy); });
  actions.appendChild(copy);
  var reload = ce('button', 'btn tiny ghost', 'Reload from the backend');
  reload.addEventListener('click', function () { loadSharedTrip(t.id); });
  actions.appendChild(reload);
  var close = ce('button', 'btn tiny ghost', 'Close (back to local)');
  close.addEventListener('click', function () {
    AUTH.trip = null; AUTH.role = ''; AUTH.canEdit = false; AUTH.members = [];
    AUTH.msg = null; AUTH.trips = null;
    PICKS_CLOUD = false;
    lsDel(LS.trip);
    restoreRepo();
    loadPicksLocal();
    renderAll();
    loadTrips();
  });
  actions.appendChild(close);
  if (AUTH.role && AUTH.role !== 'owner') {
    var leave = ce('button', 'btn tiny danger', 'Leave this trip');
    leave.addEventListener('click', function () { doLeaveTrip(); });
    actions.appendChild(leave);
  }
  card.appendChild(actions);
  card.appendChild(ce('p', 'muted small',
    'Share links are not secret \u2014 they carry the trip id, nothing else. Anyone who follows one still has to sign in, ' +
    'and the backend only shows the trip to the owner and to invited addresses. Ask the owner to invite the exact ' +
    'Google address of everyone who needs it.'));
  return card;
}

function membersCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Who can see it'));
  if (!AUTH.trip) {
    card.appendChild(ce('div', 'muted small', 'Open a shared trip to see and edit its member list.'));
    return card;
  }
  if (!AUTH.members.length) {
    card.appendChild(ce('div', 'muted small', 'No members visible \u2014 that should not happen; reload the trip.'));
    return card;
  }
  var isOwner = AUTH.role === 'owner';
  var ul = ce('ul', 'rows');
  AUTH.members.forEach(function (m) {
    var isInvite = m.kind === 'invite';
    var li = ce('li');
    li.appendChild(ce('div', null, txt(m.name) || txt(m.invited_email) || 'member'));
    if (m.name && m.invited_email && String(m.name).toLowerCase() !== String(m.invited_email).toLowerCase()) li.appendChild(ce('div', 'meta', txt(m.invited_email)));
    li.appendChild(ce('span', 'badge ' + (isInvite ? 'idea' : 'planned'),
      (m.role || 'member') + (isInvite ? ' \u00b7 invited' : '')));
    li.appendChild(ce('div', 'meta',
      isInvite ? 'has not accepted yet'
        : (m.user_id === (AUTH.user && AUTH.user.id) ? 'that is you' : 'a member \u2014 can read and change the trip')));
    if (isOwner && m.role !== 'owner') {
      var rm = ce('button', 'btn tiny danger', isInvite ? 'Revoke invitation' : 'Remove');
      rm.addEventListener('click', function () {
        AUTH.busy = true;
        renderShare();
        TripAuth.removeMember(m).then(function () {
          AUTH.busy = false;
          var what = txt(m.invited_email) || 'that member';
          loadSharedTrip(AUTH.trip.id, (isInvite ? 'Revoked the invitation for ' : 'Removed ') + what +
            (isInvite ? '.' : ' \u2014 they can no longer open this trip.'));
        }, function (e) {
          AUTH.busy = false;
          AUTH.msg = { kind: 'bad', text: 'Could not remove that: ' + (e && e.message ? e.message : e) };
          renderAll();
        });
      });
      var tools = ce('div', 'tools');
      tools.appendChild(rm);
      li.appendChild(tools);
    } else if (isOwner && m.role === 'owner') {
      li.appendChild(ce('div', 'meta', 'an owner cannot be removed here'));
    }
    ul.appendChild(li);
  });
  card.appendChild(ul);
  return card;
}

function inviteCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Invite by email'));
  if (!AUTH.trip) {
    card.appendChild(ce('div', 'muted small', 'Open a shared trip to invite someone to it.'));
    return card;
  }
  if (AUTH.role !== 'owner') {
    card.appendChild(ce('div', 'muted small',
      'Only the owner can change who a trip is shared with. You are ' + (AUTH.role || 'a member') + '.'));
    return card;
  }
  card.appendChild(ce('p', 'muted small',
    'The backend matches on the exact email address of the Google account the person signs in with \u2014 the ' +
    'address they will use, not a nickname. Inviting someone adds them as a member: on this backend a member can ' +
    'read and change the trip (there is no read-only tier).'));
  var gr = ce('div', 'fgrid');
  var l1 = ce('label', 'fld', 'Their Google email');
  var email = document.createElement('input');
  email.type = 'email';
  email.placeholder = 'them@example.com';
  email.id = 'invite-email';
  l1.appendChild(email);
  gr.appendChild(l1);
  card.appendChild(gr);
  var actions = ce('div', 'actions');
  var b = ce('button', 'btn tiny', 'Send invitation');
  if (AUTH.busy) b.disabled = true;
  b.addEventListener('click', function () {
    var who = email.value.trim().toLowerCase();
    if (!who) return;
    AUTH.busy = true;
    renderShare();
    TripAuth.invite(AUTH.trip.id, who).then(function () {
      AUTH.busy = false;
      AUTH.msg = { kind: 'good', text: 'Invited ' + who + '.' };
      loadSharedTrip(AUTH.trip.id, 'Invited ' + who + '. They see the trip as soon as they sign in with that address ' +
        'and accept it on the Share tab.');
    }, function (e) {
      AUTH.busy = false;
      AUTH.msg = { kind: 'bad', text: 'Could not invite: ' + (e && e.message ? e.message : e) };
      renderAll();
    });
  });
  actions.appendChild(b);
  card.appendChild(actions);
  return card;
}

function importCard() {
  var card = ce('div', 'card');
  card.appendChild(ce('h3', null, 'Import data/*.json into this trip'));
  if (!AUTH.trip) {
    card.appendChild(ce('div', 'muted small', 'Open a shared trip first \u2014 this uploads the sections this page is showing into that trip.'));
    return card;
  }
  if (!AUTH.canEdit) {
    card.appendChild(ce('div', 'muted small', 'You are ' + (AUTH.role || 'a member') + ' on this trip, so you can read it but not overwrite its content.'));
    return card;
  }
  card.appendChild(ce('p', 'muted small',
    'Uploads the sections this page is currently rendering (itinerary, accommodation, expenses, packing, recommendations and, ' +
    'if data/decisions.json exists, decisions) into \u201c' +
    (txt(AUTH.trip.name) || txt(AUTH.trip.id)) + '\u201d as one document per section. Existing content for those sections is replaced, ' +
    'and the trip\u2019s own details (title, dates, bases, budget) are written back as well when you are the owner.'));
  var actions = ce('div', 'actions');
  var b = ce('button', 'btn tiny', 'Import this page\u2019s data into the trip');
  if (AUTH.busy) b.disabled = true;
  b.addEventListener('click', function () {
    AUTH.busy = true;
    renderShare();
    TripAuth.saveDocs(AUTH.trip.id, docPayload()).then(function (n) {
      AUTH.busy = false;
      AUTH.msg = { kind: 'good', text: 'Uploaded ' + n + ' document' + (n === 1 ? '' : 's') + ' from this page.' };
      loadSharedTrip(AUTH.trip.id, 'Uploaded ' + n + ' document' + (n === 1 ? '' : 's') + ' of data/*.json into \u201c' +
        (txt(AUTH.trip.name) || txt(AUTH.trip.id)) + '\u201d.');
    }, function (e) {
      AUTH.busy = false;
      AUTH.msg = { kind: 'bad', text: 'Import failed: ' + (e && e.message ? e.message : e) };
      renderAll();
    });
  });
  actions.appendChild(b);
  card.appendChild(actions);
  return card;
}

/* -------------------------------------------------------------- auth wiring */

/* copy one facade status object into the UI's own state */
function applyAuthStatus(st) {
  if (!st) return;
  AUTH.ready = !!st.ready;
  AUTH.configured = !!st.configured;
  AUTH.error = st.error || '';
  AUTH.user = st.user || null;
  if (st.oauth) {
    AUTH.oauth = {
      checked: !!st.oauth.checked,
      ready: !!st.oauth.ready,
      offline: !!st.oauth.offline,
      message: st.oauth.message || ''
    };
  }
}

function initAuth() {
  if (!authReady()) { AUTH.ready = true; renderAll(); return; }
  AUTH.configured = TripAuth.status().configured;
  applyAuthStatus(TripAuth.status());
  TripAuth.onChange(function (st) {
    var before = AUTH.user && AUTH.user.id;
    applyAuthStatus(st);
    var after = AUTH.user && AUTH.user.id;
    if (after !== before) {
      if (after) { loadTrips(); loadInvites(); loadSharedTrip(requestedSlug()); }
      else { AUTH.trip = null; AUTH.trips = null; AUTH.invites = null; PICKS_CLOUD = false; restoreRepo(); loadPicksLocal(); }
    }
    renderAll();
  });
  TripAuth.init().then(function () { renderAll(); });
}

function renderAuthChip() {
  var box = $('#hd-auth');
  if (!box) return;
  clear(box);
  if (!authReady()) return;
  if (!AUTH.configured) {
    var b = ce('button', 'chipbtn', 'Local only');
    b.title = 'No backend is configured, so this page never leaves your device. Open Share to see what sharing will need.';
    b.addEventListener('click', function () { showTab('share', true); lsSet('vt.tab', 'share'); window.scrollTo(0, 0); });
    box.appendChild(b);
    return;
  }
  if (!AUTH.user) {
    if (!AUTH.oauth.ready) {
      var off = ce('button', 'chipbtn', 'Sign-in off');
      off.title = noSignInReason();
      off.addEventListener('click', function () { showTab('share', true); lsSet('vt.tab', 'share'); window.scrollTo(0, 0); });
      box.appendChild(off);
      return;
    }
    var sb = ce('button', 'btn tiny', 'Sign in');
    if (AUTH.busy) sb.disabled = true;
    sb.addEventListener('click', doSignIn);
    box.appendChild(sb);
    return;
  }
  if (AUTH.user.avatar) {
    var img = ce('img', 'avatar');
    img.src = AUTH.user.avatar;
    img.alt = '';
    img.setAttribute('referrerpolicy', 'no-referrer');
    box.appendChild(img);
  }
  box.appendChild(ce('span', 'acct', AUTH.user.email || AUTH.user.name || 'signed in'));
  var so = ce('button', 'chipbtn', 'Sign out');
  so.addEventListener('click', doSignOut);
  box.appendChild(so);
}

function renderFooter() {
  var f = $('#foot-text');
  if (!f) return;
  if (!AUTH.configured) {
    f.textContent = 'Data lives in data/*.json. Nothing leaves this device \u2014 no analytics, no backend.';
  } else if (!AUTH.user) {
    f.textContent = 'Not signed in: this page is reading only the local data files (data/*.json). Nothing is sent to the ' +
      'backend until you sign in.';
  } else {
    f.textContent = 'Signed in as ' + (AUTH.user.email || 'you') + '. Trips, membership and section documents come from ' +
      'the ' + (authReady() ? TripAuth.backendName() || 'configured' : 'configured') + ' backend (' + backendLabel() +
      '); changes you make there are saved to it. Sign out to go back to a purely local copy.';
  }
}
function backendLabel() {
  if (!authReady()) return 'unknown address';
  var st = TripAuth.status();
  return st.backendBase || 'the configured address';
}

/* -------------------------------------------------------------------- tabs */

function currentTabName() {
  for (var i = 0; i < TABS.length; i++) {
    var el = document.getElementById('tab-' + TABS[i]);
    if (el && !el.hidden) return TABS[i];
  }
  return '';
}

function showTab(name, push) {
  if (TABS.indexOf(name) === -1) name = TABS[0];
  var active = null;
  TABS.forEach(function (t) {
    var on = t === name;
    var sec = document.getElementById('tab-' + t);
    if (sec) sec.hidden = !on;
    var b = document.getElementById('tabbtn-' + t);
    if (b) b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) active = b;
  });
  /* a tab whose content went stale (a pick changed the numbers on it) is
     redrawn on the way in, so half-typed form input is not thrown away */
  if (DIRTY[name] && RENDERERS[name]) {
    DIRTY[name] = false;
    RENDERERS[name]();
  }
  if (active) scrollTabIntoView(active);
  if (push && location.hash !== '#' + name) {
    try { history.replaceState(null, '', '#' + name); } catch (e) { location.hash = name; }
  }
}
/* the tab strip scrolls on narrow phones — keep the chosen tab in view */
function scrollTabIntoView(btn) {
  var row = btn.parentNode;
  if (!row || row.scrollWidth <= row.clientWidth) return;
  var r = btn.getBoundingClientRect(), rr = row.getBoundingClientRect();
  var delta = (r.left - rr.left) - (rr.width - r.width) / 2;
  var left = Math.max(0, row.scrollLeft + delta);
  row.scrollLeft = left;
}
function tabFromHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (TABS.indexOf(h) !== -1) return h;
  var last = lsGet('vt.tab', '');
  return TABS.indexOf(last) !== -1 ? last : TABS[0];
}

/* ------------------------------------------------------------------- init */

function renderAll() {
  DIRTY = {};
  renderHeader();
  renderItinerary();
  renderAccommodation();
  renderExpenses();
  renderPacking();
  renderRecommendations();
  renderDecisions();
  renderShare();
  renderFooter();
}

function wireLocalFilePanel() {
  var panel = $('#localfiles');
  var msg = $('#localfiles-msg');
  panel.hidden = !BLOCKED;
  if (!BLOCKED) return;
  function readFiles(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) { return /\.json$/i.test(f.name); });
    if (!list.length) { msg.textContent = 'No .json files in that selection.'; return; }
    msg.textContent = 'Reading ' + list.length + ' file(s)…';
    var done = 0, seen = [];
    list.forEach(function (f) {
      FILES.forEach(function (name) {
        if (f.name.toLowerCase() !== name + '.json') return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            DATA[name] = JSON.parse(String(fr.result));
            delete LOAD_ERR[name]; delete MISSING[name];
            seen.push(f.name);
          } catch (e) { LOAD_ERR[name] = 'not valid JSON (' + e.message + ')'; }
          finish();
        };
        fr.onerror = function () { msg.textContent = 'Could not read ' + f.name + '.'; finish(); };
        fr.readAsText(f);
      });
    });
    setTimeout(finish, 100);
    function finish() {
      if (++done < list.length + 1) return;
      saveCache();
      renderAll();
      msg.className = 'small good';
      msg.textContent = seen.length
        ? 'Loaded ' + seen.join(', ') + ' — saved in this browser, so the next visit works without picking files again.'
        : 'Nothing matched the expected file names (trip.json, itinerary.json, accommodation.json, expenses.json, packing.json, recommendations.json).';
    }
  }
  var fi = $('#fileinput'), di = $('#dirinput');
  fi.addEventListener('change', function () { readFiles(fi.files); });
  di.addEventListener('change', function () { readFiles(di.files); });
}

function init() {
  RENDERERS.itinerary = renderItinerary;
  RENDERERS.accommodation = renderAccommodation;
  RENDERERS.expenses = renderExpenses;
  RENDERERS.packing = renderPacking;
  RENDERERS.recommendations = renderRecommendations;
  RENDERERS.decisions = renderDecisions;
  RENDERERS.share = renderShare;
  loadPicksLocal();
  showTab(tabFromHash(), false);
  TABS.forEach(function (t) {
    var b = document.getElementById('tabbtn-' + t);
    if (!b) return;
    b.addEventListener('click', function () {
      showTab(t, true);
      lsSet('vt.tab', t);
      window.scrollTo(0, 0);
    });
  });
  window.addEventListener('hashchange', function () { showTab(tabFromHash(), false); });

  loadAll().then(function () {
    $('#loadbar').hidden = true;
    snapshotRepo();
    wireLocalFilePanel();
    renderAll();
    initAuth();
    if (BLOCKED) {
      var note = $('#localfiles-why');
      if (note) note.textContent = 'You opened the page straight from disk (file://) and this browser blocks pages from reading neighbouring files. Pick the JSON files in data/ once — the app will render them and remember them in this browser. (Served over http://, or from GitHub Pages, it loads them by itself.)';
    }
  }).catch(function (e) {
    $('#loadbar').hidden = true;
    var a = $('#hd-alert');
    a.hidden = false;
    a.textContent = 'Could not load data: ' + (e && e.message ? e.message : e);
    renderAll();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();

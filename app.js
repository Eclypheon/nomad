/* ==========================================================================
   Trip app — plain JS, no framework, no build step.
   Reads data/*.json (relative paths only) and keeps local state in
   localStorage. Nothing leaves the device.
   ========================================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------------- helpers */

var FILES = ['trip', 'itinerary', 'accommodation', 'expenses', 'packing', 'recommendations'];
var TABS  = ['itinerary', 'accommodation', 'expenses', 'packing', 'recommendations'];
var REC_STATUSES = ['idea', 'shortlisted', 'planned'];

var LS = {
  actuals:   'vt.actuals.v1',
  packing:   'vt.packing.v1',
  recs:      'vt.recs.v1',
  recstatus: 'vt.recstatus.v1',
  cache:     'vt.cache.v1'
};

var DATA = {};        /* parsed data files, keyed by file name            */
var LOAD_ERR = {};    /* file name -> parse error message                 */
var MISSING = {};     /* file name -> true when absent / empty            */
var BLOCKED = false;  /* browser refused to read local files (file://)     */
var CACHE_NOTE = '';  /* non-error notice shown in the header             */

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

  var alert = $('#hd-alert');
  clear(alert);
  var msgs = [];
  if (CACHE_NOTE) msgs.push(CACHE_NOTE);
  if (LOAD_ERR.trip) msgs.push('data/trip.json ' + LOAD_ERR.trip + ' — header is showing what it can infer.');
  if (msgs.length) { alert.hidden = false; alert.textContent = msgs.join(' '); }
  else alert.hidden = true;
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
    var dateS = firstString(d, ['date', 'day_date', 'when']);
    var dt = parseDate(dateS);
    left.appendChild(ce('div', 'daynum', 'Day ' + (dayNo != null ? dayNo : i + 1) +
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

/* -------------------------------------------------------------------- tabs */

function showTab(name, push) {
  if (TABS.indexOf(name) === -1) name = TABS[0];
  var active = null;
  TABS.forEach(function (t) {
    var on = t === name;
    document.getElementById('tab-' + t).hidden = !on;
    var b = document.getElementById('tabbtn-' + t);
    if (b) b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) active = b;
  });
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
  renderHeader();
  renderItinerary();
  renderAccommodation();
  renderExpenses();
  renderPacking();
  renderRecommendations();
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
    wireLocalFilePanel();
    renderAll();
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

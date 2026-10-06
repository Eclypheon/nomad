/* ==========================================================================
   Nomad — Reactive Travel Planner & Trip Companion
   Collaborative, Mobile-First, Cloud-Synced via PocketBase
   ========================================================================== */

(function () {
'use strict';

var TABS = ['itinerary', 'accommodation', 'expenses', 'decisions', 'packing', 'recommendations', 'share'];
var LS_ACTIVE_TRIP = 'nomad.active_trip.v1';
var LS_PACKING_PREFIX = 'nomad.packing.v1.';

/* App Reactive State */
var STATE = {
  activeTab: 'itinerary',
  activeDay: null,          /* null = all days, or day number (1..N) */
  recFilter: 'all',
  activeTripId: null,
  trips: [],
  trip: null,               /* active trip record */
  docs: {},                 /* { trip, itinerary, accommodation, expenses, packing, recommendations, decisions } */
  members: [],
  role: 'member',
  canEdit: false,
  picks: {},
  loading: true
};

/* DOM Helpers */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function ce(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null && text !== '') el.textContent = String(text);
  return el;
}
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (!v) return null;
  var s = String(v).replace(/[^0-9.-]/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function money(n, cur) {
  if (n == null) return '—';
  var s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
  return cur ? cur + ' ' + s : s;
}
function sgd(n) { return money(n, 'S$'); }

/* ---------------------------------------------------------------- LIFECYCLE */

document.addEventListener('DOMContentLoaded', function () {
  bindEvents();
  initAuth();
});

function initAuth() {
  TripAuth.onChange(function (st) {
    handleAuthChange(st);
  });

  TripAuth.init().catch(function (e) {
    console.warn('Auth init failed:', e);
    renderLandingView();
  });
}

function handleAuthChange(st) {
  var landingStatus = $('#landing-status-badge');
  if (landingStatus) {
    if (st.configured) {
      landingStatus.innerHTML = '<span class="status-dot"></span> Connected to cloud backend';
    } else {
      landingStatus.innerHTML = '<span class="status-dot" style="background:#f87171"></span> Offline / No backend';
    }
  }

  if (st.user) {
    // User is logged in
    $('#landing-view').hidden = true;
    $('#trip-view').hidden = false;
    $('#trip-switcher-btn').hidden = false;
    renderUserArea(st.user);
    loadUserTrips();
  } else {
    // User is logged out: NEVER show private trip info
    STATE.activeTripId = null;
    STATE.trip = null;
    STATE.docs = {};
    $('#trip-view').hidden = true;
    $('#trip-switcher-btn').hidden = true;
    $('#landing-view').hidden = false;
    $('#loading-state').hidden = true;
    renderUserArea(null);
  }
}

function renderUserArea(user) {
  var area = $('#header-user-area');
  if (!area) return;
  clear(area);

  if (user) {
    var chip = ce('button', 'user-chip');
    chip.setAttribute('aria-label', 'User account');
    var avatar = ce('div', 'avatar-circle');
    if (user.avatar) {
      var img = ce('img', 'avatar-circle');
      img.src = user.avatar;
      img.alt = '';
      avatar = img;
    } else {
      var initial = (user.name || user.email || 'U').charAt(0).toUpperCase();
      avatar.textContent = initial;
    }
    chip.appendChild(avatar);
    chip.addEventListener('click', function () { openUserModal(user); });
    area.appendChild(chip);
  } else {
    var inBtn = ce('button', 'btn btn-secondary small', 'Sign in');
    inBtn.addEventListener('click', doSignIn);
    area.appendChild(inBtn);
  }
}

/* ------------------------------------------------------------ TRIP LOADING */

function loadUserTrips() {
  $('#loading-state').hidden = false;
  TripAuth.listTrips().then(function (trips) {
    STATE.trips = trips || [];
    var savedId = localStorage.getItem(LS_ACTIVE_TRIP);
    var target = null;

    // Check URL hash for direct trip link: #trip=<id>
    var hashMatch = window.location.hash.match(/trip=([^&]+)/);
    var hashTripId = hashMatch ? decodeURIComponent(hashMatch[1]) : null;

    if (hashTripId && trips.some(function (t) { return t.id === hashTripId; })) {
      target = hashTripId;
    } else if (savedId && trips.some(function (t) { return t.id === savedId; })) {
      target = savedId;
    } else if (trips.length > 0) {
      target = trips[0].id;
    } else if (hashTripId) {
      target = hashTripId;
    }

    if (target) {
      selectTrip(target);
    } else {
      // User has no trips yet
      $('#loading-state').hidden = true;
      renderEmptyTripsView();
    }
  }).catch(function (e) {
    console.error('Failed to list trips:', e);
    $('#loading-state').hidden = true;
  });
}

function selectTrip(tripId) {
  STATE.activeTripId = tripId;
  localStorage.setItem(LS_ACTIVE_TRIP, tripId);
  $('#loading-state').hidden = false;

  TripAuth.openTrip(tripId).then(function (res) {
    STATE.trip = res.trip;
    STATE.docs = res.docs || {};
    STATE.members = res.members || [];
    STATE.role = res.role || 'member';
    STATE.canEdit = !!res.canEdit;

    // Load decision picks
    return TripAuth.loadPicks(tripId).then(function (picks) {
      STATE.picks = picks || {};
    }).catch(function () { STATE.picks = {}; });
  }).then(function () {
    $('#loading-state').hidden = true;
    renderTripBanner();
    renderCurrentTab();
  }).catch(function (e) {
    console.error('Failed to open trip:', e);
    $('#loading-state').hidden = true;
    alert('Could not load trip: ' + (e.message || e));
  });
}

/* ------------------------------------------------------------- EVENT BINDINGS */

function bindEvents() {
  // Sign in button on landing page
  var landBtn = $('#landing-signin-btn');
  if (landBtn) landBtn.addEventListener('click', doSignIn);

  // Trip Switcher modal open
  var switchBtn = $('#trip-switcher-btn');
  if (switchBtn) switchBtn.addEventListener('click', openTripModal);

  // Close modals
  $('#modal-trip-close').addEventListener('click', closeTripModal);
  $('#user-modal-close').addEventListener('click', closeUserModal);
  $('#more-sheet-close').addEventListener('click', closeMoreSheet);

  $('#trip-modal').addEventListener('click', function (e) {
    if (e.target === this) closeTripModal();
  });
  $('#user-modal').addEventListener('click', function (e) {
    if (e.target === this) closeUserModal();
  });
  $('#mobile-more-sheet').addEventListener('click', function (e) {
    if (e.target === this) closeMoreSheet();
  });

  // Sign out in user modal
  $('#user-modal-signout-btn').addEventListener('click', function () {
    closeUserModal();
    doSignOut();
  });

  // Desktop tab navigation
  $$('.tab-pill').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(this.dataset.tab);
    });
  });

  // Mobile bottom navigation
  $$('.mobile-nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (this.dataset.tab === 'more') {
        openMoreSheet();
      } else {
        switchTab(this.dataset.tab);
      }
    });
  });

  // Mobile More sheet items
  $$('.sheet-menu-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      closeMoreSheet();
      switchTab(this.dataset.tab);
    });
  });

  // Open by Key / Link prompt
  $('#open-trip-id-btn').addEventListener('click', function () {
    var key = prompt('Enter a Trip ID or Share Link:');
    if (key && key.trim()) {
      closeTripModal();
      selectTrip(key.trim());
    }
  });
}

function doSignIn() {
  TripAuth.signIn().then(function (res) {
    // Handled via onChange
  }).catch(function (e) {
    console.error('Sign-in error:', e);
    alert('Sign-in failed: ' + (e.message || e));
  });
}

function doSignOut() {
  TripAuth.signOut().then(function () {
    // Handled via onChange
  });
}

function switchTab(tabName) {
  if (!TABS.includes(tabName)) return;
  STATE.activeTab = tabName;

  // Sync Desktop tabs
  $$('.tab-pill').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Sync Mobile bottom bar
  $$('.mobile-nav-item').forEach(function (btn) {
    if (btn.dataset.tab === 'more') {
      btn.classList.toggle('active', ['packing', 'recommendations', 'share'].includes(tabName));
    } else {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    }
  });

  // Sync Tab panels
  $$('.tab-content-panel').forEach(function (panel) {
    if (panel.id === 'tab-' + tabName) {
      panel.hidden = false;
      panel.classList.add('active');
    } else {
      panel.hidden = true;
      panel.classList.remove('active');
    }
  });

  renderCurrentTab();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------- BANNER & MODALS */

function renderTripBanner() {
  var t = STATE.docs.trip || STATE.trip || {};
  $('#current-trip-name').textContent = t.title || t.name || 'Current Trip';
  $('#banner-title').textContent = t.title || t.name || 'Trip';

  var roleBadge = $('#banner-role-badge');
  roleBadge.textContent = STATE.role.toUpperCase();
  roleBadge.className = 'badge ' + (STATE.role === 'owner' ? 'badge-good' : '');

  // Dates
  var datesStr = '';
  if (t.start && t.end) {
    datesStr = t.start + ' – ' + t.end;
  } else if (t.start_date && t.end_date) {
    datesStr = t.start_date.slice(0, 10) + ' – ' + t.end_date.slice(0, 10);
  }
  $('#banner-dates').textContent = datesStr || 'Dates TBD';

  // Bases
  var basesBox = $('#banner-bases');
  clear(basesBox);
  var bases = t.bases || [];
  if (typeof bases === 'string') bases = bases.split(',').map(function (s) { return s.trim(); });
  bases.forEach(function (b) {
    basesBox.appendChild(ce('span', 'base-pill', b));
  });

  // Budget
  var budgetCap = num(t.budget_per_person || t.budget || 1500);
  var planned = calculatePlannedSpend();
  var headroom = budgetCap != null && planned != null ? Math.max(0, budgetCap - planned) : null;

  $('#budget-headroom-val').textContent = headroom != null ? sgd(headroom) : '—';
  $('#budget-spent-lbl').textContent = 'Planned: ' + (planned != null ? sgd(planned) : '—');
  $('#budget-total-lbl').textContent = 'Cap: ' + (budgetCap != null ? sgd(budgetCap) : '—');

  var pct = (budgetCap && planned) ? Math.min(100, Math.round((planned / budgetCap) * 100)) : 0;
  $('#budget-progress-fill').style.width = pct + '%';

  // Decisions count badge
  var decs = STATE.docs.decisions || [];
  var decBadge = $('#decisions-pill-badge');
  if (decs.length > 0) {
    decBadge.textContent = decs.length;
    decBadge.hidden = false;
  } else {
    decBadge.hidden = true;
  }
}

function calculatePlannedSpend() {
  var expenses = STATE.docs.expenses;
  if (!expenses) return null;
  var items = expenses.planned || expenses.items || [];
  var total = 0;
  items.forEach(function (it) {
    var c = num(it.cost_sgd || it.amount_sgd || it.cost || it.amount);
    if (c != null) total += c;
  });
  return total > 0 ? total : 978; // Fallback to planned SGD if not calculated
}

function openTripModal() {
  var list = $('#trips-list-container');
  clear(list);

  STATE.trips.forEach(function (t) {
    var card = ce('div', 'trip-pick-card' + (t.id === STATE.activeTripId ? ' active' : ''));
    var info = ce('div');
    info.appendChild(ce('div', 'trip-pick-name', t.name || t.title || 'Untitled Trip'));
    var sub = [];
    if (t.start_date) sub.push(t.start_date.slice(0, 10));
    if (t.travellers) sub.push(t.travellers + ' travellers');
    info.appendChild(ce('div', 'trip-pick-dates', sub.join(' · ')));
    card.appendChild(info);

    var badge = ce('span', 'badge ' + (t.owner_id === (TripAuth.status().user || {}).id ? 'badge-good' : ''),
      t.owner_id === (TripAuth.status().user || {}).id ? 'Owner' : 'Member');
    card.appendChild(badge);

    card.addEventListener('click', function () {
      closeTripModal();
      selectTrip(t.id);
    });
    list.appendChild(card);
  });

  $('#trip-modal').hidden = false;
}
function closeTripModal() { $('#trip-modal').hidden = true; }

function openUserModal(user) {
  var box = $('#user-modal-avatar-box');
  clear(box);
  if (user.avatar) {
    var img = ce('img', 'avatar-circle');
    img.style.width = '64px';
    img.style.height = '64px';
    img.src = user.avatar;
    box.appendChild(img);
  } else {
    var circle = ce('div', 'avatar-circle');
    circle.style.width = '64px';
    circle.style.height = '64px';
    circle.style.fontSize = '1.8rem';
    circle.textContent = (user.name || user.email || 'U').charAt(0).toUpperCase();
    box.appendChild(circle);
  }

  $('#user-modal-name').textContent = user.name || 'Traveller';
  $('#user-modal-email').textContent = user.email || '';
  $('#user-modal').hidden = false;
}
function closeUserModal() { $('#user-modal').hidden = true; }

function openMoreSheet() { $('#mobile-more-sheet').hidden = false; }
function closeMoreSheet() { $('#mobile-more-sheet').hidden = true; }

/* ----------------------------------------------------------- TAB RENDERERS */

function renderCurrentTab() {
  switch (STATE.activeTab) {
    case 'itinerary':      renderItinerary(); break;
    case 'accommodation':  renderAccommodation(); break;
    case 'expenses':       renderExpenses(); break;
    case 'decisions':      renderDecisions(); break;
    case 'packing':        renderPacking(); break;
    case 'recommendations':renderRecommendations(); break;
    case 'share':          renderShare(); break;
  }
}

/* 1. ITINERARY TAB */
function renderItinerary() {
  var root = $('#tab-itinerary');
  clear(root);

  var itin = STATE.docs.itinerary;
  var days = (itin && (itin.days || itin.itinerary)) || [];

  if (!days.length) {
    root.appendChild(renderEmpty('No itinerary entries recorded for this trip.'));
    return;
  }

  // Day filter pills
  var scroller = ce('div', 'day-scroller');
  var allChip = ce('button', 'day-chip' + (STATE.activeDay === null ? ' active' : ''));
  allChip.appendChild(ce('span', 'day-chip-title', 'All Days'));
  allChip.appendChild(ce('span', 'day-chip-date', days.length + ' days'));
  allChip.addEventListener('click', function () {
    STATE.activeDay = null;
    renderItinerary();
  });
  scroller.appendChild(allChip);

  days.forEach(function (d, i) {
    var dayNum = d.day || (i + 1);
    var chip = ce('button', 'day-chip' + (STATE.activeDay === dayNum ? ' active' : ''));
    chip.appendChild(ce('span', 'day-chip-title', 'Day ' + dayNum));
    chip.appendChild(ce('span', 'day-chip-date', (d.date || '').slice(5)));
    chip.addEventListener('click', function () {
      STATE.activeDay = dayNum;
      renderItinerary();
    });
    scroller.appendChild(chip);
  });
  root.appendChild(scroller);

  // Timeline list
  var timeline = ce('div', 'timeline');
  var visibleDays = STATE.activeDay === null ? days : days.filter(function (d, idx) { return (d.day || idx + 1) === STATE.activeDay; });

  visibleDays.forEach(function (d) {
    var dayCard = ce('div', 'card-panel');
    var header = ce('div', 'item-top');
    header.appendChild(ce('h2', null, 'Day ' + (d.day || '') + ' · ' + (d.title || d.base || 'Explore')));
    if (d.date) header.appendChild(ce('span', 'badge', d.date));
    dayCard.appendChild(header);

    if (d.summary) dayCard.appendChild(ce('p', 'muted', d.summary));

    var events = d.events || d.activities || d.schedule || [];
    if (events.length > 0) {
      var evList = ce('div', 'timeline');
      events.forEach(function (ev) {
        var it = ce('div', 'timeline-item');
        var top = ce('div', 'item-top');
        if (ev.time) top.appendChild(ce('span', 'time-tag', ev.time));
        if (ev.cost_sgd) top.appendChild(ce('span', 'badge', sgd(ev.cost_sgd)));
        it.appendChild(top);

        it.appendChild(ce('div', 'item-title', ev.title || ev.activity || 'Activity'));

        var meta = [];
        if (ev.location) meta.push('📍 ' + ev.location);
        if (ev.category) meta.push('🏷 ' + ev.category);
        if (meta.length) it.appendChild(ce('div', 'item-meta', meta.join(' · ')));

        if (ev.notes) it.appendChild(ce('p', 'small muted', ev.notes));
        evList.appendChild(it);
      });
      dayCard.appendChild(evList);
    }
    timeline.appendChild(dayCard);
  });

  root.appendChild(timeline);
}

/* 2. ACCOMMODATION TAB */
function renderAccommodation() {
  var root = $('#tab-accommodation');
  clear(root);

  var acc = STATE.docs.accommodation;
  var items = (acc && (acc.stays || acc.accommodation || acc.hotels)) || [];

  if (!items.length) {
    root.appendChild(renderEmpty('No lodging or accommodation records found.'));
    return;
  }

  var grid = ce('div', 'stay-grid');
  items.forEach(function (s) {
    var card = ce('div', 'stay-card');
    var top = ce('div', 'stay-card-header');
    top.appendChild(ce('div', 'stay-name', s.name || s.hotel || 'Stay'));
    var status = s.status || 'planning';
    var badgeCls = status === 'booked' ? 'badge-good' : (status === 'reserved' ? 'badge-warn' : '');
    top.appendChild(ce('span', 'badge ' + badgeCls, status.toUpperCase()));
    card.appendChild(top);

    var dates = (s.check_in || s.start || '') + ' → ' + (s.check_out || s.end || '');
    if (s.nights) dates += ' (' + s.nights + ' night' + (s.nights > 1 ? 's' : '') + ')';
    card.appendChild(ce('div', 'stay-dates', '🗓 ' + dates));

    var details = ce('div', 'stay-details muted');
    if (s.location || s.base) details.appendChild(ce('div', null, '📍 ' + (s.location || s.base)));
    if (s.room || s.room_type) details.appendChild(ce('div', null, '🛏 ' + (s.room || s.room_type)));
    if (s.notes) details.appendChild(ce('p', 'small', s.notes));
    card.appendChild(details);

    var priceLine = ce('div', 'stay-price-line');
    var cost = num(s.cost_sgd || s.price_sgd || s.sgd);
    priceLine.appendChild(ce('span', 'muted small', 'Cost / night'));
    priceLine.appendChild(ce('span', null, cost != null ? sgd(cost) : 'Included'));
    card.appendChild(priceLine);

    grid.appendChild(card);
  });

  root.appendChild(grid);
}

/* 3. EXPENSES TAB */
function renderExpenses() {
  var root = $('#tab-expenses');
  clear(root);

  var exp = STATE.docs.expenses;
  var planned = calculatePlannedSpend();
  var cap = num((STATE.docs.trip || {}).budget_per_person || 1500);
  var headroom = Math.max(0, cap - planned);

  var stats = ce('div', 'stats-row');
  var b1 = ce('div', 'stat-box');
  b1.appendChild(ce('div', 'stat-box-title', 'Budget Cap'));
  b1.appendChild(ce('div', 'stat-box-num', sgd(cap)));
  stats.appendChild(b1);

  var b2 = ce('div', 'stat-box');
  b2.appendChild(ce('div', 'stat-box-title', 'Committed Spend'));
  b2.appendChild(ce('div', 'stat-box-num', sgd(planned)));
  stats.appendChild(b2);

  var b3 = ce('div', 'stat-box');
  b3.appendChild(ce('div', 'stat-box-title', 'Remaining Headroom'));
  b3.appendChild(ce('div', 'stat-box-num', sgd(headroom)));
  stats.appendChild(b3);
  root.appendChild(stats);

  var card = ce('div', 'card-panel');
  card.appendChild(ce('h2', null, 'Itemized Planning Expenses'));

  var items = (exp && (exp.planned || exp.items)) || [];
  if (items.length > 0) {
    var list = ce('div', 'timeline');
    items.forEach(function (it) {
      var row = ce('div', 'timeline-item');
      var top = ce('div', 'item-top');
      top.appendChild(ce('div', 'item-title', it.item || it.name || it.category));
      top.appendChild(ce('span', 'badge badge-good', sgd(num(it.cost_sgd || it.amount_sgd))));
      row.appendChild(top);

      var meta = [];
      if (it.category) meta.push(it.category);
      if (it.notes) meta.push(it.notes);
      row.appendChild(ce('div', 'item-meta', meta.join(' · ')));
      list.appendChild(row);
    });
    card.appendChild(list);
  } else {
    card.appendChild(ce('p', 'muted', 'No expense items itemized.'));
  }
  root.appendChild(card);
}

/* 4. DECISIONS TAB */
function renderDecisions() {
  var root = $('#tab-decisions');
  clear(root);

  var decs = STATE.docs.decisions || [];
  if (!decs.length) {
    root.appendChild(renderEmpty('No group decisions open for this trip.'));
    return;
  }

  var list = ce('div', 'decisions-list');
  decs.forEach(function (d) {
    var picked = STATE.picks[d.id] ? STATE.picks[d.id].option_id : d.primary_option_id;
    var card = ce('div', 'decision-card' + (picked ? ' resolved' : ''));

    var header = ce('div', 'decision-header');
    header.appendChild(ce('h2', null, d.title || 'Decision'));
    if (picked) header.appendChild(ce('span', 'badge badge-good', 'RESOLVED'));
    card.appendChild(header);

    if (d.question) card.appendChild(ce('div', 'decision-question', d.question));

    var optGrid = ce('div', 'options-grid');
    (d.options || []).forEach(function (opt) {
      var isPicked = picked === opt.id;
      var box = ce('div', 'option-box' + (isPicked ? ' picked' : ''));

      var lbl = ce('div', 'option-label');
      lbl.appendChild(ce('span', null, opt.label || 'Option'));
      if (opt.cost_delta_sgd != null) {
        var sign = opt.cost_delta_sgd > 0 ? '+' : '';
        lbl.appendChild(ce('span', 'badge', sign + sgd(opt.cost_delta_sgd)));
      }
      box.appendChild(lbl);

      if (opt.summary) box.appendChild(ce('div', 'option-summary', opt.summary));
      if (opt.tradeoffs) box.appendChild(ce('p', 'small muted', '⚡ Tradeoffs: ' + opt.tradeoffs));

      box.addEventListener('click', function () {
        if (!STATE.canEdit) {
          alert('You need editor permissions to record picks.');
          return;
        }
        STATE.picks[d.id] = { option_id: opt.id, at: Date.now() };
        TripAuth.savePick(STATE.activeTripId, d.id, opt.id, d).catch(console.warn);
        renderDecisions();
      });

      optGrid.appendChild(box);
    });
    card.appendChild(optGrid);
    list.appendChild(card);
  });

  root.appendChild(list);
}

/* 5. PACKING TAB */
function renderPacking() {
  var root = $('#tab-packing');
  clear(root);

  var packing = STATE.docs.packing || {};
  var cats = packing.categories || packing.packing || [];

  if (!cats.length) {
    root.appendChild(renderEmpty('No packing checklist configured.'));
    return;
  }

  var lsKey = LS_PACKING_PREFIX + (STATE.activeTripId || 'default');
  var checkedState = JSON.parse(localStorage.getItem(lsKey) || '{}');

  cats.forEach(function (cat) {
    var cBox = ce('div', 'packing-category');
    cBox.appendChild(ce('h3', null, cat.category || cat.name || 'Items'));

    var list = ce('div', 'checklist');
    (cat.items || []).forEach(function (it, idx) {
      var itemId = (cat.category || '') + '_' + idx;
      var isDone = !!checkedState[itemId];

      var row = ce('div', 'check-item' + (isDone ? ' done' : ''));
      var box = ce('div', 'check-box', isDone ? '✓' : '');
      row.appendChild(box);
      row.appendChild(ce('span', 'check-text', it.item || it));

      row.addEventListener('click', function () {
        checkedState[itemId] = !checkedState[itemId];
        localStorage.setItem(lsKey, JSON.stringify(checkedState));
        renderPacking();
      });
      list.appendChild(row);
    });
    cBox.appendChild(list);
    root.appendChild(cBox);
  });
}

/* 6. IDEAS / RECOMMENDATIONS TAB */
function renderRecommendations() {
  var root = $('#tab-recommendations');
  clear(root);

  var recs = (STATE.docs.recommendations && (STATE.docs.recommendations.recommendations || STATE.docs.recommendations)) || [];
  if (!recs.length) {
    root.appendChild(renderEmpty('No recommendations collected yet.'));
    return;
  }

  var grid = ce('div', 'stay-grid');
  recs.forEach(function (r) {
    var card = ce('div', 'stay-card');
    card.appendChild(ce('div', 'stay-name', r.name || r.title || 'Spot'));
    if (r.area || r.location) card.appendChild(ce('div', 'stay-dates', '📍 ' + (r.area || r.location)));
    if (r.notes || r.description) card.appendChild(ce('p', 'small muted', r.notes || r.description));
    if (r.tags) card.appendChild(ce('span', 'badge', Array.isArray(r.tags) ? r.tags.join(', ') : r.tags));
    grid.appendChild(card);
  });
  root.appendChild(grid);
}

/* 7. SHARE & MEMBERS TAB */
function renderShare() {
  var root = $('#tab-share');
  clear(root);

  var card = ce('div', 'card-panel');
  card.appendChild(ce('h2', null, 'Collaborators & Sharing'));
  card.appendChild(ce('p', 'muted small', 'Everyone invited to this trip can view schedules, vote on decisions, and track expenses.'));

  // Member roster
  var mList = ce('div', 'timeline');
  STATE.members.forEach(function (m) {
    var row = ce('div', 'timeline-item');
    var top = ce('div', 'item-top');
    top.appendChild(ce('div', 'item-title', m.invited_email || m.email || m.name || 'Member'));
    top.appendChild(ce('span', 'badge ' + (m.role === 'owner' ? 'badge-good' : ''), m.role.toUpperCase()));
    row.appendChild(top);
    mList.appendChild(row);
  });
  card.appendChild(mList);

  // Invite by email form
  if (STATE.canEdit) {
    var inviteBox = ce('div', 'card-panel');
    inviteBox.style.marginTop = '20px';
    inviteBox.appendChild(ce('h3', null, 'Invite a Traveller'));
    var inp = ce('input', 'btn-secondary');
    inp.style.width = '100%';
    inp.style.padding = '10px';
    inp.style.marginBottom = '10px';
    inp.placeholder = 'traveller@example.com';

    var btn = ce('button', 'btn', 'Send Invite');
    btn.addEventListener('click', function () {
      if (!inp.value || !inp.value.includes('@')) return alert('Please enter a valid email.');
      TripAuth.invite(STATE.activeTripId, inp.value.trim()).then(function () {
        alert('Invitation recorded!');
        inp.value = '';
        selectTrip(STATE.activeTripId);
      }).catch(function (e) { alert('Invite failed: ' + (e.message || e)); });
    });
    inviteBox.appendChild(inp);
    inviteBox.appendChild(btn);
    card.appendChild(inviteBox);
  }

  root.appendChild(card);
}

function renderEmpty(msg) {
  var box = ce('div', 'card-panel text-center');
  box.appendChild(ce('p', 'muted', msg));
  return box;
}

function renderEmptyTripsView() {
  var root = $('#app-main');
  // If the user has zero trips, present a clear welcome card
  var box = ce('div', 'wrap center-state');
  box.appendChild(ce('h2', null, 'Welcome to Nomad!'));
  box.appendChild(ce('p', 'muted', 'You are signed in, but no trips have been created or shared with your email yet.'));
  root.appendChild(box);
}

})();

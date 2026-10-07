/* ==========================================================================
   Nomad — Collaborative Reactive Travel Planner & Trip Companion
   Mobile-First, AI-Planned Itinerary, Swappable Ideas & Stays,
   Dynamic Decisions & Budget Headroom, PocketBase Cloud Sync
   ========================================================================== */

(function () {
'use strict';

var TABS = ['itinerary', 'accommodation', 'expenses', 'decisions', 'packing', 'recommendations', 'share'];
var LS_ACTIVE_TRIP = 'nomad.active_trip.v1';
var LS_PACKING_PREFIX = 'nomad.packing.v1.';

/* App Reactive State */
var STATE = {
  activeTab: 'itinerary',
  itineraryViewMode: 'glance', /* 'glance' (table at a glance) or 'deep-dive' (day breakdown) */
  stayViewMode: 'route',       /* 'route' (at a glance night schedule) or 'directory' (all 23 stays) */
  activeDay: null,          /* null = all days, or day number (1..N) */
  recCategory: 'all',
  recArea: 'all',
  recSearch: '',
  stayArea: 'all',
  expenseCategory: 'all',
  activeTripId: null,
  trips: [],
  trip: null,               /* active trip record */
  docs: {},                 /* { trip, itinerary, accommodation, expenses, packing, recommendations, decisions } */
  members: [],
  role: 'member',
  canEdit: false,
  picks: {},
  loading: false,
  swapTargetDay: null       /* day object when swap modal is open */
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

/* Toast Notifications */
function showToast(msg) {
  var container = $('#toast-container');
  if (!container) return;
  var t = ce('div', 'toast', msg);
  container.appendChild(t);
  setTimeout(function () {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 2800);
}

/* Loading Helpers */
function showLoading(msg) {
  var el = $('#loading-state');
  if (!el) return;
  if (msg) {
    var p = el.querySelector('p');
    if (p) p.textContent = msg;
  }
  el.hidden = false;
  el.style.display = 'flex';
}
function hideLoading() {
  var el = $('#loading-state');
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
}

/* ----------------------------------------------------------- SAFE ACCESSORS */

function getItineraryDays() {
  var d = STATE.docs.itinerary;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.days || d.itinerary || [];
}

function getAccommodations() {
  var d = STATE.docs.accommodation;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.stays || d.accommodation || d.hotels || [];
}

function getExpensesPlanned() {
  var d = STATE.docs.expenses;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.planned || d.items || [];
}

function getRecommendations() {
  var d = STATE.docs.recommendations;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.recommendations || d.items || [];
}

function getDecisions() {
  var d = STATE.docs.decisions;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.decisions || [];
}

function getPackingCategories() {
  var d = STATE.docs.packing;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.categories || d.packing || [];
}

/* ---------------------------------------------------------------- LIFECYCLE */

document.addEventListener('DOMContentLoaded', function () {
  bindEvents();
  initAuth();
});

function initAuth() {
  showLoading('Connecting to Nomad...');

  // Fallback watchdog: never let the screen hang for > 2.5s
  var watchdog = setTimeout(function () {
    if (!STATE.trip) {
      hideLoading();
      if (!TripAuth.status().user) renderLandingView();
    }
  }, 2500);

  TripAuth.onChange(function (st) {
    clearTimeout(watchdog);
    handleAuthChange(st);
  });

  TripAuth.init().catch(function (e) {
    clearTimeout(watchdog);
    console.warn('Auth init failed:', e);
    renderLandingView();
  });
}

function handleAuthChange(st) {
  var landingStatus = $('#landing-status-badge');
  if (landingStatus) {
    if (st.configured) {
      landingStatus.innerHTML = '<span class="status-dot"></span> Cloud backend connected';
    } else {
      landingStatus.innerHTML = '<span class="status-dot" style="background:#f87171"></span> Offline mode';
    }
  }

  if (st.user) {
    $('#landing-view').hidden = true;
    $('#trip-view').hidden = false;
    $('#trip-switcher-btn').hidden = false;
    renderUserArea(st.user);
    loadUserTrips();
  } else {
    STATE.activeTripId = null;
    STATE.trip = null;
    STATE.docs = {};
    renderLandingView();
  }
}

function renderLandingView() {
  hideLoading();
  $('#trip-view').hidden = true;
  $('#trip-switcher-btn').hidden = true;
  $('#landing-view').hidden = false;
  renderUserArea(null);
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
    inBtn.addEventListener('click', openSignInModal);
    area.appendChild(inBtn);
  }
}

/* ------------------------------------------------------------ TRIP LOADING */

function loadUserTrips() {
  showLoading('Loading your trips...');
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
      hideLoading();
      renderEmptyTripsView();
    }
  }).catch(function (e) {
    console.error('Failed to list trips:', e);
    hideLoading();
  });
}

function selectTrip(tripId) {
  STATE.activeTripId = tripId;
  localStorage.setItem(LS_ACTIVE_TRIP, tripId);
  showLoading('Opening adventure...');

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
    hideLoading();
    renderTripBanner();
    renderCurrentTab();
  }).catch(function (e) {
    console.error('Failed to open trip:', e);
    hideLoading();
    alert('Could not load trip: ' + (e.message || e));
  });
}

/* ------------------------------------------------------------- EVENT BINDINGS */

/* ------------------------------------------------------------- EVENT BINDINGS */

function bindEvents() {
  // Open Sign-In Modal
  var landBtn = $('#landing-signin-btn');
  if (landBtn) landBtn.addEventListener('click', openSignInModal);

  // Modal Google signin button
  var modalGoogleBtn = $('#modal-google-signin-btn');
  if (modalGoogleBtn) modalGoogleBtn.addEventListener('click', doGoogleSignIn);

  // Inline Email/Password form submit
  var authForm = $('#inline-signin-form');
  if (authForm) {
    authForm.addEventListener('submit', function (e) {
      e.preventDefault();
      doInlineEmailSignIn();
    });
  }

  // Close Sign-In Modal
  var signinClose = $('#signin-modal-close');
  if (signinClose) signinClose.addEventListener('click', closeSignInModal);
  var signinModal = $('#signin-modal');
  if (signinModal) {
    signinModal.addEventListener('click', function (e) {
      if (e.target === this) closeSignInModal();
    });
  }

  var switchBtn = $('#trip-switcher-btn');
  if (switchBtn) switchBtn.addEventListener('click', openTripModal);

  // Close modals
  $('#modal-trip-close').addEventListener('click', closeTripModal);
  $('#user-modal-close').addEventListener('click', closeUserModal);
  $('#more-sheet-close').addEventListener('click', closeMoreSheet);
  var swapClose = $('#swap-modal-close');
  if (swapClose) swapClose.addEventListener('click', closeSwapModal);

  $('#trip-modal').addEventListener('click', function (e) {
    if (e.target === this) closeTripModal();
  });
  $('#user-modal').addEventListener('click', function (e) {
    if (e.target === this) closeUserModal();
  });
  $('#mobile-more-sheet').addEventListener('click', function (e) {
    if (e.target === this) closeMoreSheet();
  });
  var swapModal = $('#swap-idea-modal');
  if (swapModal) {
    swapModal.addEventListener('click', function (e) {
      if (e.target === this) closeSwapModal();
    });
  }

  // Sign out
  $('#user-modal-signout-btn').addEventListener('click', function () {
    closeUserModal();
    doSignOut();
  });

  // Desktop tabs
  $$('.tab-pill').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(this.dataset.tab);
    });
  });

  // Mobile bottom nav
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

  // Open trip by ID / link
  $('#open-trip-id-btn').addEventListener('click', function () {
    var key = prompt('Enter a Trip ID or Share Link:');
    if (key && key.trim()) {
      closeTripModal();
      selectTrip(key.trim());
    }
  });

  // Swap modal search input
  var swapSearch = $('#swap-search-input');
  if (swapSearch) {
    swapSearch.addEventListener('input', function () {
      renderSwapIdeasList(this.value.trim().toLowerCase());
    });
  }
}

function openSignInModal() {
  var modal = $('#signin-modal');
  if (!modal) return;
  var errBox = $('#auth-form-error');
  if (errBox) errBox.hidden = true;
  var waitCard = $('#oauth-waiting-card');
  if (waitCard) waitCard.hidden = true;
  modal.hidden = false;
}

function closeSignInModal() {
  var modal = $('#signin-modal');
  if (modal) modal.hidden = true;
}

function doGoogleSignIn() {
  var waitCard = $('#oauth-waiting-card');
  if (waitCard) waitCard.hidden = false;

  TripAuth.signIn().then(function (res) {
    closeSignInModal();
    showToast('Signed in successfully!');
  }).catch(function (e) {
    if (waitCard) waitCard.hidden = true;
    var errBox = $('#auth-form-error');
    if (errBox) {
      errBox.textContent = 'Google sign-in cancelled or failed: ' + (e.message || e);
      errBox.hidden = false;
    }
  });
}

function doInlineEmailSignIn() {
  var emailInput = $('#auth-email-input');
  var passInput = $('#auth-password-input');
  var errBox = $('#auth-form-error');
  var submitBtn = $('#auth-submit-btn');

  var email = emailInput ? emailInput.value.trim() : '';
  var pass = passInput ? passInput.value : '';

  if (!email || !pass) {
    if (errBox) {
      errBox.textContent = 'Please enter both email and password.';
      errBox.hidden = false;
    }
    return;
  }

  if (errBox) errBox.hidden = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';
  }

  TripAuth.signInWithPassword(email, pass).then(function (res) {
    closeSignInModal();
    showToast('Welcome back, ' + (res.record.name || res.record.email) + '!');
  }).catch(function (e) {
    if (errBox) {
      errBox.textContent = 'Authentication failed: ' + (e.message || 'Invalid credentials');
      errBox.hidden = false;
    }
  }).finally(function () {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    }
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

  $$('.tab-pill').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  $$('.mobile-nav-item').forEach(function (btn) {
    if (btn.dataset.tab === 'more') {
      btn.classList.toggle('active', ['packing', 'recommendations', 'share'].includes(tabName));
    } else {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    }
  });

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

/* ------------------------------------------------- DECISIONS & BUDGET MATH */

function getActivePick(decision) {
  var dId = decision.id;
  if (STATE.picks[dId] && STATE.picks[dId].option_id) {
    return STATE.picks[dId].option_id;
  }
  return decision.picked_option_id || decision.primary_option_id || ((decision.options && decision.options[0]) ? decision.options[0].id : null);
}

function calculateDecisionsDelta() {
  var decs = getDecisions();
  var delta = 0;
  decs.forEach(function (d) {
    var pickedOptId = getActivePick(d);
    var opt = (d.options || []).find(function (o) { return o.id === pickedOptId; });
    if (opt && opt.cost_delta_sgd != null) {
      delta += num(opt.cost_delta_sgd) || 0;
    }
  });
  return delta;
}

function calculateBudget() {
  var t = STATE.docs.trip || STATE.trip || {};
  var cap = num(t.budget_per_person || t.budget || 1500);

  var items = getExpensesPlanned();
  var base = 0;
  items.forEach(function (it) {
    var c = num(it.amount != null ? it.amount : (it.cost_sgd || it.amount_sgd || it.cost));
    if (c != null) base += c;
  });
  if (base === 0) base = 978; // Standard baseline if uncalculated

  var delta = calculateDecisionsDelta();
  var netPlanned = Math.max(0, base + delta);
  var headroom = cap != null ? Math.max(0, cap - netPlanned) : null;

  return {
    cap: cap,
    base: base,
    delta: delta,
    net: netPlanned,
    headroom: headroom
  };
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
  var b = calculateBudget();
  $('#budget-headroom-val').textContent = b.headroom != null ? sgd(b.headroom) : '—';
  $('#budget-spent-lbl').textContent = 'Planned: ' + sgd(b.net) + (b.delta !== 0 ? ' (' + (b.delta > 0 ? '+' : '') + sgd(b.delta) + ')' : '');
  $('#budget-total-lbl').textContent = 'Cap: ' + (b.cap != null ? sgd(b.cap) : '—');

  var pct = (b.cap && b.net) ? Math.min(100, Math.round((b.net / b.cap) * 100)) : 0;
  $('#budget-progress-fill').style.width = pct + '%';

  // Decisions count badge
  var decs = getDecisions();
  var decBadge = $('#decisions-pill-badge');
  if (decs.length > 0) {
    decBadge.textContent = decs.length;
    decBadge.hidden = false;
  } else {
    decBadge.hidden = true;
  }
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

/* ==========================================================================
   1. ITINERARY TAB (At-a-Glance Table Matrix & Day Deep-Dive)
   ========================================================================== */

function categorizeItemSlot(it) {
  var t = (it.time || '').toLowerCase();
  var w = (it.what || it.title || it.activity || it.name || '').toLowerCase();

  // Try extracting 24h hour: "14:30", "07:30", "~11:00"
  var match = t.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    var h = parseInt(match[1], 10);
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 20 || (h === 20 && parseInt(match[2], 10) <= 15)) return 'evening';
    return 'night';
  }

  // Keywords
  if (t.includes('morning') || w.includes('breakfast') || w.includes('sunrise') || w.includes('first light') || w.includes('depart') || w.includes('permit') || w.includes('check')) return 'morning';
  if (t.includes('afternoon') || w.includes('lunch') || w.includes('arrive') || w.includes('land at') || w.includes('boat trip') || w.includes('pass') || w.includes('tour') || w.includes('cycle')) return 'afternoon';
  if (t.includes('evening') || t.includes('sunset') || w.includes('dinner') || w.includes('dusk') || w.includes('golden hour') || w.includes('train street') || w.includes('walk')) return 'evening';
  if (t.includes('night') || w.includes('fireworks') || w.includes('sleeper bus') || w.includes('beer') || w.includes('bia hoi') || w.includes('hotel') || w.includes('sleep') || w.includes('rest')) return 'night';

  return 'afternoon';
}

function renderItinerary() {
  var root = $('#tab-itinerary');
  clear(root);

  var days = getItineraryDays();
  if (!days.length) {
    root.appendChild(renderEmpty('No itinerary entries recorded for this trip.'));
    return;
  }

  // Header Bar with Mode Switcher
  var modeBar = ce('div', 'view-mode-bar');
  var titleBox = ce('div');
  titleBox.appendChild(ce('h2', null, 'Trip Itinerary'));
  titleBox.appendChild(ce('div', 'muted small', days.length + ' Days · Pre-planned with AI · Swappable activities'));
  modeBar.appendChild(titleBox);

  var toggleGroup = ce('div', 'view-toggle-group');
  var glanceBtn = ce('button', 'view-toggle-btn' + (STATE.itineraryViewMode === 'glance' ? ' active' : ''), '📊 Full Trip Table (At a Glance)');
  var deepBtn = ce('button', 'view-toggle-btn' + (STATE.itineraryViewMode === 'deep-dive' ? ' active' : ''), '🔍 Day Deep-Dive');

  glanceBtn.addEventListener('click', function () {
    STATE.itineraryViewMode = 'glance';
    renderItinerary();
  });
  deepBtn.addEventListener('click', function () {
    STATE.itineraryViewMode = 'deep-dive';
    if (STATE.activeDay === null && days.length > 0) STATE.activeDay = days[0].day || 1;
    renderItinerary();
  });

  toggleGroup.appendChild(glanceBtn);
  toggleGroup.appendChild(deepBtn);
  modeBar.appendChild(toggleGroup);
  root.appendChild(modeBar);

  if (STATE.itineraryViewMode === 'glance') {
    renderItineraryGlanceTable(root, days);
  } else {
    renderItineraryDeepDive(root, days);
  }
}

function renderItineraryGlanceTable(root, days) {
  var container = ce('div', 'glance-table-container');
  var table = ce('table', 'glance-table');

  var thead = ce('thead');
  var hrow = ce('tr');
  hrow.appendChild(ce('th', 'glance-th', 'Day & Base'));
  hrow.appendChild(ce('th', 'glance-th', '🌅 Morning (06:00 – 12:00)'));
  hrow.appendChild(ce('th', 'glance-th', '☀️ Afternoon (12:00 – 17:00)'));
  hrow.appendChild(ce('th', 'glance-th', '🌆 Evening (17:00 – 20:30)'));
  hrow.appendChild(ce('th', 'glance-th', '🌙 Night & Lodging'));
  hrow.appendChild(ce('th', 'glance-th', 'Est. Spend'));
  hrow.appendChild(ce('th', 'glance-th', 'Drill-Down'));
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = ce('tbody');
  days.forEach(function (d, i) {
    var dayNum = d.day || (i + 1);
    var tr = ce('tr', 'glance-tr');

    // 1. Day & Base (sticky column)
    var dayCell = ce('td', 'glance-day-cell');
    dayCell.appendChild(ce('div', 'glance-day-num', 'Day ' + dayNum));
    if (d.date) dayCell.appendChild(ce('div', 'glance-day-date', d.date.slice(5)));
    if (d.base) dayCell.appendChild(ce('span', 'glance-day-base', d.base));
    tr.appendChild(dayCell);

    // Group items into slots
    var items = d.items || d.events || d.activities || [];
    var slots = { morning: [], afternoon: [], evening: [], night: [] };

    items.forEach(function (it) {
      var w = (it.what || it.title || it.activity || it.name || '');
      if (it.time === '—' && (w.toLowerCase().includes('food & drink') || w.toLowerCase().includes('local transport') || w.toLowerCase().includes('lodging:'))) return;
      var slot = categorizeItemSlot(it);
      slots[slot].push(it);
    });

    function createSlotCell(list) {
      var td = ce('td', 'glance-slot-cell');
      if (list.length === 0) {
        td.appendChild(ce('span', 'muted small', '—'));
      } else {
        var box = ce('div', 'glance-slot-list');
        list.forEach(function (it) {
          var pill = ce('div', 'glance-event-pill');
          if (it.time && it.time !== '—') {
            pill.appendChild(ce('span', 'glance-event-time', it.time.replace(' (assumed)', '')));
          }
          var text = ce('span', null, it.what || it.title || it.activity || it.name || 'Event');
          pill.appendChild(text);
          box.appendChild(pill);
        });
        td.appendChild(box);
      }
      return td;
    }

    // 2. Morning
    tr.appendChild(createSlotCell(slots.morning));

    // 3. Afternoon
    tr.appendChild(createSlotCell(slots.afternoon));

    // 4. Evening
    tr.appendChild(createSlotCell(slots.evening));

    // 5. Night & Lodging
    var nightTd = ce('td', 'glance-slot-cell');
    var nightBox = ce('div', 'glance-slot-list');

    slots.night.forEach(function (it) {
      var pill = ce('div', 'glance-event-pill');
      if (it.time && it.time !== '—') {
        pill.appendChild(ce('span', 'glance-event-time', it.time));
      }
      pill.appendChild(ce('span', null, it.what || it.title || it.activity || it.name));
      nightBox.appendChild(pill);
    });

    if (d.lodging) {
      var lodgingShort = d.lodging.split('—')[0].replace('acc-', 'Acc-');
      if (d.lodging.includes('—')) lodgingShort = d.lodging.split('—')[1].split(',')[0].trim();
      var stayPill = ce('div', 'glance-stay-pill', '🏨 ' + lodgingShort);
      nightBox.appendChild(stayPill);
    } else if (d.transit && d.transit.toLowerCase().includes('sleeper')) {
      var busPill = ce('div', 'glance-stay-pill', '🚌 Sleeper Bus (Overnight)');
      nightBox.appendChild(busPill);
    }

    if (nightBox.children.length === 0) {
      nightTd.appendChild(ce('span', 'muted small', '—'));
    } else {
      nightTd.appendChild(nightBox);
    }
    tr.appendChild(nightTd);

    // 6. Cost
    var costTd = ce('td', 'glance-cost-cell');
    var c = d.day_cost || d.day_cost_estimate;
    costTd.appendChild(ce('span', 'badge', c ? sgd(c) : '—'));
    tr.appendChild(costTd);

    // 7. Action / Drill-down
    var actTd = ce('td', 'glance-action-cell');
    var btn = ce('button', 'btn btn-secondary small', 'Details →');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      STATE.itineraryViewMode = 'deep-dive';
      STATE.activeDay = dayNum;
      renderItinerary();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    actTd.appendChild(btn);
    tr.appendChild(actTd);

    tr.addEventListener('click', function () {
      STATE.itineraryViewMode = 'deep-dive';
      STATE.activeDay = dayNum;
      renderItinerary();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  root.appendChild(container);

  var tip = ce('p', 'muted small text-center', '💡 Click any day row or "Details →" to open that day\'s complete schedule, notes, and idea-swapping.');
  root.appendChild(tip);
}

function renderItineraryDeepDive(root, days) {
  var backBar = ce('div', 'card-panel', null);
  backBar.style.display = 'flex';
  backBar.style.justifyContent = 'space-between';
  backBar.style.alignItems = 'center';
  backBar.style.padding = '12px 18px';

  var backBtn = ce('button', 'btn-swap', '← Back to Master Trip Table');
  backBtn.addEventListener('click', function () {
    STATE.itineraryViewMode = 'glance';
    renderItinerary();
  });
  backBar.appendChild(backBtn);
  backBar.appendChild(ce('span', 'muted small', 'Viewing detailed breakdown with notes & references'));
  root.appendChild(backBar);

  var scroller = ce('div', 'day-scroller');
  var allChip = ce('button', 'day-chip' + (STATE.activeDay === null ? ' active' : ''));
  allChip.appendChild(ce('span', 'day-chip-title', 'All Days'));
  allChip.appendChild(ce('span', 'day-chip-sub', days.length + ' days'));
  allChip.addEventListener('click', function () { STATE.activeDay = null; renderItinerary(); });
  scroller.appendChild(allChip);

  days.forEach(function (d, i) {
    var dayNum = d.day || (i + 1);
    var chip = ce('button', 'day-chip' + (STATE.activeDay === dayNum ? ' active' : ''));
    chip.appendChild(ce('span', 'day-chip-title', 'Day ' + dayNum));
    chip.appendChild(ce('span', 'day-chip-sub', d.base || d.date || ''));
    chip.addEventListener('click', function () { STATE.activeDay = dayNum; renderItinerary(); });
    scroller.appendChild(chip);
  });
  root.appendChild(scroller);

  var timeline = ce('div', 'timeline');
  days.forEach(function (d, dayIdx) {
    var dayNum = d.day || (dayIdx + 1);
    if (STATE.activeDay !== null && STATE.activeDay !== dayNum) return;

    var dayCard = ce('div', 'day-card');

    var header = ce('div', 'day-card-header');
    var titleRow = ce('div', 'item-top');
    var titleLeft = ce('div');
    titleLeft.appendChild(ce('span', 'day-badge', 'DAY ' + dayNum));
    titleLeft.appendChild(ce('span', 'ai-plan-badge', '✨ AI Suggested'));
    titleRow.appendChild(titleLeft);

    if (d.date) titleRow.appendChild(ce('span', 'muted small', '🗓 ' + d.date));
    header.appendChild(titleRow);

    var h2 = ce('h2', 'day-title', d.title || (d.base ? 'Exploring ' + d.base : 'Day ' + dayNum));
    header.appendChild(h2);

    var actRow = ce('div', 'day-header-actions');
    var addBtn = ce('button', 'btn-swap', '➕ Add / Swap Idea');
    addBtn.addEventListener('click', function () { openSwapModal(d); });
    actRow.appendChild(addBtn);
    if (d.base) actRow.appendChild(ce('span', 'badge', '📍 ' + d.base));
    header.appendChild(actRow);

    dayCard.appendChild(header);

    if (d.transit) {
      var tBox = ce('div', 'transit-box');
      tBox.appendChild(ce('div', 'transit-box-title', '🚆 Transit & Movement'));
      tBox.appendChild(ce('div', null, d.transit));
      dayCard.appendChild(tBox);
    }

    if (d.lodging) {
      var lBox = ce('div', 'day-lodging-card');
      var lLeft = ce('div');
      lLeft.appendChild(ce('div', 'small muted', '🏨 Night Lodging'));
      lLeft.appendChild(ce('div', 'day-lodging-title', d.lodging));
      lBox.appendChild(lLeft);
      var switchStayBtn = ce('button', 'btn btn-secondary small', 'View Stays');
      switchStayBtn.addEventListener('click', function () { switchTab('accommodation'); });
      lBox.appendChild(switchStayBtn);
      dayCard.appendChild(lBox);
    }

    var items = d.items || d.events || d.activities || [];
    if (items.length > 0) {
      var evList = ce('div', 'timeline');
      items.forEach(function (ev, evIdx) {
        var it = ce('div', 'timeline-item');
        var top = ce('div', 'item-top');
        if (ev.time) top.appendChild(ce('span', 'time-tag', ev.time));
        var c = num(ev.cost);
        if (c != null && c > 0) top.appendChild(ce('span', 'badge badge-good', sgd(c)));

        var removeBtn = ce('button', 'btn-icon-danger', '✕');
        removeBtn.title = 'Remove from itinerary';
        removeBtn.addEventListener('click', function () {
          if (confirm('Remove "' + (ev.what || ev.title || 'this item') + '" from Day ' + dayNum + '?')) {
            items.splice(evIdx, 1);
            saveItineraryDoc();
            renderItinerary();
            showToast('Item removed from Day ' + dayNum);
          }
        });
        top.appendChild(removeBtn);
        it.appendChild(top);

        var titleText = ev.what || ev.title || ev.activity || ev.name || 'Activity';
        it.appendChild(ce('div', 'item-title', titleText));

        if (ev.notes) it.appendChild(ce('p', 'small muted', ev.notes));

        if (ev.refs && ev.refs.length) {
          var links = ce('div', 'small muted');
          ev.refs.forEach(function (r) {
            var a = ce('a', 'muted', '🔗 Reference');
            a.href = r;
            a.target = '_blank';
            a.rel = 'noopener';
            a.style.marginRight = '8px';
            links.appendChild(a);
          });
          it.appendChild(links);
        }

        evList.appendChild(it);
      });
      dayCard.appendChild(evList);
    }

    timeline.appendChild(dayCard);
  });

  root.appendChild(timeline);
}

function saveItineraryDoc() {
  if (!STATE.activeTripId) return;
  TripAuth.saveDocs(STATE.activeTripId, { itinerary: STATE.docs.itinerary }).catch(function (e) {
    console.warn('Failed to save itinerary update:', e);
  });
}

/* ==========================================================================
   SWAP / ADD IDEA MODAL
   ========================================================================== */
function openSwapModal(day) {
  STATE.swapTargetDay = day;
  $('#swap-modal-title').textContent = 'Add Idea to Day ' + (day.day || '');
  $('#swap-modal-subtitle').textContent = 'Base: ' + (day.base || 'All') + ' · Pick a curated spot or experience';

  var catRow = $('#swap-category-pills');
  clear(catRow);
  var cats = ['All', 'food', 'coffee', 'culture', 'nature', 'nightlife'];
  var activeCat = 'All';

  function renderPills() {
    clear(catRow);
    cats.forEach(function (c) {
      var pill = ce('button', 'filter-pill' + (activeCat === c ? ' active' : ''), c.toUpperCase());
      pill.addEventListener('click', function () {
        activeCat = c;
        renderPills();
        renderSwapIdeasList('', activeCat === 'All' ? null : activeCat);
      });
      catRow.appendChild(pill);
    });
  }
  renderPills();

  renderSwapIdeasList('', null);
  $('#swap-idea-modal').hidden = false;
}
function closeSwapModal() {
  $('#swap-idea-modal').hidden = true;
  STATE.swapTargetDay = null;
}

function renderSwapIdeasList(filterText, filterCategory) {
  var list = $('#swap-ideas-list');
  clear(list);

  var recs = getRecommendations();
  var targetDay = STATE.swapTargetDay;
  var baseCity = targetDay ? (targetDay.base || '').toLowerCase() : '';

  var filtered = recs.filter(function (r) {
    if (filterCategory && (r.category || '').toLowerCase() !== filterCategory.toLowerCase()) return false;
    if (filterText) {
      var blob = ((r.title || '') + ' ' + (r.why || '') + ' ' + (r.area || '')).toLowerCase();
      if (!blob.includes(filterText)) return false;
    }
    return true;
  });

  filtered.sort(function (a, b) {
    var aMatch = baseCity && (a.area || '').toLowerCase().includes(baseCity);
    var bMatch = baseCity && (b.area || '').toLowerCase().includes(baseCity);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return 0;
  });

  if (!filtered.length) {
    list.appendChild(ce('p', 'muted small text-center', 'No matching ideas found.'));
    return;
  }

  filtered.slice(0, 30).forEach(function (r) {
    var card = ce('div', 'swap-idea-card');
    var info = ce('div', 'swap-idea-info');

    var title = ce('div', 'swap-idea-title', r.title || r.name || 'Spot');
    info.appendChild(title);

    var meta = [];
    if (r.area) meta.push('📍 ' + r.area);
    if (r.category) meta.push('🏷 ' + r.category);
    if (r.cost_estimate) meta.push('💰 ' + r.cost_estimate);
    info.appendChild(ce('div', 'swap-idea-meta', meta.join(' · ')));

    if (r.why) info.appendChild(ce('div', 'swap-idea-why', r.why));
    card.appendChild(info);

    var insertBtn = ce('button', 'btn btn-secondary small', '+ Insert');
    insertBtn.addEventListener('click', function () {
      if (!targetDay.items) targetDay.items = [];
      targetDay.items.push({
        what: r.title || r.name,
        notes: (r.why || '') + (r.cost_estimate ? ' (' + r.cost_estimate + ')' : ''),
        time: '~flexible',
        cost: 0,
        currency: 'SGD',
        refs: r.source_url ? [r.source_url] : []
      });
      saveItineraryDoc();
      closeSwapModal();
      renderItinerary();
      showToast('Inserted "' + (r.title || r.name) + '" into Day ' + (targetDay.day || ''));
    });
    card.appendChild(insertBtn);

    list.appendChild(card);
  });
}

/* ==========================================================================
   2. ACCOMMODATION TAB (Route at a Glance & 23-Stay Directory)
   ========================================================================== */

var PLANNED_ROUTE = [
  {
    nights: 'Night 1 (24–25 Dec)',
    city: 'Hanoi Old Quarter',
    hotelName: 'Peridot Grand Hotel & Spa',
    rate: '2,400,000 VND (~S$ 59/person)',
    status: 'Planned',
    notes: 'Christmas Eve peak window: 300m from Hoan Kiem, inner courtyard, spa. Book 2-4 weeks out.',
    alts: ['acc-001 (La Siesta Splurge)', 'acc-002 (Emerald Waters)', 'acc-006 (Hanoi Pearl)']
  },
  {
    nights: 'Night 2 (25–26 Dec)',
    city: 'Hanoi → Ha Giang (Transit)',
    hotelName: '21:00 Sleeper Bus to Ha Giang',
    rate: 'Included in Transit Leg',
    status: 'Scheduled',
    notes: 'Overnight sleeper berth; hotel stores bags during the day after morning checkout.',
    alts: ['Daytime limousine van on 26 Dec (see dec-loop-start)']
  },
  {
    nights: 'Night 3 (26–27 Dec)',
    city: 'Ha Giang Loop (Quản Bạ)',
    hotelName: 'Dao Lodge Nam Dam / H\'Mong Village Resort',
    rate: 'Included in Easy Rider Tour',
    status: 'Tour Homestay',
    notes: 'Mountain homestay dinner, clay lodge, herbal footbath, corn wine.',
    alts: ['acc-018 H\'Mong Village Resort', 'acc-022 Dao Lodge Nam Dam']
  },
  {
    nights: 'Night 4 (27–28 Dec)',
    city: 'Ha Giang Loop (Đồng Văn / Mèo Vạc)',
    hotelName: 'Auberge de Meo Vac / Ancient Town Guesthouse',
    rate: 'Included in Easy Rider Tour',
    status: 'Tour Homestay',
    notes: 'Century-old H\'Mong stone architecture at the gateway to Mã Pí Lèng pass.',
    alts: ['acc-019 Ancient Town Guesthouse', 'acc-020 Lo Lo Eco Lodge']
  },
  {
    nights: 'Night 5 (28–29 Dec)',
    city: 'Ha Giang City',
    hotelName: 'Yen Bien Luxury Hotel',
    rate: '1,065,000 VND (~S$ 26/person)',
    status: 'Planned',
    notes: 'Post-loop reset night: rooftop pool, river view, laundry before 10h transit.',
    alts: ['acc-016 P\'apiu Resort (Ultra Splurge)', 'acc-017 Ha Giang Historic Hotel']
  },
  {
    nights: 'Nights 6–7 (29–31 Dec)',
    city: 'Tam Coc / Ninh Binh (2 nights)',
    hotelName: 'Tam Coc Garden Resort',
    rate: '1,170,000 VND / night (~S$ 29/person)',
    status: 'Planned',
    notes: 'Surrounded by limestone karst & paddies; 10 min bicycle from Tam Coc boat dock.',
    alts: ['acc-014 Tam Coc Sunshine Homestay (Budget ~S$9)', 'acc-011 Emeralda Resort']
  },
  {
    nights: 'Night 8 (31 Dec – 1 Jan)',
    city: 'Hanoi Old Quarter',
    hotelName: 'Hanoi La Siesta Premium Hang Be',
    rate: '2,860,000 VND (~S$ 70/person)',
    status: 'Planned',
    notes: 'New Year\'s Eve lake fireworks: within 300m walking distance so no taxis needed after midnight.',
    alts: ['acc-006 Hanoi Pearl (Fallback -S$19)', 'acc-004 O\'Gallery Premier', 'Tam Coc NYE (see dec-nye)']
  },
  {
    nights: 'Day 9 (1 Jan)',
    city: 'Flight HAN → SIN',
    hotelName: 'Noi Bai International Airport (HAN)',
    rate: 'Outbound Flight',
    status: 'Return Leg',
    notes: 'Direct flight back to Singapore Changi.',
    alts: []
  }
];

function renderAccommodation() {
  var root = $('#tab-accommodation');
  clear(root);

  var stays = getAccommodations();
  if (!stays.length) {
    root.appendChild(renderEmpty('No lodging or accommodation records found.'));
    return;
  }

  var modeBar = ce('div', 'view-mode-bar');
  var titleBox = ce('div');
  titleBox.appendChild(ce('h2', null, 'Accommodations & Stays'));
  titleBox.appendChild(ce('div', 'muted small', 'Night-by-night lodging schedule & curated alternatives'));
  modeBar.appendChild(titleBox);

  var toggleGroup = ce('div', 'view-toggle-group');
  var routeBtn = ce('button', 'view-toggle-btn' + (STATE.stayViewMode === 'route' ? ' active' : ''), '🗺 Planned Route (At a Glance)');
  var dirBtn = ce('button', 'view-toggle-btn' + (STATE.stayViewMode === 'directory' ? ' active' : ''), '📚 Stays Directory (23 Options)');

  routeBtn.addEventListener('click', function () {
    STATE.stayViewMode = 'route';
    renderAccommodation();
  });
  dirBtn.addEventListener('click', function () {
    STATE.stayViewMode = 'directory';
    renderAccommodation();
  });

  toggleGroup.appendChild(routeBtn);
  toggleGroup.appendChild(dirBtn);
  modeBar.appendChild(toggleGroup);
  root.appendChild(modeBar);

  if (STATE.stayViewMode === 'route') {
    renderAccommodationRouteTable(root, stays);
  } else {
    renderAccommodationDirectory(root, stays);
  }
}

function renderAccommodationRouteTable(root, stays) {
  var container = ce('div', 'glance-table-container');
  var table = ce('table', 'stay-route-table');

  var thead = ce('thead');
  var hrow = ce('tr');
  hrow.appendChild(ce('th', 'glance-th', 'Night & Dates'));
  hrow.appendChild(ce('th', 'glance-th', 'Base / Region'));
  hrow.appendChild(ce('th', 'glance-th', 'Active Planned Stay'));
  hrow.appendChild(ce('th', 'glance-th', 'Estimated Rate'));
  hrow.appendChild(ce('th', 'glance-th', 'Status'));
  hrow.appendChild(ce('th', 'glance-th', 'Strategic Booking Notes'));
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = ce('tbody');
  PLANNED_ROUTE.forEach(function (leg) {
    var tr = ce('tr', 'stay-route-tr');

    var nCell = ce('td', 'stay-route-cell');
    nCell.appendChild(ce('div', 'glance-day-num', leg.nights));
    tr.appendChild(nCell);

    var cCell = ce('td', 'stay-route-cell');
    cCell.appendChild(ce('span', 'glance-day-base', leg.city));
    tr.appendChild(cCell);

    var hCell = ce('td', 'stay-route-cell');
    hCell.appendChild(ce('div', 'stay-hotel-name', '🏨 ' + leg.hotelName));
    if (leg.alts && leg.alts.length > 0) {
      var altBox = ce('div', 'stay-alts-tag', '⇄ Alts: ' + leg.alts.join(' · '));
      hCell.appendChild(altBox);
    }
    tr.appendChild(hCell);

    var rCell = ce('td', 'stay-route-cell');
    rCell.appendChild(ce('div', 'stay-hotel-rate', leg.rate));
    tr.appendChild(rCell);

    var sCell = ce('td', 'stay-route-cell');
    var badgeCls = leg.status.includes('Tour') ? 'badge-good' : (leg.status.includes('Planned') ? 'badge' : 'badge-warn');
    sCell.appendChild(ce('span', 'badge ' + badgeCls, leg.status));
    tr.appendChild(sCell);

    var notesCell = ce('td', 'stay-route-cell');
    notesCell.appendChild(ce('p', 'small muted', leg.notes));
    tr.appendChild(notesCell);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  root.appendChild(container);

  var switchNotice = ce('div', 'card-panel text-center');
  switchNotice.appendChild(ce('p', 'muted small', 'Want to explore or compare all 23 lodging options with photos and links?'));
  var switchBtn = ce('button', 'btn btn-secondary small', 'Browse All 23 Stays in Directory →');
  switchBtn.addEventListener('click', function () {
    STATE.stayViewMode = 'directory';
    renderAccommodation();
  });
  switchNotice.appendChild(switchBtn);
  root.appendChild(switchNotice);
}

function renderAccommodationDirectory(root, stays) {
  var areas = ['all'];
  stays.forEach(function (s) {
    var a = s.area || s.location || '';
    var baseWord = a.split('(')[0].split(',')[0].trim();
    if (baseWord && !areas.includes(baseWord)) areas.push(baseWord);
  });

  var filterBar = ce('div', 'filter-pills-row');
  areas.forEach(function (area) {
    var pill = ce('button', 'filter-pill' + (STATE.stayArea === area ? ' active' : ''), area === 'all' ? 'All Stays' : area);
    pill.addEventListener('click', function () {
      STATE.stayArea = area;
      renderAccommodation();
    });
    filterBar.appendChild(pill);
  });
  root.appendChild(filterBar);

  var grid = ce('div', 'stay-grid');
  var count = 0;

  stays.forEach(function (s) {
    var a = (s.area || s.location || '').toLowerCase();
    if (STATE.stayArea !== 'all' && !a.includes(STATE.stayArea.toLowerCase())) return;
    count++;

    var card = ce('div', 'stay-card');
    var top = ce('div', 'stay-card-header');
    top.appendChild(ce('div', 'stay-name', s.name || s.hotel || 'Stay'));

    var status = s.status || 'planning';
    var badgeCls = status === 'booked' ? 'badge-good' : (status === 'wishlist' ? 'badge-warn' : '');
    top.appendChild(ce('span', 'badge ' + badgeCls, status.toUpperCase()));
    card.appendChild(top);

    var checkin = s.checkin || s.check_in || '';
    var checkout = s.checkout || s.check_out || '';
    var dates = (checkin && checkout) ? (checkin + ' → ' + checkout) : '';
    if (s.nights) dates += ' (' + s.nights + ' night' + (s.nights > 1 ? 's' : '') + ')';
    if (dates) card.appendChild(ce('div', 'stay-dates', '🗓 ' + dates));

    var details = ce('div', 'stay-details muted');
    if (s.area || s.location) details.appendChild(ce('div', null, '📍 ' + (s.area || s.location)));
    if (s.notes) details.appendChild(ce('p', 'small', s.notes));
    card.appendChild(details);

    var priceLine = ce('div', 'stay-price-line');
    var rateStr = '';
    if (s.price_per_night) {
      rateStr = new Intl.NumberFormat().format(s.price_per_night) + ' ' + (s.currency || 'VND') + ' / night';
    } else if (s.cost_sgd) {
      rateStr = sgd(s.cost_sgd) + ' / night';
    } else {
      rateStr = 'Check booking';
    }
    priceLine.appendChild(ce('span', 'muted small', 'Estimated Rate'));
    priceLine.appendChild(ce('span', null, rateStr));
    card.appendChild(priceLine);

    if (s.link || s.source_url) {
      var linkRow = ce('div', 'stay-price-line');
      var aTag = ce('a', 'muted small', 'Open Booking / Listing ↗');
      aTag.href = s.link || s.source_url;
      aTag.target = '_blank';
      aTag.rel = 'noopener';
      linkRow.appendChild(aTag);
      card.appendChild(linkRow);
    }

    grid.appendChild(card);
  });

  if (count === 0) {
    grid.appendChild(ce('p', 'muted small text-center', 'No stays matching this filter.'));
  }

  root.appendChild(grid);
}

/* ==========================================================================
   3. EXPENSES TAB (Budget Ceiling, Headroom, Active Decision Adjustments)
   ========================================================================== */
function renderExpenses() {
  var root = $('#tab-expenses');
  clear(root);

  var b = calculateBudget();
  var plannedItems = getExpensesPlanned();

  // Top Summary Metric Cards
  var stats = ce('div', 'stats-row');

  var b1 = ce('div', 'stat-box');
  b1.appendChild(ce('div', 'stat-box-title', 'Budget Cap'));
  b1.appendChild(ce('div', 'stat-box-num', sgd(b.cap)));
  stats.appendChild(b1);

  var b2 = ce('div', 'stat-box');
  b2.appendChild(ce('div', 'stat-box-title', 'Net Planned Spend'));
  b2.appendChild(ce('div', 'stat-box-num', sgd(b.net)));
  stats.appendChild(b2);

  var b3 = ce('div', 'stat-box');
  b3.appendChild(ce('div', 'stat-box-title', 'Remaining Headroom'));
  b3.appendChild(ce('div', 'stat-box-num', sgd(b.headroom)));
  stats.appendChild(b3);

  root.appendChild(stats);

  // Active Decision Deltas Summary Card
  var decs = getDecisions();
  var activeAdjustments = [];
  decs.forEach(function (d) {
    var pickedOptId = getActivePick(d);
    var opt = (d.options || []).find(function (o) { return o.id === pickedOptId; });
    if (opt && opt.cost_delta_sgd != null && opt.cost_delta_sgd !== 0) {
      activeAdjustments.push({
        decision: d.title || d.question,
        choice: opt.label,
        delta: opt.cost_delta_sgd
      });
    }
  });

  if (activeAdjustments.length > 0) {
    var adjCard = ce('div', 'card-panel');
    adjCard.appendChild(ce('h3', null, 'Active Decision Budget Adjustments'));
    adjCard.appendChild(ce('p', 'muted small', 'Your choices in the Decisions tab dynamically adjust the committed budget:'));

    var adjTable = ce('div', 'timeline');
    activeAdjustments.forEach(function (adj) {
      var row = ce('div', 'timeline-item');
      var top = ce('div', 'item-top');
      top.appendChild(ce('div', 'item-title', adj.decision));
      var sign = adj.delta > 0 ? '+' : '';
      var badgeCls = adj.delta < 0 ? 'badge-good' : 'badge-warn';
      top.appendChild(ce('span', 'badge ' + badgeCls, sign + sgd(adj.delta)));
      row.appendChild(top);
      row.appendChild(ce('p', 'small muted', 'Selected: ' + adj.choice));
      adjTable.appendChild(row);
    });
    adjCard.appendChild(adjTable);
    root.appendChild(adjCard);
  }

  // Category breakdown
  var catTotals = {};
  var totalValid = 0;
  plannedItems.forEach(function (it) {
    var c = num(it.amount != null ? it.amount : (it.cost_sgd || it.amount_sgd));
    if (c != null) {
      var cat = it.category || 'other';
      catTotals[cat] = (catTotals[cat] || 0) + c;
      totalValid += c;
    }
  });

  var catCard = ce('div', 'card-panel');
  catCard.appendChild(ce('h3', null, 'Spend Breakdown by Category'));
  var catBoxes = ce('div', 'category-bars-box');
  Object.keys(catTotals).forEach(function (cat) {
    var amt = catTotals[cat];
    var pct = totalValid > 0 ? Math.round((amt / totalValid) * 100) : 0;
    var bar = ce('div', 'cat-bar-item');
    var h = ce('div', 'cat-bar-header');
    h.appendChild(ce('span', null, cat.toUpperCase() + ' (' + pct + '%)'));
    h.appendChild(ce('span', 'muted', sgd(amt)));
    bar.appendChild(h);

    var track = ce('div', 'cat-bar-track');
    var fill = ce('div', 'cat-bar-fill');
    fill.style.width = pct + '%';
    fill.style.background = cat === 'accommodation' ? '#38bdf8' : (cat === 'activities' ? '#34d399' : '#818cf8');
    track.appendChild(fill);
    bar.appendChild(track);
    catBoxes.appendChild(bar);
  });
  catCard.appendChild(catBoxes);
  root.appendChild(catCard);

  // Itemized Expenses
  var listCard = ce('div', 'card-panel');
  listCard.appendChild(ce('h3', null, 'Itemized Planning Records'));

  if (plannedItems.length > 0) {
    var list = ce('div', 'timeline');
    plannedItems.forEach(function (it) {
      var row = ce('div', 'timeline-item');
      var top = ce('div', 'item-top');
      top.appendChild(ce('div', 'item-title', it.description || it.item || it.name || it.category));

      var cost = num(it.amount != null ? it.amount : (it.cost_sgd || it.amount_sgd));
      top.appendChild(ce('span', 'badge', cost != null ? sgd(cost) : String(it.amount || '—')));
      row.appendChild(top);

      var meta = [];
      if (it.category) meta.push(it.category);
      if (it.paid_by) meta.push('paid: ' + it.paid_by);
      if (it.status) meta.push(it.status);
      row.appendChild(ce('div', 'item-meta', meta.join(' · ')));

      if (it.notes) row.appendChild(ce('p', 'small muted', it.notes));
      list.appendChild(row);
    });
    listCard.appendChild(list);
  } else {
    listCard.appendChild(ce('p', 'muted', 'No expense items listed.'));
  }

  root.appendChild(listCard);
}

/* ==========================================================================
   4. DECISIONS TAB (Interactive Choices with Budget & Itinerary Impact)
   ========================================================================== */
function renderDecisions() {
  var root = $('#tab-decisions');
  clear(root);

  var decs = getDecisions();
  if (!decs.length) {
    root.appendChild(renderEmpty('No group decisions open for this trip.'));
    return;
  }

  var intro = ce('div', 'card-panel');
  intro.appendChild(ce('h2', null, 'Group Decisions & Itinerary Pivots'));
  intro.appendChild(ce('p', 'muted small', 'Toggling choices here instantly updates your budget headroom, adjusts committed spend, and updates affected itinerary legs.'));
  root.appendChild(intro);

  var list = ce('div', 'decisions-list');
  decs.forEach(function (d) {
    var pickedOptId = getActivePick(d);
    var card = ce('div', 'decision-card' + (pickedOptId ? ' resolved' : ''));

    var header = ce('div', 'decision-header');
    header.appendChild(ce('h2', null, d.title || 'Decision'));
    if (pickedOptId) header.appendChild(ce('span', 'badge badge-good', 'RESOLVED'));
    card.appendChild(header);

    if (d.question) card.appendChild(ce('div', 'decision-question', d.question));

    var optGrid = ce('div', 'options-grid');
    (d.options || []).forEach(function (opt) {
      var isPicked = pickedOptId === opt.id;
      var box = ce('div', 'option-box' + (isPicked ? ' picked' : ''));

      var lbl = ce('div', 'option-label');
      lbl.appendChild(ce('span', null, opt.label || 'Option'));
      if (opt.cost_delta_sgd != null) {
        var sign = opt.cost_delta_sgd > 0 ? '+' : '';
        var badgeCls = opt.cost_delta_sgd < 0 ? 'badge-good' : (opt.cost_delta_sgd > 0 ? 'badge-warn' : '');
        lbl.appendChild(ce('span', 'badge ' + badgeCls, sign + sgd(opt.cost_delta_sgd)));
      }
      box.appendChild(lbl);

      if (opt.summary) box.appendChild(ce('div', 'option-summary', opt.summary));
      if (opt.tradeoffs) box.appendChild(ce('p', 'small muted', '⚡ Tradeoffs: ' + opt.tradeoffs));

      // Changes & Itinerary Impact
      if (opt.changes && opt.changes.length > 0) {
        var impBox = ce('div', 'decision-impact-box');
        impBox.appendChild(ce('div', 'decision-impact-title', 'Impact on Plan:'));
        var ul = ce('ul', 'decision-impact-list');
        opt.changes.forEach(function (ch) {
          ul.appendChild(ce('li', null, ch));
        });
        impBox.appendChild(ul);
        box.appendChild(impBox);
      }

      box.addEventListener('click', function () {
        STATE.picks[d.id] = { option_id: opt.id, at: Date.now() };
        TripAuth.savePick(STATE.activeTripId, d.id, opt.id, d).catch(console.warn);

        renderTripBanner();
        renderDecisions();
        showToast('Choice updated: ' + (opt.label ? opt.label.slice(0, 35) + '...' : 'Saved'));
      });

      optGrid.appendChild(box);
    });
    card.appendChild(optGrid);
    list.appendChild(card);
  });

  root.appendChild(list);
}

/* ==========================================================================
   5. PACKING TAB (Checklist with Persistence)
   ========================================================================== */
function renderPacking() {
  var root = $('#tab-packing');
  clear(root);

  var cats = getPackingCategories();
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
      var itemText = typeof it === 'string' ? it : (it.item || it.name || '');
      var itemId = (cat.category || '') + '_' + idx;
      var isDone = !!checkedState[itemId];

      var row = ce('div', 'check-item' + (isDone ? ' done' : ''));
      var box = ce('div', 'check-box', isDone ? '✓' : '');
      row.appendChild(box);
      row.appendChild(ce('span', 'check-text', itemText));

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

/* ==========================================================================
   6. IDEAS / RECOMMENDATIONS TAB (Curated Pool, Filter & Add to Day)
   ========================================================================== */
function renderRecommendations() {
  var root = $('#tab-recommendations');
  clear(root);

  var recs = getRecommendations();
  if (!recs.length) {
    root.appendChild(renderEmpty('No recommendations collected yet.'));
    return;
  }

  var days = getItineraryDays();

  // Search input
  var searchBar = ce('div', 'card-panel');
  var searchInp = ce('input', 'search-input');
  searchInp.placeholder = 'Search spots, foods, cafes, or views...';
  searchInp.value = STATE.recSearch;
  searchInp.addEventListener('input', function () {
    STATE.recSearch = this.value.trim().toLowerCase();
    renderRecList(recs, days, listContainer);
  });
  searchBar.appendChild(searchInp);

  // Category filter pills
  var catRow = ce('div', 'filter-pills-row');
  var cats = ['all', 'food', 'coffee', 'culture', 'nature', 'nightlife'];
  cats.forEach(function (c) {
    var pill = ce('button', 'filter-pill' + (STATE.recCategory === c ? ' active' : ''), c.toUpperCase());
    pill.addEventListener('click', function () {
      STATE.recCategory = c;
      renderRecommendations();
    });
    catRow.appendChild(pill);
  });
  searchBar.appendChild(catRow);
  root.appendChild(searchBar);

  var listContainer = ce('div', 'stay-grid');
  renderRecList(recs, days, listContainer);
  root.appendChild(listContainer);
}

function renderRecList(recs, days, container) {
  clear(container);

  var filtered = recs.filter(function (r) {
    if (STATE.recCategory !== 'all' && (r.category || '').toLowerCase() !== STATE.recCategory.toLowerCase()) return false;
    if (STATE.recSearch) {
      var blob = ((r.title || '') + ' ' + (r.why || '') + ' ' + (r.area || '')).toLowerCase();
      if (!blob.includes(STATE.recSearch)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    container.appendChild(ce('p', 'muted small text-center', 'No ideas match your filter.'));
    return;
  }

  filtered.forEach(function (r) {
    var card = ce('div', 'stay-card');
    card.appendChild(ce('div', 'stay-name', r.title || r.name || 'Spot'));

    var meta = [];
    if (r.area) meta.push('📍 ' + r.area);
    if (r.category) meta.push('🏷 ' + r.category);
    if (r.cost_estimate) meta.push('💰 ' + r.cost_estimate);
    card.appendChild(ce('div', 'stay-dates', meta.join(' · ')));

    if (r.why) card.appendChild(ce('p', 'small muted', r.why));

    // Link
    if (r.source_url) {
      var a = ce('a', 'small muted', 'Open Guide / Source ↗');
      a.href = r.source_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.display = 'block';
      a.style.marginBottom = '8px';
      card.appendChild(a);
    }

    // Interactive "Add to Itinerary Day" dropdown control
    if (days.length > 0) {
      var addControl = ce('div', 'add-to-day-control');
      var sel = ce('select', 'day-select-input');
      days.forEach(function (d, idx) {
        var opt = ce('option', null, 'Day ' + (d.day || idx + 1) + ' (' + (d.base || '') + ')');
        opt.value = idx;
        sel.appendChild(opt);
      });
      addControl.appendChild(sel);

      var btn = ce('button', 'btn-swap', '+ Add to Day');
      btn.addEventListener('click', function () {
        var dayIdx = parseInt(sel.value, 10);
        var targetDay = days[dayIdx];
        if (targetDay) {
          if (!targetDay.items) targetDay.items = [];
          targetDay.items.push({
            what: r.title || r.name,
            notes: (r.why || '') + (r.cost_estimate ? ' (' + r.cost_estimate + ')' : ''),
            time: '~flexible',
            cost: 0,
            currency: 'SGD',
            refs: r.source_url ? [r.source_url] : []
          });
          saveItineraryDoc();
          showToast('Added "' + (r.title || r.name) + '" to Day ' + (targetDay.day || (dayIdx + 1)));
        }
      });
      addControl.appendChild(btn);
      card.appendChild(addControl);
    }

    container.appendChild(card);
  });
}

/* ==========================================================================
   7. SHARE & MEMBERS TAB
   ========================================================================== */
function renderShare() {
  var root = $('#tab-share');
  clear(root);

  var card = ce('div', 'card-panel');
  card.appendChild(ce('h2', null, 'Collaborators & Trip Access'));
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
    var inp = ce('input', 'search-input');
    inp.style.marginBottom = '10px';
    inp.placeholder = 'traveller@example.com';

    var btn = ce('button', 'btn', 'Send Invite');
    btn.addEventListener('click', function () {
      if (!inp.value || !inp.value.includes('@')) return alert('Please enter a valid email.');
      TripAuth.invite(STATE.activeTripId, inp.value.trim()).then(function () {
        showToast('Invitation sent!');
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
  var box = ce('div', 'wrap center-state');
  box.appendChild(ce('h2', null, 'Welcome to Nomad!'));
  box.appendChild(ce('p', 'muted', 'You are signed in, but no trips have been created or shared with your email yet.'));
  root.appendChild(box);
}

})();

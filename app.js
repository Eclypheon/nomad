/* ==========================================================================
   Nomad — Collaborative Reactive Travel Planner & Trip Companion
   Mobile-First, AI-Planned Itinerary, Swappable Ideas & Stays,
   Dynamic Decisions & Budget Headroom, PocketBase Cloud Sync
   ========================================================================== */

(function () {
'use strict';

// Register PWA Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      console.log('[Nomad PWA] Service worker active:', reg.scope);
    }).catch(function (err) {
      console.warn('[Nomad PWA] Service worker registration failed:', err);
    });
  });
}

var TABS = ['itinerary', 'accommodation', 'expenses', 'decisions', 'packing', 'recommendations', 'travellers', 'share'];
var LS_ACTIVE_TRIP = 'nomad.active_trip.v1';
var LS_PACKING_PREFIX = 'nomad.packing.v1.';

/* App Reactive State */
var STATE = {
  activeTab: 'itinerary',
  itineraryViewMode: 'glance', /* 'glance' (table at a glance) or 'deep-dive' (day breakdown) */
  tableOrientation: 'flipped', /* 'flipped' (Days across columns, Timeslots as rows) or 'standard' */
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
  docs: {},                 /* { trip, itinerary, accommodation, expenses, packing, recommendations, decisions, travellers } */
  members: [],
  role: 'member',
  canEdit: false,
  picks: {},
  loading: false,
  swapTargetDay: null,      /* day object when swap modal is open */
  maskPassports: true,      /* toggle to mask passport numbers for privacy */
  editingItem: null,        /* { dayNum, itemIndex, item } when editing an activity */
  editingTraveller: null    /* { isSelf, companionId } when editing passport/companion */
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

function getTravellersData() {
  var d = STATE.docs.travellers;
  if (d && typeof d === 'object' && (d.my_passport || Array.isArray(d.companions))) {
    return d;
  }
  try {
    var raw = localStorage.getItem('nomad_travellers_override_' + (STATE.activeTripId || 'default'));
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    my_passport: {
      full_name: 'Kester Neo',
      passport_number: '',
      nationality: 'Singapore',
      date_of_birth: '',
      expiry_date: '',
      emergency_contact_name: '',
      emergency_contact_phone: '',
      notes: 'Singapore passport holders enter Vietnam visa-free for up to 30 days.'
    },
    companions: [
      {
        id: 'comp-1',
        full_name: 'Accompanying Traveller',
        relationship: 'Companion',
        passport_number: '',
        nationality: 'Singapore',
        date_of_birth: '',
        expiry_date: '',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        notes: '6+ months validity upon entry required'
      }
    ]
  };
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
    if (st.configured && st.ready && !st.error) {
      landingStatus.innerHTML = '<span class="status-dot"></span> Cloud backend connected';
    } else if (st.error && /Local Network Access|NS_ERROR|network_lna/i.test(st.error)) {
      landingStatus.innerHTML = '<span class="status-dot" style="background:#f59e0b"></span> Tailscale LNA blocked — <a href="' + (st.backendBase || 'https://alienlab.tailbed832.ts.net:10000') + '/trip/" style="color:var(--primary);text-decoration:underline;">open same-origin /trip/</a>';
    } else if (st.configured) {
      landingStatus.innerHTML = '<span class="status-dot" style="background:#f87171"></span> ' + (st.error ? 'Backend connection issue' : 'Checking connection...');
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

  // Item Editor modal listeners
  var itemEditorClose = $('#item-editor-close');
  if (itemEditorClose) itemEditorClose.addEventListener('click', closeItemEditor);
  var itemEditorCancel = $('#edit-item-cancel-btn');
  if (itemEditorCancel) itemEditorCancel.addEventListener('click', closeItemEditor);
  var itemEditorModal = $('#item-editor-modal');
  if (itemEditorModal) {
    itemEditorModal.addEventListener('click', function (e) {
      if (e.target === this) closeItemEditor();
    });
  }
  var itemEditorForm = $('#item-editor-form');
  if (itemEditorForm) {
    itemEditorForm.addEventListener('submit', function (e) {
      e.preventDefault();
      saveItemEditor();
    });
  }
  var itemEditorDel = $('#edit-item-delete-btn');
  if (itemEditorDel) itemEditorDel.addEventListener('click', deleteItemEditor);
  var bookingUrlInp = $('#edit-item-booking-url');
  if (bookingUrlInp) {
    bookingUrlInp.addEventListener('input', function () {
      var u = this.value.trim();
      var tBtn = $('#edit-item-booking-test-btn');
      if (tBtn) {
        tBtn.hidden = !u;
        tBtn.href = u || '#';
      }
    });
  }

  // Traveller / Passport Editor modal listeners
  var travClose = $('#traveller-editor-close');
  if (travClose) travClose.addEventListener('click', closeTravellerEditor);
  var travCancel = $('#edit-traveller-cancel-btn');
  if (travCancel) travCancel.addEventListener('click', closeTravellerEditor);
  var travModal = $('#traveller-editor-modal');
  if (travModal) {
    travModal.addEventListener('click', function (e) {
      if (e.target === this) closeTravellerEditor();
    });
  }
  var travForm = $('#traveller-editor-form');
  if (travForm) {
    travForm.addEventListener('submit', function (e) {
      e.preventDefault();
      saveTravellerEditor();
    });
  }
  var travDel = $('#edit-traveller-delete-btn');
  if (travDel) {
    travDel.addEventListener('click', function () {
      var id = $('#edit-traveller-id').value;
      var name = $('#edit-traveller-name').value;
      deleteCompanion(id, name);
    });
  }

  // PDF Export & Print modal listeners
  var pdfClose = $('#pdf-modal-close');
  if (pdfClose) pdfClose.addEventListener('click', closePdfPreview);
  var pdfModal = $('#pdf-export-modal');
  if (pdfModal) {
    pdfModal.addEventListener('click', function (e) {
      if (e.target === this) closePdfPreview();
    });
  }
  var pdfPrintBtn = $('#pdf-print-btn');
  if (pdfPrintBtn) pdfPrintBtn.addEventListener('click', printPdfItinerary);
  var pdfOpenTabBtn = $('#pdf-open-tab-btn');
  if (pdfOpenTabBtn) pdfOpenTabBtn.addEventListener('click', openPdfInNewTab);

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
  var blockedBtn = $('#oauth-blocked-btn');
  if (blockedBtn) blockedBtn.hidden = true;
  modal.hidden = false;
}

function closeSignInModal() {
  var modal = $('#signin-modal');
  if (modal) modal.hidden = true;
  var waitCard = $('#oauth-waiting-card');
  if (waitCard) waitCard.hidden = true;
  var blockedBtn = $('#oauth-blocked-btn');
  if (blockedBtn) blockedBtn.hidden = true;
}

function doGoogleSignIn() {
  var waitCard = $('#oauth-waiting-card');
  var waitTitle = $('#oauth-waiting-title');
  var waitSub = $('#oauth-waiting-sub');
  var errBox = $('#auth-form-error');

  if (errBox) errBox.hidden = true;
  if (waitTitle) waitTitle.textContent = 'Authorizing with Google...';
  if (waitSub) waitSub.textContent = 'Complete sign-in in the secure prompt window.';
  if (waitCard) waitCard.hidden = false;

  TripAuth.signIn().then(function (res) {
    closeSignInModal();
    showToast('Signed in successfully!');
  }).catch(function (e) {
    if (waitCard) waitCard.hidden = true;
    if (errBox) {
      clear(errBox);
      var m = e.message || e;
      var p = ce('p', null, 'Google sign-in cancelled or failed: ' + m);
      errBox.appendChild(p);
      if (e.code === 'network_lna' || /Local Network Access|NS_ERROR|network_lna/i.test(m)) {
        var host = (TripAuth.status && TripAuth.status().backendBase) || 'https://alienlab.tailbed832.ts.net:10000';
        var directLink = ce('a', 'btn btn-secondary small', 'Open Nomad Directly (' + host + '/trip/) →');
        directLink.href = host + '/trip/';
        directLink.style.marginTop = '10px';
        directLink.style.display = 'inline-block';
        errBox.appendChild(directLink);
      }
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
      btn.classList.toggle('active', ['packing', 'recommendations', 'travellers', 'share'].includes(tabName));
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
    case 'travellers':     renderTravellers(); break;
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
  // Table Toolbar
  var toolbar = ce('div', 'table-toolbar');

  var leftTools = ce('div', 'table-toolbar-left');
  var orientBtn = ce('button', 'btn btn-secondary small');
  if (STATE.tableOrientation === 'flipped') {
    orientBtn.innerHTML = '↔️ Layout: <strong>Days Across</strong> (Tap for Rows)';
  } else {
    orientBtn.innerHTML = '↕️ Layout: <strong>Days Down</strong> (Tap for Columns)';
  }
  orientBtn.addEventListener('click', function () {
    STATE.tableOrientation = (STATE.tableOrientation === 'flipped') ? 'standard' : 'flipped';
    renderItinerary();
  });
  leftTools.appendChild(orientBtn);

  var addActBtn = ce('button', 'btn btn-secondary small', '➕ Add Activity');
  addActBtn.addEventListener('click', function () {
    openItemEditor(1, -1, null);
  });
  leftTools.appendChild(addActBtn);
  toolbar.appendChild(leftTools);

  var rightTools = ce('div', 'table-toolbar-right');
  var pdfBtn = ce('button', 'btn btn-google small', '📄 Export / View PDF');
  pdfBtn.addEventListener('click', function () {
    openPdfPreview();
  });
  rightTools.appendChild(pdfBtn);
  toolbar.appendChild(rightTools);

  root.appendChild(toolbar);

  // Table Container
  var container = ce('div', 'glance-table-container');
  var table = ce('table', 'glance-table' + (STATE.tableOrientation === 'flipped' ? ' flipped' : ''));

  if (STATE.tableOrientation === 'flipped') {
    renderFlippedMatrix(table, days);
  } else {
    renderStandardMatrix(table, days);
  }

  container.appendChild(table);
  root.appendChild(container);

  var tip = ce('p', 'muted small text-center', '💡 Tap any activity to edit schedule, details, or direct booking links. Swipe horizontally to view all days.');
  root.appendChild(tip);
}

function renderFlippedMatrix(table, days) {
  var thead = ce('thead');
  var hrow = ce('tr');
  var thCorner = ce('th', 'glance-th glance-dimension-cell', 'Timeline \\ Day');
  hrow.appendChild(thCorner);

  days.forEach(function (d, dayIdx) {
    var dayNum = d.day || (dayIdx + 1);
    var th = ce('th', 'glance-th glance-col-day-th');

    var headWrap = ce('div', 'glance-day-header');
    headWrap.appendChild(ce('div', 'glance-day-num', 'Day ' + dayNum));
    if (d.date) headWrap.appendChild(ce('div', 'glance-day-date', d.date.slice(5)));
    if (d.base) headWrap.appendChild(ce('span', 'glance-day-base', d.base));
    th.appendChild(headWrap);
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = ce('tbody');

  var daySlots = days.map(function (d, dayIdx) {
    var items = d.items || d.events || d.activities || [];
    var slots = { morning: [], afternoon: [], evening: [], night: [] };
    items.forEach(function (it, itemIdx) {
      var w = (it.what || it.title || it.activity || it.name || '');
      if (it.time === '—' && (w.toLowerCase().includes('food & drink') || w.toLowerCase().includes('local transport') || w.toLowerCase().includes('lodging:'))) return;
      var slot = categorizeItemSlot(it);
      slots[slot].push({ it: it, itemIdx: itemIdx });
    });
    return { day: d, dayNum: d.day || (dayIdx + 1), dayIdx: dayIdx, slots: slots };
  });

  // Row 1: Focus
  var trBase = ce('tr', 'glance-tr');
  trBase.appendChild(ce('td', 'glance-dimension-cell', '📍 Route & Focus'));
  daySlots.forEach(function (ds) {
    var td = ce('td', 'glance-col-day-cell');
    var focusText = ds.day.title ? ds.day.title.split('—')[0].trim() : (ds.day.base || '');
    var pill = ce('div', null);
    pill.style.fontSize = '0.72rem';
    pill.style.color = 'var(--fg-muted)';
    pill.textContent = focusText || '—';
    td.appendChild(pill);
    trBase.appendChild(td);
  });
  tbody.appendChild(trBase);

  function buildFlippedSlotRow(slotName, label) {
    var tr = ce('tr', 'glance-tr');
    tr.appendChild(ce('td', 'glance-dimension-cell', label));

    daySlots.forEach(function (ds) {
      var td = ce('td', 'glance-col-day-cell');
      var list = ds.slots[slotName];

      if (list.length === 0) {
        td.appendChild(ce('span', 'muted small', '—'));
      } else {
        var box = ce('div', 'glance-slot-list');
        list.forEach(function (entry) {
          box.appendChild(createEventPill(ds.dayNum, entry.itemIdx, entry.it));
        });
        td.appendChild(box);
      }
      tr.appendChild(td);
    });
    return tr;
  }

  // Row 2: Morning
  tbody.appendChild(buildFlippedSlotRow('morning', '🌅 Morning\n06:00 – 12:00'));

  // Row 3: Afternoon
  tbody.appendChild(buildFlippedSlotRow('afternoon', '☀️ Afternoon\n12:00 – 17:00'));

  // Row 4: Evening
  tbody.appendChild(buildFlippedSlotRow('evening', '🌆 Evening\n17:00 – 20:30'));

  // Row 5: Night & Stay
  var trNight = ce('tr', 'glance-tr');
  trNight.appendChild(ce('td', 'glance-dimension-cell', '🌙 Night & Stay'));
  daySlots.forEach(function (ds) {
    var td = ce('td', 'glance-col-day-cell');
    var box = ce('div', 'glance-slot-list');

    ds.slots.night.forEach(function (entry) {
      box.appendChild(createEventPill(ds.dayNum, entry.itemIdx, entry.it));
    });

    if (ds.day.lodging) {
      var lodgingShort = ds.day.lodging.split('—')[0].replace('acc-', 'Acc-');
      if (ds.day.lodging.includes('—')) lodgingShort = ds.day.lodging.split('—')[1].split(',')[0].trim();

      var stayPill = ce('div', 'glance-stay-pill');
      stayPill.appendChild(ce('span', null, '🏨 ' + lodgingShort));

      var allStays = getAccommodations();
      var matchedStay = allStays.find(function (s) {
        return lodgingShort.toLowerCase().includes((s.name || '').toLowerCase().slice(0, 8)) ||
               (s.name && s.name.toLowerCase().includes(lodgingShort.toLowerCase().slice(0, 8)));
      });
      if (matchedStay && (matchedStay.booking_url || matchedStay.link)) {
        var bLink = ce('a', 'glance-booking-link', 'Book ↗');
        bLink.href = matchedStay.booking_url || matchedStay.link;
        bLink.target = '_blank';
        bLink.rel = 'noopener';
        bLink.addEventListener('click', function (e) { e.stopPropagation(); });
        stayPill.appendChild(bLink);
      }
      box.appendChild(stayPill);
    } else if (ds.day.transit && ds.day.transit.toLowerCase().includes('sleeper')) {
      var busPill = ce('div', 'glance-stay-pill');
      busPill.appendChild(ce('span', null, '🚌 Sleeper Bus'));
      var busLink = ce('a', 'glance-booking-link', '12Go ↗');
      busLink.href = 'https://12go.asia/en/travel/hanoi/ha-giang';
      busLink.target = '_blank';
      busLink.rel = 'noopener';
      busLink.addEventListener('click', function (e) { e.stopPropagation(); });
      busPill.appendChild(busLink);
      box.appendChild(busPill);
    }

    if (box.children.length === 0) {
      td.appendChild(ce('span', 'muted small', '—'));
    } else {
      td.appendChild(box);
    }
    trNight.appendChild(td);
  });
  tbody.appendChild(trNight);

  // Row 6: Spend
  var trCost = ce('tr', 'glance-tr');
  trCost.appendChild(ce('td', 'glance-dimension-cell', '💰 Est. Spend'));
  daySlots.forEach(function (ds) {
    var td = ce('td', 'glance-col-day-cell');
    var c = ds.day.day_cost || ds.day.day_cost_estimate;
    td.appendChild(ce('span', 'badge', c ? sgd(c) : '—'));
    trCost.appendChild(td);
  });
  tbody.appendChild(trCost);

  // Row 7: Actions
  var trActions = ce('tr', 'glance-tr');
  trActions.appendChild(ce('td', 'glance-dimension-cell', '⚡ Actions'));
  daySlots.forEach(function (ds) {
    var td = ce('td', 'glance-col-day-cell');
    var actBox = ce('div', null);
    actBox.style.display = 'flex';
    actBox.style.gap = '4px';

    var addBtn = ce('button', 'btn btn-secondary tiny', '+ Add');
    addBtn.title = 'Add activity to Day ' + ds.dayNum;
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openItemEditor(ds.dayNum, -1, null);
    });
    actBox.appendChild(addBtn);

    var detBtn = ce('button', 'btn btn-secondary tiny', 'Deep →');
    detBtn.title = 'Open Day ' + ds.dayNum + ' breakdown';
    detBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      STATE.itineraryViewMode = 'deep-dive';
      STATE.activeDay = ds.dayNum;
      renderItinerary();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    actBox.appendChild(detBtn);

    td.appendChild(actBox);
    trActions.appendChild(td);
  });
  tbody.appendChild(trActions);

  table.appendChild(tbody);
}

function renderStandardMatrix(table, days) {
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
  days.forEach(function (d, dayIdx) {
    var dayNum = d.day || (dayIdx + 1);
    var tr = ce('tr', 'glance-tr');

    var dayCell = ce('td', 'glance-day-cell');
    dayCell.appendChild(ce('div', 'glance-day-num', 'Day ' + dayNum));
    if (d.date) dayCell.appendChild(ce('div', 'glance-day-date', d.date.slice(5)));
    if (d.base) dayCell.appendChild(ce('span', 'glance-day-base', d.base));
    tr.appendChild(dayCell);

    var items = d.items || d.events || d.activities || [];
    var slots = { morning: [], afternoon: [], evening: [], night: [] };
    items.forEach(function (it, itemIdx) {
      var w = (it.what || it.title || it.activity || it.name || '');
      if (it.time === '—' && (w.toLowerCase().includes('food & drink') || w.toLowerCase().includes('local transport') || w.toLowerCase().includes('lodging:'))) return;
      var slot = categorizeItemSlot(it);
      slots[slot].push({ it: it, itemIdx: itemIdx });
    });

    function createStandardSlotCell(list) {
      var td = ce('td', 'glance-slot-cell');
      if (list.length === 0) {
        td.appendChild(ce('span', 'muted small', '—'));
      } else {
        var box = ce('div', 'glance-slot-list');
        list.forEach(function (entry) {
          box.appendChild(createEventPill(dayNum, entry.itemIdx, entry.it));
        });
        td.appendChild(box);
      }
      return td;
    }

    tr.appendChild(createStandardSlotCell(slots.morning));
    tr.appendChild(createStandardSlotCell(slots.afternoon));
    tr.appendChild(createStandardSlotCell(slots.evening));

    var nightTd = ce('td', 'glance-slot-cell');
    var nightBox = ce('div', 'glance-slot-list');
    slots.night.forEach(function (entry) {
      nightBox.appendChild(createEventPill(dayNum, entry.itemIdx, entry.it));
    });

    if (d.lodging) {
      var lodgingShort = d.lodging.split('—')[0].replace('acc-', 'Acc-');
      if (d.lodging.includes('—')) lodgingShort = d.lodging.split('—')[1].split(',')[0].trim();
      var stayPill = ce('div', 'glance-stay-pill');
      stayPill.appendChild(ce('span', null, '🏨 ' + lodgingShort));
      nightBox.appendChild(stayPill);
    } else if (d.transit && d.transit.toLowerCase().includes('sleeper')) {
      var busPill = ce('div', 'glance-stay-pill', '🚌 Sleeper Bus');
      nightBox.appendChild(busPill);
    }

    if (nightBox.children.length === 0) {
      nightTd.appendChild(ce('span', 'muted small', '—'));
    } else {
      nightTd.appendChild(nightBox);
    }
    tr.appendChild(nightTd);

    var costTd = ce('td', 'glance-cost-cell');
    var c = d.day_cost || d.day_cost_estimate;
    costTd.appendChild(ce('span', 'badge', c ? sgd(c) : '—'));
    tr.appendChild(costTd);

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

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function createEventPill(dayNum, itemIdx, it) {
  var pill = ce('div', 'glance-event-pill');
  pill.title = 'Click to edit: ' + (it.what || it.title || 'Activity');

  var header = ce('div', 'glance-pill-header');
  if (it.time && it.time !== '—') {
    header.appendChild(ce('span', 'glance-event-time', it.time.replace(' (assumed)', '')));
  }
  header.appendChild(ce('span', 'glance-edit-icon', '✏️'));
  pill.appendChild(header);

  var title = ce('div', 'glance-pill-title', it.what || it.title || it.activity || it.name || 'Event');
  pill.appendChild(title);

  if (it.booking_url || (it.refs && it.refs.length > 0)) {
    var actions = ce('div', 'glance-pill-actions');
    var bUrl = it.booking_url || it.refs[0];
    var bLabel = it.booking_platform || (bUrl.includes('klook') ? 'Klook ↗' : (bUrl.includes('booking.com') ? 'Booking ↗' : (bUrl.includes('12go') ? '12Go ↗' : 'Book ↗')));
    var bLink = ce('a', 'glance-booking-link', '🏷️ ' + bLabel);
    bLink.href = bUrl;
    bLink.target = '_blank';
    bLink.rel = 'noopener';
    bLink.addEventListener('click', function (e) { e.stopPropagation(); });
    actions.appendChild(bLink);
    pill.appendChild(actions);
  }

  pill.addEventListener('click', function () {
    openItemEditor(dayNum, itemIdx, it);
  });

  return pill;
}

/* ------------------------------------------------------------- ITEM EDITOR */

function openItemEditor(dayNum, itemIndex, item) {
  STATE.editingItem = {
    dayNum: dayNum,
    itemIndex: itemIndex,
    item: item || {}
  };

  $('#item-editor-modal-title').textContent = itemIndex >= 0 ? ('Edit Activity — Day ' + dayNum) : ('Add Activity to Day ' + dayNum);
  $('#edit-item-day').value = dayNum;
  $('#edit-item-index').value = itemIndex;

  $('#edit-item-time').value = (item && item.time) ? item.time : '09:00';
  $('#edit-item-what').value = (item && (item.what || item.title || item.activity || item.name)) || '';
  $('#edit-item-cost').value = (item && item.cost != null) ? item.cost : '0';
  $('#edit-item-currency').value = (item && item.currency) || 'SGD';
  $('#edit-item-booking-url').value = (item && item.booking_url) || ((item && item.refs && item.refs[0]) || '');
  $('#edit-item-notes').value = (item && item.notes) || '';

  var slot = item ? categorizeItemSlot(item) : 'morning';
  $('#edit-item-slot').value = slot;

  var testBtn = $('#edit-item-booking-test-btn');
  if (testBtn) {
    var url = $('#edit-item-booking-url').value.trim();
    testBtn.hidden = !url;
    testBtn.href = url || '#';
  }

  var delBtn = $('#edit-item-delete-btn');
  if (delBtn) delBtn.hidden = (itemIndex < 0);

  $('#item-editor-modal').hidden = false;
}

function closeItemEditor() {
  $('#item-editor-modal').hidden = true;
  STATE.editingItem = null;
}

function saveItemEditor() {
  if (!STATE.editingItem) return;
  var dayNum = parseInt($('#edit-item-day').value, 10);
  var itemIndex = parseInt($('#edit-item-index').value, 10);

  var what = $('#edit-item-what').value.trim();
  if (!what) {
    alert('Please enter an activity name.');
    return;
  }

  var time = $('#edit-item-time').value.trim() || '—';
  var cost = parseFloat($('#edit-item-cost').value) || 0;
  var currency = $('#edit-item-currency').value;
  var bookingUrl = $('#edit-item-booking-url').value.trim();
  var notes = $('#edit-item-notes').value.trim();

  var days = getItineraryDays();
  var dayObj = days.find(function (d, i) { return (d.day || i + 1) === dayNum; });
  if (!dayObj) return;

  if (!dayObj.items) dayObj.items = [];

  var updatedItem = {
    time: time,
    what: what,
    cost: cost,
    currency: currency,
    notes: notes,
    booking_url: bookingUrl || undefined,
    booking_platform: bookingUrl ? (bookingUrl.includes('klook') ? 'Klook' : (bookingUrl.includes('booking.com') ? 'Booking.com' : (bookingUrl.includes('12go') ? '12Go' : (bookingUrl.includes('airbnb') ? 'Airbnb' : 'Direct Booking')))) : undefined,
    refs: bookingUrl ? [bookingUrl] : []
  };

  if (itemIndex >= 0 && itemIndex < dayObj.items.length) {
    dayObj.items[itemIndex] = Object.assign({}, dayObj.items[itemIndex], updatedItem);
  } else {
    dayObj.items.push(updatedItem);
  }

  // Recalculate day cost
  var total = 0;
  dayObj.items.forEach(function (it) { if (it.cost) total += Number(it.cost); });
  dayObj.day_cost = total;
  dayObj.day_cost_estimate = total;

  closeItemEditor();
  saveItineraryDoc();
  renderItinerary();
  showToast('Saved "' + what + '" to Day ' + dayNum + '!');
}

function deleteItemEditor() {
  if (!STATE.editingItem || STATE.editingItem.itemIndex < 0) return;
  var dayNum = STATE.editingItem.dayNum;
  var itemIndex = STATE.editingItem.itemIndex;

  var days = getItineraryDays();
  var dayObj = days.find(function (d, i) { return (d.day || i + 1) === dayNum; });
  if (!dayObj || !dayObj.items) return;

  dayObj.items.splice(itemIndex, 1);
  closeItemEditor();
  saveItineraryDoc();
  renderItinerary();
  showToast('Removed activity from Day ' + dayNum);
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
        var titleEl = ce('div', 'item-title', titleText);
        titleEl.style.cursor = 'pointer';
        titleEl.title = 'Click to edit activity';
        titleEl.addEventListener('click', function () {
          openItemEditor(dayNum, evIdx, ev);
        });
        it.appendChild(titleEl);

        if (ev.notes) it.appendChild(ce('p', 'small muted', ev.notes));

        var bUrl = ev.booking_url || (ev.refs && ev.refs[0]);
        var linkBox = ce('div', 'small muted');
        linkBox.style.marginTop = '6px';
        linkBox.style.display = 'flex';
        linkBox.style.alignItems = 'center';
        linkBox.style.gap = '8px';
        linkBox.style.flexWrap = 'wrap';

        if (bUrl) {
          var platName = ev.booking_platform || (bUrl.includes('klook') ? 'Klook' : (bUrl.includes('booking.com') ? 'Booking.com' : (bUrl.includes('12go') ? '12Go' : (bUrl.includes('airbnb') ? 'Airbnb' : (bUrl.includes('google.com/travel/flights') ? 'Google Flights' : 'Direct Booking')))));
          var bookLink = ce('a', 'btn btn-secondary tiny', '🎟 Book on ' + platName + ' ↗');
          bookLink.href = bUrl;
          bookLink.target = '_blank';
          bookLink.rel = 'noopener';
          linkBox.appendChild(bookLink);
        }

        var editBtn = ce('button', 'btn-swap tiny', '✏️ Edit');
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openItemEditor(dayNum, evIdx, ev);
        });
        linkBox.appendChild(editBtn);

        it.appendChild(linkBox);

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

    var matchedStay = stays.find(function (s) {
      var sName = (s.name || s.hotel || '').toLowerCase();
      var lName = leg.hotelName.toLowerCase();
      return (sName && (lName.includes(sName.slice(0, 8)) || sName.includes(lName.slice(0, 8))));
    });
    var bookUrl = (matchedStay && (matchedStay.booking_url || matchedStay.link)) || leg.booking_url;
    if (bookUrl) {
      var plat = (matchedStay && matchedStay.booking_platform) || (bookUrl.includes('booking.com') ? 'Booking.com' : (bookUrl.includes('airbnb') ? 'Airbnb' : 'Online'));
      var bLink = ce('a', 'glance-booking-link', 'Book (' + plat + ') ↗');
      bLink.href = bookUrl;
      bLink.target = '_blank';
      bLink.rel = 'noopener';
      bLink.style.display = 'inline-block';
      bLink.style.marginTop = '4px';
      hCell.appendChild(bLink);
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

    var bookingUrl = s.booking_url || s.link || s.source_url;
    if (bookingUrl) {
      var linkRow = ce('div', 'stay-price-line');
      linkRow.style.marginTop = '8px';
      linkRow.style.display = 'flex';
      linkRow.style.alignItems = 'center';
      linkRow.style.gap = '8px';
      linkRow.style.flexWrap = 'wrap';

      var plat = s.booking_platform || (bookingUrl.includes('booking.com') ? 'Booking.com' : (bookingUrl.includes('airbnb') ? 'Airbnb' : 'Online Listing'));
      var aTag = ce('a', 'btn btn-secondary small', '🏨 Book on ' + plat + ' ↗');
      aTag.href = bookingUrl;
      aTag.target = '_blank';
      aTag.rel = 'noopener';
      aTag.style.textDecoration = 'none';
      linkRow.appendChild(aTag);

      if (s.direct_url) {
        var dirTag = ce('a', 'muted small', 'Official Hotel Site ↗');
        dirTag.href = s.direct_url;
        dirTag.target = '_blank';
        dirTag.rel = 'noopener';
        dirTag.style.marginLeft = '4px';
        linkRow.appendChild(dirTag);
      }
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

/* ==========================================================================
   8. TRAVELLERS & PASSPORTS TAB
   ========================================================================== */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskPassport(str) {
  if (!str) return '—';
  var s = String(str).trim();
  if (!STATE.maskPassports) return s;
  if (s.length <= 3) return '•••';
  var first = s.slice(0, 1);
  var last = s.slice(-2);
  var dots = '•'.repeat(Math.max(3, s.length - 3));
  return first + dots + last;
}

function calculatePassportValidity(expiryStr) {
  if (!expiryStr) {
    return {
      statusText: 'No Expiry Set',
      tagClass: 'warn',
      months: null
    };
  }
  var exp = new Date(expiryStr);
  if (isNaN(exp.getTime())) {
    return {
      statusText: 'Invalid Date',
      tagClass: 'warn',
      months: null
    };
  }
  var now = new Date();
  var diffMs = exp.getTime() - now.getTime();
  var months = diffMs / (1000 * 60 * 60 * 24 * 30.4375);

  if (months < 0) {
    return {
      statusText: '❌ Expired',
      tagClass: 'danger',
      months: months
    };
  }
  if (months < 6) {
    return {
      statusText: '⚠️ Expiring in ' + Math.max(0, Math.round(months)) + ' mos (Renewal required)',
      tagClass: 'danger',
      months: months
    };
  }
  if (months < 12) {
    return {
      statusText: '⚠️ Valid (~' + Math.round(months) + ' mos left)',
      tagClass: 'warn',
      months: months
    };
  }
  return {
    statusText: '✅ Valid (' + (months / 12).toFixed(1) + ' yrs left)',
    tagClass: 'good',
    months: months
  };
}

function copyPassportInfo(t, label) {
  var lines = [];
  lines.push('Traveller: ' + (t.full_name || '—'));
  if (t.passport_number) lines.push('Passport No: ' + t.passport_number);
  if (t.nationality) lines.push('Nationality: ' + t.nationality);
  if (t.date_of_birth) lines.push('DOB: ' + t.date_of_birth);
  if (t.expiry_date) lines.push('Passport Expiry: ' + t.expiry_date);
  if (t.emergency_contact_name || t.emergency_contact_phone) {
    lines.push('Emergency Contact: ' + (t.emergency_contact_name || '') + ' (' + (t.emergency_contact_phone || '') + ')');
  }
  if (t.notes) lines.push('Notes: ' + t.notes);

  var text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      showToast('Copied ' + (label || (t.full_name || 'passport')) + ' info!');
    }).catch(function () {
      prompt('Copy passport details:', text);
    });
  } else {
    prompt('Copy passport details:', text);
  }
}

function saveTravellersDoc() {
  if (STATE.activeTripId) {
    TripAuth.saveDocs(STATE.activeTripId, { travellers: STATE.docs.travellers }).catch(function (e) {
      console.warn('Failed to sync travellers to cloud:', e);
    });
    try {
      localStorage.setItem('nomad_travellers_override_' + STATE.activeTripId, JSON.stringify(STATE.docs.travellers));
    } catch (e) {}
  }
}

function renderTravellers() {
  var root = $('#tab-travellers');
  clear(root);

  var data = getTravellersData();
  STATE.docs.travellers = data;

  var container = ce('div', 'travellers-section');

  // Top header with actions
  var header = ce('div', 'view-mode-bar');
  var titleBox = ce('div');
  titleBox.appendChild(ce('h2', null, '🛂 Passports & Travelling Party'));
  titleBox.appendChild(ce('div', 'muted small', 'Secure travel document records for flight bookings, check-ins, and immigration checks'));
  header.appendChild(titleBox);

  var actionsBox = ce('div', 'table-toolbar-left');
  var maskBtn = ce('button', 'btn btn-secondary small', STATE.maskPassports ? '👁️ Reveal Numbers' : '🔒 Mask Numbers');
  maskBtn.addEventListener('click', function () {
    STATE.maskPassports = !STATE.maskPassports;
    renderTravellers();
  });
  actionsBox.appendChild(maskBtn);

  var addCompBtn = ce('button', 'btn small', '➕ Add Companion');
  addCompBtn.addEventListener('click', function () {
    openTravellerEditor(null, false);
  });
  actionsBox.appendChild(addCompBtn);
  header.appendChild(actionsBox);
  container.appendChild(header);

  // Immigration Advisory Card
  var noticeCard = ce('div', 'passport-notice-card');
  var noticeIcon = ce('div', 'notice-icon', 'ℹ️');
  noticeCard.appendChild(noticeIcon);
  var noticeContent = ce('div');
  noticeContent.appendChild(ce('div', 'notice-title', 'Vietnam Immigration & Visa-Free Advisory'));
  noticeContent.appendChild(ce('p', 'notice-text', 'Singapore passport holders enjoy visa-free entry to Vietnam for up to 30 days. Immigration strictly requires a minimum of 6 months passport validity upon entry date. Verify all travellers have sufficient validity before travelling.'));
  noticeCard.appendChild(noticeContent);
  container.appendChild(noticeCard);

  // Passports Grid
  var grid = ce('div', 'passports-grid');

  // 1. My Passport Card (Primary)
  var myPassport = data.my_passport || {};
  grid.appendChild(createPassportCard(myPassport, true));

  // 2. Companion Cards
  var companions = data.companions || [];
  companions.forEach(function (comp) {
    grid.appendChild(createPassportCard(comp, false));
  });

  container.appendChild(grid);
  root.appendChild(container);
}

function createPassportCard(t, isSelf) {
  var card = ce('div', 'passport-card' + (isSelf ? ' self-card' : ''));

  // Header
  var head = ce('div', 'passport-card-header');
  var badge = ce('span', 'passport-badge', isSelf ? '⭐ Primary Traveller (You)' : ('👥 ' + (t.relationship || 'Companion')));
  head.appendChild(badge);

  var val = calculatePassportValidity(t.expiry_date);
  var valTag = ce('span', 'validity-tag ' + val.tagClass, val.statusText);
  head.appendChild(valTag);
  card.appendChild(head);

  // Name
  var nameEl = ce('h3', 'passport-holder-name', t.full_name || 'Unnamed Traveller');
  card.appendChild(nameEl);

  // Meta Grid
  var metaGrid = ce('div', 'passport-meta-list');

  // Passport Number
  var mPass = ce('div');
  mPass.appendChild(ce('div', 'meta-item-label', 'Passport Number'));
  var passVal = ce('div', 'meta-item-val passport-masked-val', maskPassport(t.passport_number));
  mPass.appendChild(passVal);
  metaGrid.appendChild(mPass);

  // Nationality
  var mNat = ce('div');
  mNat.appendChild(ce('div', 'meta-item-label', 'Nationality'));
  mNat.appendChild(ce('div', 'meta-item-val', '🇸🇬 ' + (t.nationality || 'Singapore')));
  metaGrid.appendChild(mNat);

  // Expiry Date
  var mExp = ce('div');
  mExp.appendChild(ce('div', 'meta-item-label', 'Expiry Date'));
  mExp.appendChild(ce('div', 'meta-item-val', t.expiry_date || '—'));
  metaGrid.appendChild(mExp);

  // Date of Birth
  var mDob = ce('div');
  mDob.appendChild(ce('div', 'meta-item-label', 'Date of Birth'));
  mDob.appendChild(ce('div', 'meta-item-val', t.date_of_birth || '—'));
  metaGrid.appendChild(mDob);

  // Emergency contact (if present)
  if (t.emergency_contact_name || t.emergency_contact_phone) {
    var mEm = ce('div');
    mEm.style.gridColumn = '1 / -1';
    mEm.appendChild(ce('div', 'meta-item-label', 'Emergency Contact'));
    var emStr = (t.emergency_contact_name || '') + (t.emergency_contact_phone ? (' (' + t.emergency_contact_phone + ')') : '');
    mEm.appendChild(ce('div', 'meta-item-val', '📞 ' + emStr));
    metaGrid.appendChild(mEm);
  }

  // Notes
  if (t.notes) {
    var mNotes = ce('div');
    mNotes.style.gridColumn = '1 / -1';
    mNotes.appendChild(ce('div', 'meta-item-label', 'Notes'));
    mNotes.appendChild(ce('div', 'small muted', t.notes));
    metaGrid.appendChild(mNotes);
  }

  card.appendChild(metaGrid);

  // Actions
  var actions = ce('div', 'passport-card-actions');

  var copyBtn = ce('button', 'btn btn-secondary tiny', '📋 Copy');
  copyBtn.title = 'Copy passport information to clipboard for bookings';
  copyBtn.addEventListener('click', function () {
    copyPassportInfo(t, isSelf ? 'my passport' : t.full_name);
  });
  actions.appendChild(copyBtn);

  var editBtn = ce('button', 'btn btn-secondary tiny', '✏️ Edit');
  editBtn.addEventListener('click', function () {
    openTravellerEditor(t, isSelf);
  });
  actions.appendChild(editBtn);

  if (!isSelf) {
    var delBtn = ce('button', 'btn-icon-danger tiny', '🗑️');
    delBtn.title = 'Remove companion';
    delBtn.addEventListener('click', function () {
      deleteCompanion(t.id, t.full_name);
    });
    actions.appendChild(delBtn);
  }

  card.appendChild(actions);
  return card;
}

function openTravellerEditor(traveller, isSelf) {
  STATE.editingTraveller = {
    isSelf: isSelf,
    traveller: traveller || {}
  };

  $('#edit-traveller-is-self').value = isSelf ? 'true' : 'false';
  $('#edit-traveller-id').value = (!isSelf && traveller) ? (traveller.id || '') : '';

  $('#traveller-editor-title').textContent = isSelf ? 'Edit My Passport Details' : (traveller ? 'Edit Traveller Details' : 'Add Accompanying Traveller');

  $('#edit-traveller-name').value = (traveller && traveller.full_name) || '';
  $('#edit-traveller-passport').value = (traveller && traveller.passport_number) || '';
  $('#edit-traveller-nationality').value = (traveller && traveller.nationality) || 'Singapore';
  $('#edit-traveller-dob').value = (traveller && traveller.date_of_birth) || '';
  $('#edit-traveller-expiry').value = (traveller && traveller.expiry_date) || '';
  $('#edit-traveller-relationship').value = (traveller && traveller.relationship) || 'Travel Companion';
  $('#edit-traveller-emergency-name').value = (traveller && traveller.emergency_contact_name) || '';
  $('#edit-traveller-emergency-phone').value = (traveller && traveller.emergency_contact_phone) || '';
  $('#edit-traveller-notes').value = (traveller && traveller.notes) || '';

  var relGroup = $('#traveller-relationship-group');
  if (relGroup) relGroup.hidden = !!isSelf;

  var delBtn = $('#edit-traveller-delete-btn');
  if (delBtn) delBtn.hidden = isSelf || !traveller || !traveller.id;

  $('#traveller-editor-modal').hidden = false;
}

function closeTravellerEditor() {
  $('#traveller-editor-modal').hidden = true;
  STATE.editingTraveller = null;
}

function saveTravellerEditor() {
  if (!STATE.editingTraveller) return;
  var isSelf = $('#edit-traveller-is-self').value === 'true';
  var id = $('#edit-traveller-id').value;

  var name = $('#edit-traveller-name').value.trim();
  if (!name) {
    alert('Please enter traveller full name.');
    return;
  }

  var passNo = $('#edit-traveller-passport').value.trim();
  var nat = $('#edit-traveller-nationality').value.trim() || 'Singapore';
  var dob = $('#edit-traveller-dob').value;
  var expiry = $('#edit-traveller-expiry').value;
  var rel = $('#edit-traveller-relationship').value.trim() || 'Companion';
  var emName = $('#edit-traveller-emergency-name').value.trim();
  var emPhone = $('#edit-traveller-emergency-phone').value.trim();
  var notes = $('#edit-traveller-notes').value.trim();

  var data = getTravellersData();
  if (!data.companions) data.companions = [];

  if (isSelf) {
    data.my_passport = {
      full_name: name,
      passport_number: passNo,
      nationality: nat,
      date_of_birth: dob,
      expiry_date: expiry,
      emergency_contact_name: emName,
      emergency_contact_phone: emPhone,
      notes: notes
    };
  } else {
    var compObj = {
      id: id || ('comp-' + Date.now()),
      full_name: name,
      relationship: rel,
      passport_number: passNo,
      nationality: nat,
      date_of_birth: dob,
      expiry_date: expiry,
      emergency_contact_name: emName,
      emergency_contact_phone: emPhone,
      notes: notes
    };
    if (id) {
      var idx = data.companions.findIndex(function (c) { return c.id === id; });
      if (idx >= 0) data.companions[idx] = compObj;
      else data.companions.push(compObj);
    } else {
      data.companions.push(compObj);
    }
  }

  STATE.docs.travellers = data;
  saveTravellersDoc();
  closeTravellerEditor();
  renderTravellers();
  showToast('Passport details saved for ' + name + '!');
}

function deleteCompanion(id, name) {
  if (!confirm('Remove companion "' + (name || 'traveller') + '"?')) return;
  var data = getTravellersData();
  if (data.companions) {
    data.companions = data.companions.filter(function (c) { return c.id !== id; });
  }
  STATE.docs.travellers = data;
  saveTravellersDoc();
  if ($('#traveller-editor-modal') && !$('#traveller-editor-modal').hidden) {
    closeTravellerEditor();
  }
  renderTravellers();
  showToast('Removed companion.');
}

/* ==========================================================================
   9. CLEAN PDF EXPORT & PRINT VIEWER
   ========================================================================== */

function buildPrintableDocument() {
  var t = STATE.docs.trip || STATE.trip || {};
  var tripTitle = t.name || t.title || 'Nomad Itinerary';
  var destination = t.destination || 'Vietnam (Hanoi · Ha Giang · Ninh Binh)';
  var dateStr = (t.start_date && t.end_date) ? (t.start_date.slice(0, 10) + ' to ' + t.end_date.slice(0, 10)) : 'End 2026';
  var days = getItineraryDays();
  var b = calculateBudget();
  var travellersData = getTravellersData();

  var html = [];
  html.push('<div class="print-document">');

  // Header
  html.push('  <div class="print-header">');
  html.push('    <div>');
  html.push('      <div style="font-size: 0.8rem; font-weight: 700; color: #2563eb; letter-spacing: 0.05em; text-transform: uppercase;">Nomad Trip Plan</div>');
  html.push('      <h1 class="print-title">' + escapeHtml(tripTitle) + '</h1>');
  html.push('      <p class="print-sub">📍 ' + escapeHtml(destination) + ' &nbsp;·&nbsp; 🗓️ ' + escapeHtml(dateStr) + ' &nbsp;·&nbsp; ⏱️ ' + days.length + ' Days</p>');
  html.push('    </div>');
  html.push('    <div style="text-align: right;">');
  html.push('      <div style="font-size: 0.75rem; color: #6b7280;">Planned Budget</div>');
  html.push('      <div style="font-size: 1.15rem; font-weight: 800; color: #111827;">' + sgd(b.cap) + ' / pax</div>');
  html.push('      <div style="font-size: 0.72rem; color: #059669; font-weight: 600;">Est. Net: ' + sgd(b.netPlanned) + '</div>');
  html.push('    </div>');
  html.push('  </div>');

  // Master Table (Flipped layout: Days horizontal columns, Timeslots vertical rows)
  html.push('  <table class="print-table">');
  html.push('    <thead>');
  html.push('      <tr>');
  html.push('        <th class="print-th" style="width: 100px;">Timeline</th>');
  days.forEach(function (d, i) {
    var dayNum = d.day || (i + 1);
    html.push('        <th class="print-th">');
    html.push('          <div style="font-weight: 800; color: #111827;">Day ' + dayNum + '</div>');
    if (d.base) html.push('          <div style="font-size: 0.65rem; color: #2563eb; font-weight: 600;">' + escapeHtml(d.base) + '</div>');
    if (d.date) html.push('          <div style="font-size: 0.65rem; color: #6b7280;">' + escapeHtml(d.date.slice(5)) + '</div>');
    html.push('        </th>');
  });
  html.push('      </tr>');
  html.push('    </thead>');
  html.push('    <tbody>');

  // Categorize slots
  var daySlots = days.map(function (d, i) {
    var items = d.items || d.events || d.activities || [];
    var slots = { morning: [], afternoon: [], evening: [], night: [] };
    items.forEach(function (it) {
      var w = (it.what || it.title || it.activity || it.name || '');
      if (it.time === '—' && (w.toLowerCase().includes('food & drink') || w.toLowerCase().includes('local transport') || w.toLowerCase().includes('lodging:'))) return;
      var slot = categorizeItemSlot(it);
      slots[slot].push(it);
    });
    return { day: d, dayNum: d.day || (i + 1), slots: slots };
  });

  // Focus Row
  html.push('      <tr>');
  html.push('        <td class="print-td" style="font-weight: 700; background: #f9fafb;">📍 Focus</td>');
  daySlots.forEach(function (ds) {
    var focus = ds.day.title ? ds.day.title.split('—')[0].trim() : (ds.day.base || '—');
    html.push('        <td class="print-td" style="font-weight: 600; color: #374151;">' + escapeHtml(focus) + '</td>');
  });
  html.push('      </tr>');

  // Helper for printing slot row
  function printSlotRow(slotName, label) {
    html.push('      <tr>');
    html.push('        <td class="print-td" style="font-weight: 700; background: #f9fafb;">' + label + '</td>');
    daySlots.forEach(function (ds) {
      var list = ds.slots[slotName];
      html.push('        <td class="print-td">');
      if (list.length === 0) {
        html.push('          <span style="color: #9ca3af;">—</span>');
      } else {
        list.forEach(function (it) {
          var time = (it.time && it.time !== '—') ? ('<b>' + escapeHtml(it.time) + '</b> ') : '';
          var what = escapeHtml(it.what || it.title || it.activity || it.name || 'Activity');
          var cost = (it.cost != null && it.cost > 0) ? (' <span style="color: #059669; font-weight: 600;">(' + sgd(it.cost) + ')</span>') : '';
          html.push('          <div style="margin-bottom: 4px; padding: 2px 4px; background: #f8fafc; border-radius: 3px; border: 1px solid #e2e8f0;">' + time + what + cost + '</div>');
        });
      }
      html.push('        </td>');
    });
    html.push('      </tr>');
  }

  printSlotRow('morning', '🌅 Morning<br><span style="font-size: 0.65rem; color:#6b7280;">06:00-12:00</span>');
  printSlotRow('afternoon', '☀️ Afternoon<br><span style="font-size: 0.65rem; color:#6b7280;">12:00-17:00</span>');
  printSlotRow('evening', '🌆 Evening<br><span style="font-size: 0.65rem; color:#6b7280;">17:00-20:30</span>');

  // Night & Lodging Row
  html.push('      <tr>');
  html.push('        <td class="print-td" style="font-weight: 700; background: #f9fafb;">🌙 Lodging &amp; Night</td>');
  daySlots.forEach(function (ds) {
    html.push('        <td class="print-td">');
    ds.slots.night.forEach(function (it) {
      var time = (it.time && it.time !== '—') ? ('<b>' + escapeHtml(it.time) + '</b> ') : '';
      var what = escapeHtml(it.what || it.title || it.activity || it.name || 'Activity');
      html.push('          <div style="margin-bottom: 3px; font-size: 0.68rem;">' + time + what + '</div>');
    });
    if (ds.day.lodging) {
      var l = escapeHtml(ds.day.lodging.includes('—') ? ds.day.lodging.split('—')[1].split(',')[0].trim() : ds.day.lodging);
      html.push('          <div style="font-weight: 700; color: #1e40af; font-size: 0.7rem; margin-top: 2px;">🏨 ' + l + '</div>');
    } else if (ds.day.transit && ds.day.transit.toLowerCase().includes('sleeper')) {
      html.push('          <div style="font-weight: 700; color: #b45309; font-size: 0.7rem; margin-top: 2px;">🚌 Sleeper Bus</div>');
    }
    html.push('        </td>');
  });
  html.push('      </tr>');

  // Est Spend Row
  html.push('      <tr>');
  html.push('        <td class="print-td" style="font-weight: 700; background: #f9fafb;">💰 Est. Spend</td>');
  daySlots.forEach(function (ds) {
    var c = ds.day.day_cost || ds.day.day_cost_estimate;
    html.push('        <td class="print-td" style="font-weight: 700; color: #059669;">' + (c ? sgd(c) : '—') + '</td>');
  });
  html.push('      </tr>');

  html.push('    </tbody>');
  html.push('  </table>');

  // Travellers & Emergency Contacts Summary Table (Clean compact table)
  var allTravellers = [];
  if (travellersData.my_passport && travellersData.my_passport.full_name) {
    allTravellers.push(Object.assign({ role: 'Primary' }, travellersData.my_passport));
  }
  if (Array.isArray(travellersData.companions)) {
    travellersData.companions.forEach(function (c) {
      allTravellers.push(Object.assign({ role: c.relationship || 'Companion' }, c));
    });
  }

  if (allTravellers.length > 0) {
    html.push('  <div style="margin-top: 18px; border-top: 1px solid #e5e7eb; padding-top: 12px;">');
    html.push('    <div style="font-size: 0.8rem; font-weight: 700; color: #374151; margin-bottom: 6px;">🛂 Travelling Party &amp; Emergency Contacts</div>');
    html.push('    <table class="print-table" style="font-size: 0.7rem;">');
    html.push('      <thead>');
    html.push('        <tr>');
    html.push('          <th class="print-th">Role</th>');
    html.push('          <th class="print-th">Full Name (as in Passport)</th>');
    html.push('          <th class="print-th">Passport No</th>');
    html.push('          <th class="print-th">Nationality</th>');
    html.push('          <th class="print-th">Expiry Date</th>');
    html.push('          <th class="print-th">Emergency Contact</th>');
    html.push('        </tr>');
    html.push('      </thead>');
    html.push('      <tbody>');
    allTravellers.forEach(function (tr) {
      var em = (tr.emergency_contact_name || '') + (tr.emergency_contact_phone ? (' (' + tr.emergency_contact_phone + ')') : '');
      html.push('        <tr>');
      html.push('          <td class="print-td" style="font-weight: 600;">' + escapeHtml(tr.role) + '</td>');
      html.push('          <td class="print-td" style="font-weight: 700;">' + escapeHtml(tr.full_name || '—') + '</td>');
      html.push('          <td class="print-td" style="font-family: monospace;">' + escapeHtml(tr.passport_number || '—') + '</td>');
      html.push('          <td class="print-td">' + escapeHtml(tr.nationality || 'Singapore') + '</td>');
      html.push('          <td class="print-td">' + escapeHtml(tr.expiry_date || '—') + '</td>');
      html.push('          <td class="print-td">' + escapeHtml(em || '—') + '</td>');
      html.push('        </tr>');
    });
    html.push('      </tbody>');
    html.push('    </table>');
    html.push('  </div>');
  }

  // Footer
  html.push('  <div style="margin-top: 14px; display: flex; justify-content: space-between; font-size: 0.65rem; color: #9ca3af;">');
  html.push('    <span>Generated with Nomad Trip Planner (PWA) · Valid for international check-in &amp; offline access</span>');
  html.push('    <span>' + new Date().toLocaleDateString() + '</span>');
  html.push('  </div>');

  html.push('</div>');
  return html.join('\n');
}

function openPdfPreview() {
  var content = $('#pdf-preview-content');
  if (content) {
    content.innerHTML = buildPrintableDocument();
  }
  var modal = $('#pdf-export-modal');
  if (modal) modal.hidden = false;
}

function closePdfPreview() {
  var modal = $('#pdf-export-modal');
  if (modal) modal.hidden = true;
}

function printPdfItinerary() {
  window.print();
}

function openPdfInNewTab() {
  var printableHtml = buildPrintableDocument();
  var fullHtml = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">',
    '<title>Nomad Itinerary — Print / PDF</title>',
    '<style>',
    '  * { box-sizing: border-box; }',
    '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 16px; background: #f8fafc; color: #111827; }',
    '  .print-document { background: #fff; padding: 20px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 1400px; margin: 0 auto; }',
    '  .print-header { display: flex; justify-content: space-between; border-bottom: 2px solid #111827; padding-bottom: 10px; margin-bottom: 12px; }',
    '  .print-title { font-size: 1.3rem; font-weight: 800; margin: 2px 0; }',
    '  .print-sub { font-size: 0.8rem; color: #4b5563; margin: 0; }',
    '  .print-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }',
    '  .print-th, .print-td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: top; }',
    '  .print-th { background: #f3f4f6; text-align: left; }',
    '  .no-print { display: flex; justify-content: space-between; align-items: center; max-width: 1400px; margin: 0 auto 12px auto; background: #e0f2fe; border: 1px solid #bae6fd; padding: 10px 14px; border-radius: 6px; font-size: 0.82rem; }',
    '  .btn-print { background: #0284c7; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 0.82rem; }',
    '  @media print {',
    '    @page { size: landscape; margin: 8mm; }',
    '    body { background: #fff; margin: 0; padding: 0; }',
    '    .no-print { display: none !important; }',
    '    .print-document { box-shadow: none; padding: 0; }',
    '  }',
    '</style>',
    '</head>',
    '<body>',
    '  <div class="no-print">',
    '    <span>💡 <b>Pinch to zoom</b> or scroll freely on mobile. Tap button to save as clean landscape PDF.</span>',
    '    <button class="btn-print" onclick="window.print()">🖨️ Save as PDF / Print</button>',
    '  </div>',
    printableHtml,
    '</body>',
    '</html>'
  ].join('\n');

  var blob = new Blob([fullHtml], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  window.open(url, '_blank');
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

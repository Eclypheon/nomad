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
  staySortMode: 'night',       /* 'night' (group by night) or 'location' */
  expandedNightGroups: {},     /* { [groupId]: boolean } for collapsed alternatives */
  expenseSort: 'cost-desc',    /* 'cost-desc', 'cost-asc', 'cat', 'name' */
  expenseFilterCat: 'all',     /* 'all', 'accommodation', 'transport', 'food', 'activities', 'misc' */
  recLocation: 'all',          /* 'all', 'Hanoi', 'Ha Giang', 'Ninh Binh' */
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

function applyDecisionsToSchedule(days) {
  if (!Array.isArray(days) || !days.length) return days;

  var cloned = days.map(function (d) {
    return Object.assign({}, d, {
      items: Array.isArray(d.items) ? d.items.map(function (it) { return Object.assign({}, it); }) : []
    });
  });

  var decDatesPick = getActivePick({ id: 'dec-dates' });
  var decNyePick = getActivePick({ id: 'dec-nye' });
  var decRidePick = getActivePick({ id: 'dec-ride' });
  var decBoatPick = getActivePick({ id: 'dec-boat' });
  var decFoodPick = getActivePick({ id: 'dec-food' });

  // 1. Shift dates if dec-dates is shifted (+2 days: 26 Dec - 3 Jan)
  if (decDatesPick === 'opt-dates-shifted') {
    cloned.forEach(function (d) {
      if (d.date) {
        var baseDate = new Date(d.date);
        if (!isNaN(baseDate.getTime())) {
          baseDate.setDate(baseDate.getDate() + 2);
          var m = String(baseDate.getMonth() + 1).padStart(2, '0');
          var dayNum = String(baseDate.getDate()).padStart(2, '0');
          d.date = baseDate.getFullYear() + '-' + m + '-' + dayNum;
        }
      }
    });
  }

  // 2. dec-nye: Tam Coc vs Hanoi New Year's Eve
  if (decNyePick === 'opt-tamcoc-nye') {
    var day8 = cloned.find(function (d, i) { return (d.day || i + 1) === 8; });
    if (day8) {
      day8.base = 'Tam Coc';
      day8.title = 'Tam Coc — Countryside New Year\'s Eve';
      day8.lodging = 'acc-015 — Tam Coc Garden Resort';
      if (day8.items) {
        day8.items.forEach(function (it) {
          var w = (it.what || '').toLowerCase();
          if (w.includes('la siesta') || w.includes('hoan kiem') || w.includes('fireworks')) {
            it.what = 'Peaceful countryside New Year countdown & dinner in Tam Coc';
            it.notes = 'Quiet NYE surrounded by limestone karsts; avoiding Hanoi lake crowds';
          }
        });
      }
    }
    var day9 = cloned.find(function (d, i) { return (d.day || i + 1) === 9; });
    if (day9) {
      day9.title = 'Tam Coc → Noi Bai Airport (Evening Departure)';
      day9.transit = 'Private minivan Tam Coc → Noi Bai (2h) for flight back to Singapore';
    }
  }

  // 3. dec-ride: Easy Rider vs Self-Drive
  var isSelfDrive = (decRidePick === 'opt-ride-self-drive');
  cloned.forEach(function (d) {
    if (d.items) {
      d.items.forEach(function (it) {
        var w = (it.what || '').toLowerCase();
        if (w.includes('easy rider') && isSelfDrive) {
          it.what = it.what.replace(/Easy Rider.*?\)/i, 'Self-drive motorbike)');
          it.notes = (it.notes || '') + ' (Self-riding 125cc semi-automatic; riding with group)';
        } else if (w.includes('self-drive') && !isSelfDrive) {
          it.what = it.what.replace(/Self-drive.*?\)/i, 'Easy Rider pillion)');
        }
      });
    }
  });

  // 4. dec-boat: Trang An vs Tam Coc vs Both
  if (decBoatPick === 'opt-trang-an-only' || decBoatPick === 'opt-boat-trangan-only') {
    var day8 = cloned.find(function (d, i) { return (d.day || i + 1) === 8; });
    if (day8 && day8.items) {
      day8.items.forEach(function (it) {
        var w = (it.what || '').toLowerCase();
        if (w.includes('tam coc boat') || w.includes('tam coc sampan') || w.includes('sampan')) {
          it.what = 'Countryside Breakfast & Village Stroll (Tam Coc)';
          it.type = 'food';
          it.slot = 'morning';
          it.cost = 5;
          it.notes = 'Quiet resort breakfast, pack bags, leisurely stroll before departure';
          delete it.booking_url;
        }
      });
    }
  } else if (decBoatPick === 'opt-tam-coc-only' || decBoatPick === 'opt-boat-tamcoc-only') {
    var day7 = cloned.find(function (d, i) { return (d.day || i + 1) === 7; });
    if (day7 && day7.items) {
      day7.items.forEach(function (it) {
        var w = (it.what || '').toLowerCase();
        if (w.includes('trang an boat') || w.includes('tràng an boat')) {
          it.what = 'Bicycle ride to Bích Động Pagoda & Lotus Paddies';
          it.type = 'activity';
          it.slot = 'morning';
          it.cost = 4;
          it.notes = 'Gentle morning cycle through karst scenery and temple grounds';
          delete it.booking_url;
        }
      });
    }
  }

  // 5. dec-food: Guided Street Food Tour vs Self-Guided Walk
  if (decFoodPick === 'opt-food-diy') {
    var day1 = cloned.find(function (d, i) { return (d.day || i + 1) === 1; });
    if (day1 && day1.items) {
      day1.items.forEach(function (it) {
        if ((it.what || '').toLowerCase().includes('street food')) {
          it.what = 'Old Quarter Self-Guided Street Food Walk';
          it.cost = 12;
          it.notes = 'Self-guided stops at Phở Thìn, Bún Chả Đắc Kim, Egg Coffee';
        }
      });
    }
  }

  // 6. Generic decision schedule_impact handling for structured JSON & AI
  var allDecs = getDecisions();
  allDecs.forEach(function (dec) {
    var pickedOptId = getActivePick(dec);
    var opt = (dec.options || []).find(function (o) { return o.id === pickedOptId; });
    if (!opt) return;

    var impacts = opt.schedule_impact || opt.schedule_changes || opt.impact || [];
    if (!Array.isArray(impacts) && typeof impacts === 'object') {
      impacts = [impacts];
    }
    if (Array.isArray(impacts)) {
      impacts.forEach(function (imp) {
        if (!imp || typeof imp !== 'object') return;
        var dayNum = imp.day || imp.day_num;
        var targetDay = cloned.find(function (d, i) { return (d.day || i + 1) === dayNum; });
        if (!targetDay) return;
        if (!targetDay.items) targetDay.items = [];

        // Support explicit removes list
        var toRemove = imp.removes || imp.remove || [];
        if (typeof toRemove === 'string') toRemove = [toRemove];
        if (Array.isArray(toRemove)) {
          toRemove.forEach(function (rStr) {
            var rLow = String(rStr).toLowerCase();
            targetDay.items = targetDay.items.filter(function (it) {
              return !((it.what || it.title || '').toLowerCase().includes(rLow));
            });
          });
        }

        // Support explicit adds list
        var toAdd = imp.adds || imp.add || [];
        if (toAdd && !Array.isArray(toAdd)) toAdd = [toAdd];
        if (Array.isArray(toAdd)) {
          toAdd.forEach(function (aItem) {
            if (typeof aItem === 'string') aItem = { what: aItem };
            targetDay.items.push(Object.assign({
              time: '10:00',
              what: 'Activity',
              type: 'activity',
              slot: 'morning',
              cost: 0
            }, aItem));
          });
        }

        var action = (imp.action || (imp.target ? 'replace' : '')).toLowerCase();
        var targetKeyword = (imp.target || imp.replace_what || '').toLowerCase();

        if (action === 'replace' && targetKeyword) {
          targetDay.items.forEach(function (it) {
            var w = (it.what || it.title || '').toLowerCase();
            if (w.includes(targetKeyword)) {
              if (imp.item) {
                Object.assign(it, imp.item);
              } else {
                if (imp.what) it.what = imp.what;
                if (imp.type) it.type = imp.type;
                if (imp.slot) it.slot = imp.slot;
                if (imp.cost != null) it.cost = imp.cost;
                if (imp.notes) it.notes = imp.notes;
              }
            }
          });
        } else if (action === 'remove' && targetKeyword) {
          targetDay.items = targetDay.items.filter(function (it) {
            var w = (it.what || it.title || '').toLowerCase();
            return !w.includes(targetKeyword);
          });
        } else if (action === 'add' && (imp.item || imp.what)) {
          var newItem = imp.item ? Object.assign({}, imp.item) : {
            time: imp.time || '10:00',
            what: imp.what,
            type: imp.type || 'activity',
            slot: imp.slot || 'morning',
            cost: imp.cost || 0,
            notes: imp.notes || ''
          };
          targetDay.items.push(newItem);
        }
      });
    }
  });

  return cloned;
}

function getItineraryDays() {
  var d = STATE.docs.itinerary;
  var raw = [];
  if (d) {
    if (Array.isArray(d)) raw = d;
    else raw = d.days || d.itinerary || [];
  }
  return applyDecisionsToSchedule(raw);
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
  // Capture onboarding / invite trip parameter from URL immediately
  try {
    var urlParams = new URLSearchParams(window.location.search);
    var incomingTrip = urlParams.get('trip') || urlParams.get('join');
    if (!incomingTrip) {
      var hashMatch = window.location.hash.match(/(?:trip|join)=([^&]+)/);
      if (hashMatch) {
        try { incomingTrip = decodeURIComponent(hashMatch[1]); } catch (_) { incomingTrip = hashMatch[1]; }
      }
    }
    if (incomingTrip) {
      incomingTrip = incomingTrip.trim();
      sessionStorage.setItem('nomad_pending_join', incomingTrip);
      localStorage.setItem('nomad_pending_join', incomingTrip);
    }
  } catch (e) {
    console.warn('Failed parsing incoming trip parameter:', e);
  }

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
  renderLandingInviteBanner();
}

function renderLandingInviteBanner() {
  var pendingTrip = '';
  try {
    pendingTrip = (sessionStorage && sessionStorage.getItem('nomad_pending_join')) ||
                  (localStorage && localStorage.getItem('nomad_pending_join')) || '';
    pendingTrip = pendingTrip.trim();
  } catch (_) {}
  var banner = $('#landing-invite-banner');
  if (banner) {
    banner.hidden = !pendingTrip;
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

    // Check query params & hash for direct trip / join link: ?trip=<id> or #trip=<id>
    var urlParams = new URLSearchParams(window.location.search);
    var queryTripId = urlParams.get('trip') || urlParams.get('join');
    var hashMatch = window.location.hash.match(/(?:trip|join)=([^&]+)/);
    var hashTripId = hashMatch ? decodeURIComponent(hashMatch[1]) : null;
    var incomingTripId = queryTripId || hashTripId || sessionStorage.getItem('nomad_pending_join') || localStorage.getItem('nomad_pending_join');
    if (sessionStorage.getItem('nomad_pending_join')) {
      sessionStorage.removeItem('nomad_pending_join');
    }
    if (localStorage.getItem('nomad_pending_join')) {
      localStorage.removeItem('nomad_pending_join');
    }

    if (incomingTripId) {
      if (trips.some(function (t) { return t.id === incomingTripId; })) {
        target = incomingTripId;
      } else {
        // Attempt to join the trip automatically
        return TripAuth.joinTrip(incomingTripId).then(function () {
          showToast('🎉 Joined trip successfully!');
          return TripAuth.listTrips().then(function (updatedTrips) {
            STATE.trips = updatedTrips || [];
            selectTrip(incomingTripId);
          });
        }).catch(function (e) {
          console.warn('Auto-join failed, opening trip directly:', e);
          selectTrip(incomingTripId);
        });
      }
    } else if (savedId && trips.some(function (t) { return t.id === savedId; })) {
      target = savedId;
    } else if (trips.length > 0) {
      target = trips[0].id;
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

  // Swap modal search input
  var swapSearch = $('#swap-search-input');
  if (swapSearch) {
    swapSearch.addEventListener('input', function () {
      renderSwapIdeasList(this.value.trim().toLowerCase());
    });
  }

  // 1. Switch Trip Modal actions
  var newTripToggleBtn = $('#create-new-trip-toggle-btn');
  if (newTripToggleBtn) {
    newTripToggleBtn.addEventListener('click', function () {
      var box = $('#new-trip-form-box');
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) {
        var startInp = $('#new-trip-start-input');
        var endInp = $('#new-trip-end-input');
        if (startInp && !startInp.value) {
          var d1 = new Date(); d1.setDate(d1.getDate() + 7);
          startInp.value = d1.toISOString().slice(0, 10);
        }
        if (endInp && !endInp.value) {
          var d2 = new Date(); d2.setDate(d2.getDate() + 14);
          endInp.value = d2.toISOString().slice(0, 10);
        }
        var destInp = $('#new-trip-dest-input');
        if (destInp) destInp.focus();
      }
    });
  }

  var cancelNewTripBtn = $('#cancel-create-trip-btn');
  if (cancelNewTripBtn) {
    cancelNewTripBtn.addEventListener('click', function () {
      var box = $('#new-trip-form-box');
      if (box) box.hidden = true;
    });
  }

  var submitNewTripBtn = $('#submit-create-trip-btn');
  if (submitNewTripBtn) {
    submitNewTripBtn.addEventListener('click', function () {
      var dest = ($('#new-trip-dest-input').value || '').trim();
      if (!dest) {
        alert('Please enter a destination or trip title.');
        return;
      }
      var sDate = $('#new-trip-start-input').value;
      var eDate = $('#new-trip-end-input').value;
      var budget = parseFloat($('#new-trip-budget-input').value) || 2000;
      var curr = $('#new-trip-curr-select').value || 'SGD';

      closeTripModal();
      createBlankTrip(dest, sDate, eDate, budget, curr).then(function () {
        if (confirm('✨ Trip template created for ' + dest + '!\n\nWould you like AI to automatically plan the complete itinerary and lodging now?')) {
          openAiGeneratorModal(dest, sDate, eDate, budget, curr);
        }
      });
    });
  }

  var copyInviteBtn = $('#copy-active-invite-btn');
  if (copyInviteBtn) {
    copyInviteBtn.addEventListener('click', function () {
      copyTripInviteLink(STATE.activeTripId);
    });
  }

  var openJsonBtn = $('#open-json-modal-btn');
  if (openJsonBtn) {
    openJsonBtn.addEventListener('click', function () {
      closeTripModal();
      openJsonIoModal('export');
    });
  }

  // 2. AI Provider Settings in User Modal
  var aiProvSel = $('#user-ai-provider-select');
  if (aiProvSel) {
    aiProvSel.addEventListener('change', function () {
      var endBox = $('#user-ai-endpoint-box');
      if (endBox) endBox.hidden = (this.value !== 'custom');
    });
  }

  var toggleAiKeyBtn = $('#toggle-show-ai-key-btn');
  if (toggleAiKeyBtn) {
    toggleAiKeyBtn.addEventListener('click', function () {
      var keyInp = $('#user-ai-key-input');
      if (!keyInp) return;
      if (keyInp.type === 'password') {
        keyInp.type = 'text';
        this.textContent = '🔒';
      } else {
        keyInp.type = 'password';
        this.textContent = '👁';
      }
    });
  }

  var saveAiBtn = $('#save-ai-settings-btn');
  if (saveAiBtn) {
    saveAiBtn.addEventListener('click', function () {
      var prov = $('#user-ai-provider-select').value;
      var key = ($('#user-ai-key-input').value || '').trim();
      var model = ($('#user-ai-model-input').value || '').trim();
      var endpoint = ($('#user-ai-endpoint-input').value || '').trim();

      localStorage.setItem('nomad_ai_provider', prov);
      localStorage.setItem('nomad_ai_key', key);
      localStorage.setItem('nomad_ai_model', model);
      localStorage.setItem('nomad_ai_endpoint', endpoint);

      updateAiKeyStatusBadge();
      showToast('💾 AI Settings saved successfully!');
    });
  }

  // 3. AI Trip Generator Modal
  var aiGenClose = $('#ai-gen-modal-close');
  if (aiGenClose) aiGenClose.addEventListener('click', closeAiGeneratorModal);

  var aiGenModal = $('#ai-generator-modal');
  if (aiGenModal) {
    aiGenModal.addEventListener('click', function (e) {
      if (e.target === this) closeAiGeneratorModal();
    });
  }

  var vibePills = $$('#ai-gen-vibe-pills .filter-pill');
  vibePills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      vibePills.forEach(function (p) { p.classList.remove('active'); });
      this.classList.add('active');
    });
  });

  var aiGenSubmitBtn = $('#ai-gen-submit-btn');
  if (aiGenSubmitBtn) aiGenSubmitBtn.addEventListener('click', startAiTripGeneration);

  // 4. Structured JSON IO Modal
  var jsonClose = $('#json-io-close-btn');
  if (jsonClose) jsonClose.addEventListener('click', closeJsonIoModal);

  var jsonModal = $('#json-io-modal');
  if (jsonModal) {
    jsonModal.addEventListener('click', function (e) {
      if (e.target === this) closeJsonIoModal();
    });
  }

  var jsonTabExport = $('#json-tab-export-btn');
  if (jsonTabExport) {
    jsonTabExport.addEventListener('click', function () {
      setJsonIoTab('export');
    });
  }

  var jsonTabImport = $('#json-tab-import-btn');
  if (jsonTabImport) {
    jsonTabImport.addEventListener('click', function () {
      setJsonIoTab('import');
    });
  }

  var jsonCopyBtn = $('#json-copy-btn');
  if (jsonCopyBtn) {
    jsonCopyBtn.addEventListener('click', function () {
      var txt = $('#json-export-textarea').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          showToast('📋 Trip JSON copied to clipboard!');
        });
      } else {
        $('#json-export-textarea').select();
        document.execCommand('copy');
        showToast('📋 Trip JSON copied!');
      }
    });
  }

  var jsonDownloadBtn = $('#json-download-btn');
  if (jsonDownloadBtn) {
    jsonDownloadBtn.addEventListener('click', function () {
      var txt = $('#json-export-textarea').value;
      var t = STATE.docs.trip || STATE.trip || {};
      var dest = (t.destination || t.city || t.title || t.name || 'nomad-trip');
      var filename = dest.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.nomad.json';
      var blob = new Blob([txt], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('💾 Downloaded ' + filename);
    });
  }

  var jsonFileInput = $('#json-import-file-input');
  if (jsonFileInput) {
    jsonFileInput.addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        $('#json-import-textarea').value = e.target.result;
        showToast('📂 Loaded ' + file.name);
      };
      reader.readAsText(file);
    });
  }

  var jsonSubmitBtn = $('#json-submit-import-btn');
  if (jsonSubmitBtn) {
    jsonSubmitBtn.addEventListener('click', function () {
      var raw = ($('#json-import-textarea').value || '').trim();
      if (!raw) {
        alert('Please paste JSON or choose a .json file first.');
        return;
      }
      try {
        var parsed = JSON.parse(raw);
        applyMasterTripJson(parsed);
        closeJsonIoModal();
        showToast('✨ Trip JSON imported and applied successfully!');
      } catch (e) {
        alert('Failed to parse JSON: ' + (e.message || e));
      }
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

  var pendingTrip = '';
  try {
    pendingTrip = (sessionStorage && sessionStorage.getItem('nomad_pending_join')) ||
                  (localStorage && localStorage.getItem('nomad_pending_join')) || '';
    pendingTrip = pendingTrip.trim();
  } catch (_) {}
  var inviteBadge = $('#signin-invite-badge');
  if (inviteBadge) {
    inviteBadge.hidden = !pendingTrip;
  }

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
    if (opt) {
      var dVal = opt.cost_delta_sgd != null ? opt.cost_delta_sgd : opt.cost_delta;
      if (dVal != null) delta += num(dVal) || 0;
    }
  });
  return delta;
}

function calculateBudget() {
  var t = STATE.docs.trip || STATE.trip || {};
  var cap = num(t.budget_cap != null ? t.budget_cap : (t.budget_per_person || t.budget || 1500));

  var items = getExpensesPlanned();
  var base = 0;
  if (items.length > 0) {
    items.forEach(function (it) {
      var c = num(it.amount != null ? it.amount : (it.cost_sgd != null ? it.cost_sgd : (it.amount_sgd != null ? it.amount_sgd : it.cost)));
      if (c != null) base += c;
    });
  } else if (!STATE.trip || STATE.trip.name === 'Vietnam Christmas & New Year' || (t.destination || '').toLowerCase().includes('vietnam')) {
    base = 978; // Standard baseline if uncalculated on Vietnam trip
  }

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

var MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDdMmm(dStr) {
  if (!dStr) return '';
  var s = String(dStr).trim();

  // If already like "24-Dec" or "01-Jan"
  if (/^\d{1,2}-[A-Za-z]{3}$/i.test(s)) {
    var parts = s.split('-');
    var dPart = parts[0].length === 1 ? '0' + parts[0] : parts[0];
    var mPart = parts[1].slice(0, 1).toUpperCase() + parts[1].slice(1, 3).toLowerCase();
    return dPart + '-' + mPart;
  }

  // Match ISO YYYY-MM-DD
  var isoMatch = s.match(/(\d{4})?-?(\d{1,2})-(\d{1,2})/);
  if (isoMatch && isoMatch[2] && isoMatch[3]) {
    var monthIdx = parseInt(isoMatch[2], 10) - 1;
    var dayNum = parseInt(isoMatch[3], 10);
    if (monthIdx >= 0 && monthIdx < 12 && !isNaN(dayNum)) {
      var dd = dayNum < 10 ? '0' + dayNum : '' + dayNum;
      var mmm = MONTH_NAMES_SHORT[monthIdx];
      return dd + '-' + mmm;
    }
  }

  // Text like "24 Dec" or "24 Dec 2026"
  var textMatch = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})/);
  if (textMatch) {
    var dVal = parseInt(textMatch[1], 10);
    var dd = dVal < 10 ? '0' + dVal : '' + dVal;
    var mName = textMatch[2].slice(0, 3).toLowerCase();
    var foundIdx = MONTH_NAMES_SHORT.findIndex(function (m) { return m.toLowerCase() === mName; });
    if (foundIdx !== -1) {
      return dd + '-' + MONTH_NAMES_SHORT[foundIdx];
    }
  }

  // Parse Date object fallback
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    var dd = parsed.getDate() < 10 ? '0' + parsed.getDate() : '' + parsed.getDate();
    var mmm = MONTH_NAMES_SHORT[parsed.getMonth()];
    return dd + '-' + mmm;
  }

  return s;
}

function getCleanDestination(t) {
  if (!t) return 'Nomad Trip';
  if (t.destination && t.destination.trim()) return t.destination.trim();
  if (t.city && t.city.trim()) return t.city.trim();
  var raw = t.title || t.name || '';
  if (/vietnam/i.test(raw)) return 'Vietnam';
  if (raw.includes('—')) raw = raw.split('—')[0].trim();
  if (raw.includes('-')) raw = raw.split('-')[0].trim();
  if (raw.includes('(')) raw = raw.split('(')[0].trim();
  return raw || 'Nomad Trip';
}

function renderTripBanner() {
  var t = STATE.docs.trip || STATE.trip || {};

  var dest = getCleanDestination(t);
  var startStr = t.start_date || t.start || '';
  var endStr = t.end_date || t.end || '';

  // Extract from itinerary days if missing on trip doc
  if (!startStr || !endStr) {
    var itiDays = getItineraryDays();
    if (itiDays && itiDays.length > 0) {
      if (!startStr && itiDays[0].date) startStr = itiDays[0].date;
      if (!endStr && itiDays[itiDays.length - 1].date) endStr = itiDays[itiDays.length - 1].date;
    }
  }

  // Default fallback for Vietnam trip
  if (!startStr && /vietnam/i.test(dest)) startStr = '2026-12-24';
  if (!endStr && /vietnam/i.test(dest)) endStr = '2027-01-01';

  var datesStr = '';
  if (startStr && endStr) {
    datesStr = formatDdMmm(startStr) + ' to ' + formatDdMmm(endStr);
  } else if (startStr) {
    datesStr = formatDdMmm(startStr);
  } else {
    datesStr = 'Trip Dates';
  }

  var nameEl = $('#current-trip-name');
  if (nameEl) nameEl.textContent = dest + ' · ' + datesStr;

  // Decisions count badge
  var decs = getDecisions();
  var decBadge = $('#decisions-pill-badge');
  if (decBadge) {
    if (decs.length > 0) {
      decBadge.textContent = decs.length;
      decBadge.hidden = false;
    } else {
      decBadge.hidden = true;
    }
  }
}

function openTripModal() {
  var formBox = $('#new-trip-form-box');
  if (formBox) formBox.hidden = true;

  var list = $('#trips-list-container');
  clear(list);

  STATE.trips.forEach(function (t) {
    var card = ce('div', 'trip-pick-card' + (t.id === STATE.activeTripId ? ' active' : ''));
    var info = ce('div');
    info.appendChild(ce('div', 'trip-pick-name', t.name || t.title || 'Untitled Trip'));
    var sub = [];
    if (t.start_date) sub.push(formatDdMmm(t.start_date));
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

function updateAiKeyStatusBadge() {
  var badge = $('#ai-key-status-badge');
  if (!badge) return;
  var key = (localStorage.getItem('nomad_ai_key') || '').trim();
  if (key) {
    badge.textContent = 'Configured ✓';
    badge.className = 'badge badge-good';
  } else {
    badge.textContent = 'No Key';
    badge.className = 'badge';
  }
}

function openUserModal(user) {
  var box = $('#user-modal-avatar-box');
  clear(box);
  if (user && user.avatar) {
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
    circle.textContent = ((user && (user.name || user.email)) || 'U').charAt(0).toUpperCase();
    box.appendChild(circle);
  }

  $('#user-modal-name').textContent = (user && user.name) || 'Traveller';
  $('#user-modal-email').textContent = (user && user.email) || '';

  // Load saved AI settings
  var prov = localStorage.getItem('nomad_ai_provider') || 'openrouter';
  var key = localStorage.getItem('nomad_ai_key') || '';
  var model = localStorage.getItem('nomad_ai_model') || '';
  var endpoint = localStorage.getItem('nomad_ai_endpoint') || '';

  var provSel = $('#user-ai-provider-select');
  if (provSel) provSel.value = prov;
  var keyInp = $('#user-ai-key-input');
  if (keyInp) keyInp.value = key;
  var modelInp = $('#user-ai-model-input');
  if (modelInp) modelInp.value = model;
  var endInp = $('#user-ai-endpoint-input');
  if (endInp) endInp.value = endpoint;

  var endBox = $('#user-ai-endpoint-box');
  if (endBox) endBox.hidden = (prov !== 'custom');

  updateAiKeyStatusBadge();
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
  if (it.slot) {
    var s = String(it.slot).toLowerCase();
    if (s === 'morning' || s === 'afternoon' || s === 'evening' || s === 'night') {
      return s;
    }
  }

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
  var hasActivities = days.some(function (d) { return d.items && d.items.length > 0; });

  // If trip has zero activities or empty days, render the AI Generation Banner
  if (!hasActivities) {
    var ctaBanner = ce('div', 'ai-banner-cta');
    ctaBanner.innerHTML =
      '<div style="font-size: 1.8rem; margin-bottom: 6px;">✨</div>' +
      '<h3 style="margin: 0 0 6px; font-size: 1.05rem;">Your Itinerary is Ready to be Planned!</h3>' +
      '<p class="muted small" style="margin: 0 0 14px; max-width: 440px; margin-inline: auto;">' +
        'Nomad can automatically craft a complete day-by-day route, lodging recommendations, itemized budget, and packing checklist with AI.' +
      '</p>' +
      '<div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">' +
        '<button type="button" id="cta-ai-gen-btn" class="btn btn-google small">✨ Generate Trip with AI</button>' +
        '<button type="button" id="cta-json-import-btn" class="btn btn-secondary small">📦 Import Trip JSON</button>' +
      '</div>';

    var ctaGen = ctaBanner.querySelector('#cta-ai-gen-btn');
    if (ctaGen) ctaGen.addEventListener('click', function () { openAiGeneratorModal(); });
    var ctaImp = ctaBanner.querySelector('#cta-json-import-btn');
    if (ctaImp) ctaImp.addEventListener('click', function () { openJsonIoModal('import'); });

    root.appendChild(ctaBanner);
  }

  if (!days.length) {
    if (hasActivities) root.appendChild(renderEmpty('No itinerary entries recorded for this trip.'));
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
  toolbar.appendChild(leftTools);

  var rightTools = ce('div', 'table-toolbar-right');
  var aiPlanBtn = ce('button', 'btn btn-secondary small', '✨ AI Plan');
  aiPlanBtn.addEventListener('click', function () {
    openAiGeneratorModal();
  });
  rightTools.appendChild(aiPlanBtn);

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
    
    var titleRow = ce('div', 'glance-day-title-row');
    titleRow.appendChild(ce('div', 'glance-day-num', 'Day ' + dayNum));

    var addActBtn = ce('button', 'btn-day-add-act', '+');
    addActBtn.title = 'Add activity to Day ' + dayNum;
    addActBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openItemEditor(dayNum, -1, null);
    });
    titleRow.appendChild(addActBtn);
    headWrap.appendChild(titleRow);

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

  // Row 1: Focus (Sticky Row)
  var trBase = ce('tr', 'glance-tr glance-tr-focus');
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

      var stayPill = ce('div', 'glance-stay-pill pill-type-stay');
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
      var busPill = ce('div', 'glance-stay-pill pill-type-stay');
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
    var dTitleRow = ce('div', 'glance-day-title-row');
    dTitleRow.appendChild(ce('div', 'glance-day-num', 'Day ' + dayNum));
    var addActBtn = ce('button', 'btn-day-add-act', '+');
    addActBtn.title = 'Add activity to Day ' + dayNum;
    addActBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openItemEditor(dayNum, -1, null);
    });
    dTitleRow.appendChild(addActBtn);
    dayCell.appendChild(dTitleRow);
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
      var stayPill = ce('div', 'glance-stay-pill pill-type-stay');
      stayPill.appendChild(ce('span', null, '🏨 ' + lodgingShort));
      nightBox.appendChild(stayPill);
    } else if (d.transit && d.transit.toLowerCase().includes('sleeper')) {
      var busPill = ce('div', 'glance-stay-pill pill-type-stay', '🚌 Sleeper Bus');
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

  // Explicit color-coding classification: check it.type first
  var pillType = 'activity';
  if (it.type) {
    var rawType = String(it.type).toLowerCase();
    if (rawType === 'stay' || rawType === 'lodging' || rawType === 'hotel') pillType = 'stay';
    else if (rawType === 'food' || rawType === 'dining' || rawType === 'drink') pillType = 'food';
    else if (rawType === 'transit' || rawType === 'transport' || rawType === 'flight' || rawType === 'bus') pillType = 'transit';
    else pillType = 'activity';
  } else {
    var titleText = (it.what || it.title || it.activity || it.name || '').toLowerCase();
    var catText = (it.category || '').toLowerCase();
    var notesText = (it.notes || '').toLowerCase();
    var combined = titleText + ' ' + catText + ' ' + notesText;

    if (combined.includes('hotel') || combined.includes('resort') || combined.includes('homestay') || combined.includes('hostel') || combined.includes('check-in') || combined.includes('check in') || combined.includes('lodging') || combined.includes('sleeper bus') || combined.includes('overnight')) {
      pillType = 'stay';
    } else if (combined.includes('food') || combined.includes('dinner') || combined.includes('lunch') || combined.includes('breakfast') || combined.includes('eat') || combined.includes('phở') || combined.includes('pho') || combined.includes('bún') || combined.includes('bun') || combined.includes('bánh') || combined.includes('banh') || combined.includes('coffee') || combined.includes('café') || combined.includes('cafe') || combined.includes('beer') || combined.includes('restaurant') || combined.includes('dining') || combined.includes('tasting') || combined.includes('snack')) {
      pillType = 'food';
    } else if (combined.includes('bus') || combined.includes('train') || combined.includes('flight') || combined.includes('limousine') || combined.includes('transit') || combined.includes('transfer') || combined.includes('minivan') || combined.includes('drive to') || combined.includes('ride to') || combined.includes('departure') || combined.includes('arrival')) {
      pillType = 'transit';
    } else {
      pillType = 'activity';
    }
  }
  pill.classList.add('pill-type-' + pillType);

  var header = ce('div', 'glance-pill-header');
  if (it.time && it.time !== '—') {
    header.appendChild(ce('span', 'glance-event-time', it.time.replace(' (assumed)', '')));
  }

  // Activity Status Toggle Pill (Planned vs Booked)
  var isBooked = (it.status || '').toLowerCase() === 'booked';
  var statusBtn = ce('button', 'pill-status-toggle' + (isBooked ? ' is-booked' : ' is-planned'), isBooked ? '✓ Booked' : 'Planned');
  statusBtn.title = 'Click to toggle Planned / Booked';
  statusBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleActivityStatus(dayNum, itemIdx, it);
  });
  header.appendChild(statusBtn);

  header.appendChild(ce('span', 'glance-edit-icon', '✏️'));
  pill.appendChild(header);

  var title = ce('div', 'glance-pill-title', it.what || it.title || it.activity || it.name || 'Event');
  pill.appendChild(title);

  // If booked, the booking button disappears!
  if (!isBooked && (it.booking_url || (it.refs && it.refs.length > 0))) {
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

function toggleActivityStatus(dayNum, itemIdx, it) {
  var current = (it.status || 'planned').toLowerCase();
  var next = current === 'booked' ? 'planned' : 'booked';
  it.status = next;

  // Persist into STATE.docs.itinerary
  var rawIti = STATE.docs.itinerary;
  if (rawIti) {
    var rawDays = Array.isArray(rawIti) ? rawIti : (rawIti.days || []);
    var targetDay = rawDays.find(function (d, i) { return (d.day || i + 1) === dayNum; });
    if (targetDay && targetDay.items && targetDay.items[itemIdx]) {
      targetDay.items[itemIdx].status = next;
    }
  }
  saveItineraryDoc();

  // If this activity involves an overnight stay/accommodation, sync with stays tab!
  var what = (it.what || it.title || '').toLowerCase();
  var isStayActivity = (it.type === 'stay') || /hotel|resort|homestay|hostel|sleeper bus|overnight/i.test(what);
  if (isStayActivity) {
    syncActivityStayStatus(what, next);
  }

  showToast(next === 'booked' ? '✓ Marked as Booked!' : 'Marked as Planned');
  renderItinerary();
}

function syncActivityStayStatus(activityWhat, nextStatus) {
  var stays = getAccommodations();
  var route = getPlannedRoute();
  var changed = false;

  route.forEach(function (leg) {
    var hName = (leg.hotelName || '').toLowerCase();
    if (hName && (activityWhat.includes(hName.slice(0, 8)) || hName.includes(activityWhat.slice(0, 8)))) {
      leg.status = nextStatus.charAt(0).toUpperCase() + nextStatus.slice(1);
      changed = true;
      if (leg.stayId) {
        var s = stays.find(function (item) { return item.id === leg.stayId; });
        if (s) s.status = nextStatus;
      }
    }
  });

  stays.forEach(function (s) {
    var sName = (s.name || s.hotel || '').toLowerCase();
    if (sName && (activityWhat.includes(sName.slice(0, 8)) || sName.includes(activityWhat.slice(0, 8)))) {
      s.status = nextStatus;
      changed = true;
    }
  });

  if (changed) {
    saveAccommodationDoc();
  }
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
  var slot = $('#edit-item-slot').value;

  var rawIti = STATE.docs.itinerary;
  if (!rawIti) {
    rawIti = { days: [] };
    STATE.docs.itinerary = rawIti;
  }
  var rawDays = Array.isArray(rawIti) ? rawIti : (rawIti.days || (rawIti.days = []));
  var dayObj = rawDays.find(function (d, i) { return (d.day || i + 1) === dayNum; });
  if (!dayObj) {
    dayObj = { day: dayNum, items: [] };
    rawDays.push(dayObj);
  }

  if (!dayObj.items) dayObj.items = [];

  var updatedItem = {
    time: time,
    what: what,
    slot: slot,
    cost: cost,
    currency: currency,
    notes: notes,
    booking_url: bookingUrl || undefined,
    booking_platform: bookingUrl ? (bookingUrl.includes('klook') ? 'Klook' : (bookingUrl.includes('booking.com') ? 'Booking.com' : (bookingUrl.includes('12go') ? '12Go' : (bookingUrl.includes('airbnb') ? 'Airbnb' : 'Direct Booking')))) : undefined,
    refs: bookingUrl ? [bookingUrl] : []
  };
  if (STATE.editingItem.item && STATE.editingItem.item.type) {
    updatedItem.type = STATE.editingItem.item.type;
  }

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

  var rawIti = STATE.docs.itinerary;
  var rawDays = Array.isArray(rawIti) ? rawIti : (rawIti && rawIti.days ? rawIti.days : []);
  var dayObj = rawDays.find(function (d, i) { return (d.day || i + 1) === dayNum; });
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

        var isBooked = (ev.status || '').toLowerCase() === 'booked';
        var statusBtn = ce('button', 'pill-status-toggle' + (isBooked ? ' is-booked' : ' is-planned'), isBooked ? '✓ Booked' : 'Planned');
        statusBtn.title = 'Click to toggle Planned / Booked';
        statusBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleActivityStatus(dayNum, evIdx, ev);
        });
        top.appendChild(statusBtn);

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

        // If booked, the booking button disappears!
        if (!isBooked && bUrl) {
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

function saveAccommodationDoc() {
  if (!STATE.activeTripId) return;
  TripAuth.saveDocs(STATE.activeTripId, { accommodation: STATE.docs.accommodation }).catch(function (e) {
    console.warn('Failed to save accommodation update:', e);
  });
}

function savePackingDoc() {
  if (!STATE.activeTripId) return;
  TripAuth.saveDocs(STATE.activeTripId, { packing: STATE.docs.packing }).catch(function (e) {
    console.warn('Failed to save packing update:', e);
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

function getPlannedRoute() {
  var docAcc = STATE.docs.accommodation;
  var customRoute = docAcc && (Array.isArray(docAcc.route) ? docAcc.route : (Array.isArray(docAcc.planned_route) ? docAcc.planned_route : null));
  var stays = getAccommodations();

  if (customRoute && customRoute.length > 0) {
    var copyRoute = JSON.parse(JSON.stringify(customRoute));
    copyRoute.forEach(function (leg) {
      if (leg.stayId) {
        var found = stays.find(function (s) { return s.id === leg.stayId; });
        if (found && found.status) {
          leg.status = found.status.charAt(0).toUpperCase() + found.status.slice(1);
        }
      }
    });
    return copyRoute;
  }

  var decNyePick = (STATE.picks['dec-nye'] && STATE.picks['dec-nye'].option_id) || 'opt-hanoi-nye';

  var route = [
    {
      id: 'leg-1',
      stayId: 'acc-003',
      nights: 'Night 1 (24–25 Dec)',
      city: 'Hanoi Old Quarter',
      hotelName: 'Peridot Grand Hotel & Spa',
      rate: '2,400,000 VND (~S$ 59/person)',
      status: 'Planned',
      notes: 'Christmas Eve peak window: 300m from Hoan Kiem, inner courtyard, spa. Book 2-4 weeks out.',
      alts: ['acc-001 (La Siesta Splurge)', 'acc-002 (Emerald Waters)', 'acc-006 (Hanoi Pearl)']
    },
    {
      id: 'leg-2',
      stayId: null,
      nights: 'Night 2 (25–26 Dec)',
      city: 'Hanoi → Ha Giang (Transit)',
      hotelName: '21:00 Sleeper Bus to Ha Giang',
      rate: 'Included in Transit Leg',
      status: 'Planned',
      notes: 'Overnight sleeper berth; hotel stores bags during the day after morning checkout.',
      alts: ['Daytime limousine van on 26 Dec (see dec-loop-start)']
    },
    {
      id: 'leg-3',
      stayId: 'acc-018',
      nights: 'Night 3 (26–27 Dec)',
      city: 'Ha Giang Loop (Quản Bạ)',
      hotelName: 'Dao Lodge Nam Dam / H\'Mong Village Resort',
      rate: 'Included in Easy Rider Tour',
      status: 'Planned',
      notes: 'Mountain homestay dinner, clay lodge, herbal footbath, corn wine.',
      alts: ['acc-018 H\'Mong Village Resort', 'acc-022 Dao Lodge Nam Dam']
    },
    {
      id: 'leg-4',
      stayId: 'acc-019',
      nights: 'Night 4 (27–28 Dec)',
      city: 'Ha Giang Loop (Đồng Văn / Mèo Vạc)',
      hotelName: 'Auberge de Meo Vac / Ancient Town Guesthouse',
      rate: 'Included in Easy Rider Tour',
      status: 'Planned',
      notes: 'Century-old H\'Mong stone architecture at the gateway to Mã Pí Lèng pass.',
      alts: ['acc-019 Ancient Town Guesthouse', 'acc-020 Lo Lo Eco Lodge']
    },
    {
      id: 'leg-5',
      stayId: 'acc-023',
      nights: 'Night 5 (28–29 Dec)',
      city: 'Ha Giang City',
      hotelName: 'Yen Bien Luxury Hotel',
      rate: '1,065,000 VND (~S$ 26/person)',
      status: 'Planned',
      notes: 'Post-loop reset night: rooftop pool, river view, laundry before 10h transit.',
      alts: ['acc-016 P\'apiu Resort (Ultra Splurge)', 'acc-017 Ha Giang Historic Hotel']
    },
    {
      id: 'leg-6',
      stayId: 'acc-015',
      nights: 'Nights 6–7 (29–31 Dec)',
      city: 'Tam Coc / Ninh Binh (2 nights)',
      hotelName: 'Tam Coc Garden Resort',
      rate: '1,170,000 VND / night (~S$ 29/person)',
      status: 'Planned',
      notes: 'Surrounded by limestone karst & paddies; 10 min bicycle from Tam Coc boat dock.',
      alts: ['acc-014 Tam Coc Sunshine Homestay (Budget ~S$9)', 'acc-011 Emeralda Resort']
    },
    {
      id: 'leg-7',
      stayId: 'acc-009',
      nights: 'Night 8 (31 Dec – 1 Jan)',
      city: 'Hanoi Old Quarter',
      hotelName: 'Hanoi La Siesta Premium Hang Be',
      rate: '2,860,000 VND (~S$ 70/person)',
      status: 'Planned',
      notes: 'New Year\'s Eve lake fireworks: within 300m walking distance so no taxis needed after midnight.',
      alts: ['acc-006 Hanoi Pearl (Fallback -S$19)', 'acc-004 O\'Gallery Premier', 'Tam Coc NYE (see dec-nye)']
    },
    {
      id: 'leg-8',
      stayId: null,
      nights: 'Day 9 (1 Jan)',
      city: 'Flight HAN → SIN',
      hotelName: 'Noi Bai International Airport (HAN)',
      rate: 'Outbound Flight',
      status: 'Planned',
      notes: 'Direct flight back to Singapore Changi.',
      alts: []
    }
  ];

  if (decNyePick === 'opt-tamcoc-nye') {
    route[6] = {
      id: 'leg-7',
      stayId: 'acc-015',
      nights: 'Night 8 (31 Dec – 1 Jan)',
      city: 'Tam Coc / Ninh Binh',
      hotelName: 'Tam Coc Garden Resort',
      rate: '1,170,000 VND / night (~S$ 29/person)',
      status: 'Planned',
      notes: 'Peaceful countryside New Year countdown surrounded by karst cliffs; avoiding Hanoi lake crowds.',
      alts: ['acc-014 Tam Coc Sunshine Homestay', 'acc-011 Emeralda Resort']
    };
    route[7] = {
      id: 'leg-8',
      stayId: null,
      nights: 'Day 9 (1 Jan)',
      city: 'Tam Coc → Noi Bai Airport (HAN)',
      hotelName: 'Noi Bai International Airport (HAN)',
      rate: 'Outbound Flight',
      status: 'Planned',
      notes: 'Private minivan Tam Coc → Noi Bai (2h) for evening flight back to Singapore.',
      alts: []
    };
  }

  // Apply generic accommodation_impact from active decisions
  var allDecs = getDecisions();
  allDecs.forEach(function (dec) {
    var pickedOptId = getActivePick(dec);
    var opt = (dec.options || []).find(function (o) { return o.id === pickedOptId; });
    if (!opt) return;

    var accImpacts = opt.accommodation_impact || opt.stay_impact || [];
    if (Array.isArray(accImpacts)) {
      accImpacts.forEach(function (ai) {
        if (!ai || typeof ai !== 'object') return;
        var leg = route.find(function (l) { return l.id === ai.leg_id || l.nights === ai.nights; });
        if (leg) {
          if (ai.stay_id || ai.stayId) leg.stayId = ai.stay_id || ai.stayId;
          if (ai.hotel_name || ai.hotelName) leg.hotelName = ai.hotel_name || ai.hotelName;
          if (ai.rate) leg.rate = ai.rate;
          if (ai.status) leg.status = ai.status;
          if (ai.notes) leg.notes = ai.notes;
        }
      });
    }
  });

  var stays = getAccommodations();
  route.forEach(function (leg) {
    if (leg.stayId) {
      var found = stays.find(function (s) { return s.id === leg.stayId; });
      if (found && found.status) {
        leg.status = found.status.charAt(0).toUpperCase() + found.status.slice(1);
      }
    }
  });

  return route;
}

var NIGHT_GROUPS = [
  { id: 'night-1', label: 'Night 1: 24–25 Dec · Hanoi Old Quarter' },
  { id: 'night-2', label: 'Night 2: 25–26 Dec · Transit: Overnight Sleeper Bus' },
  { id: 'night-3', label: 'Night 3: 26–27 Dec · Ha Giang Loop (Quản Bạ / Yên Minh)' },
  { id: 'night-4', label: 'Night 4: 27–28 Dec · Ha Giang Loop (Đồng Văn / Mèo Vạc)' },
  { id: 'night-5', label: 'Night 5: 28–29 Dec · Ha Giang City Reset' },
  { id: 'nights-6-7', label: 'Nights 6–7: 29–31 Dec · Tam Coc / Ninh Binh (2 Nights)' },
  { id: 'night-8', label: 'Night 8: 31 Dec – 1 Jan · Hanoi Old Quarter (NYE)' }
];

function getStayNightId(s) {
  var id = s.id || '';
  var checkin = s.checkin || s.check_in || '';
  var area = (s.area || s.location || '').toLowerCase();
  var name = (s.name || s.hotel || '').toLowerCase();

  if (checkin === '2026-12-31' || ['acc-007', 'acc-008', 'acc-009', 'acc-010'].includes(id)) {
    return 'night-8';
  }
  if (checkin === '2026-12-24' || ['acc-001', 'acc-002', 'acc-003', 'acc-004', 'acc-005', 'acc-006'].includes(id)) {
    return 'night-1';
  }
  if (checkin === '2026-12-26' || ['acc-018', 'acc-021', 'acc-022'].includes(id) || area.includes('quản bạ') || area.includes('quan ba') || area.includes('yên minh') || area.includes('nam dam')) {
    return 'night-3';
  }
  if (checkin === '2026-12-27' || ['acc-019', 'acc-020', 'acc-023'].includes(id) || area.includes('đồng văn') || area.includes('dong van') || area.includes('mèo vạc') || area.includes('meo vac')) {
    return 'night-4';
  }
  if (checkin === '2026-12-28' || ['acc-016', 'acc-017'].includes(id) || name.includes('yen bien') || area.includes('ha giang city')) {
    return 'night-5';
  }
  if (checkin === '2026-12-29' || ['acc-011', 'acc-012', 'acc-013', 'acc-014', 'acc-015'].includes(id) || area.includes('tam coc') || area.includes('ninh binh') || area.includes('tràng an') || area.includes('trang an')) {
    return 'nights-6-7';
  }
  return 'other';
}

function toggleLegStatus(leg) {
  var isBooked = (leg.status || '').toLowerCase().includes('book');
  var nextStatus = isBooked ? 'Planned' : 'Booked';

  var route = getPlannedRoute();
  if (!STATE.docs.accommodation) STATE.docs.accommodation = {};
  if (!Array.isArray(STATE.docs.accommodation.route)) {
    STATE.docs.accommodation.route = JSON.parse(JSON.stringify(route));
  }
  var targetLeg = STATE.docs.accommodation.route.find(function (l) { return l.id === leg.id; });
  if (targetLeg) {
    targetLeg.status = nextStatus;
  }
  leg.status = nextStatus;

  var stays = getAccommodations();
  if (leg.stayId) {
    var s = stays.find(function (item) { return item.id === leg.stayId; });
    if (s) {
      s.status = nextStatus.toLowerCase();
      if (nextStatus === 'Booked') {
        var nId = getStayNightId(s);
        stays.forEach(function (other) {
          if (other.id !== s.id && getStayNightId(other) === nId) {
            other.status = 'wishlist';
          }
        });
      }
    }
  }

  saveAccommodationDoc();
  syncLegStayToItinerary(leg.hotelName || leg.city, nextStatus.toLowerCase());
  renderAccommodation();
  showToast(leg.nights + ': Marked as ' + nextStatus + '!');
}

function syncLegStayToItinerary(searchName, nextStatus) {
  if (!searchName) return;
  var iti = STATE.docs.itinerary;
  if (!iti) return;
  var days = Array.isArray(iti) ? iti : (iti.days || []);
  var sLow = searchName.toLowerCase();
  var changed = false;

  days.forEach(function (d) {
    (d.items || []).forEach(function (it) {
      var wLow = (it.what || it.title || '').toLowerCase();
      var isMatch = false;
      if (sLow.includes('sleeper bus') && wLow.includes('sleeper bus')) isMatch = true;
      else if ((sLow.includes('flight') || sLow.includes('noi bai')) && (wLow.includes('flight') || wLow.includes('noi bai') || wLow.includes('airport'))) isMatch = true;
      else if (sLow.length >= 5 && (wLow.includes(sLow.slice(0, 8)) || sLow.includes(wLow.slice(0, 8)))) isMatch = true;

      if (isMatch) {
        it.status = nextStatus;
        changed = true;
      }
    });
  });

  if (changed) {
    saveItineraryDoc();
  }
}

function setStayStatus(stayId, newStatus) {
  var stays = getAccommodations();
  var target = stays.find(function (s) { return s.id === stayId; });
  if (!target) return;

  var nightId = getStayNightId(target);
  if (newStatus === 'booked') {
    stays.forEach(function (s) {
      if (s.id !== target.id && getStayNightId(s) === nightId) {
        s.status = 'wishlist';
      }
    });
  }
  target.status = newStatus;

  // Also update route leg
  var route = getPlannedRoute();
  if (!STATE.docs.accommodation) STATE.docs.accommodation = {};
  if (!Array.isArray(STATE.docs.accommodation.route)) {
    STATE.docs.accommodation.route = JSON.parse(JSON.stringify(route));
  }
  var leg = STATE.docs.accommodation.route.find(function (l) {
    return l.stayId === target.id || l.id === nightId;
  });
  if (leg) {
    leg.stayId = target.id;
    leg.hotelName = target.name || target.hotel;
    leg.status = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
  }

  saveAccommodationDoc();
  syncLegStayToItinerary(target.name || target.hotel, newStatus);
  renderAccommodation();
  showToast('Status updated: ' + (target.name || 'Stay') + ' → ' + newStatus.toUpperCase());
}

function swapToStay(newStayId, previousStayId) {
  var stays = getAccommodations();
  var newStay = stays.find(function (s) { return s.id === newStayId; });
  var oldStay = stays.find(function (s) { return s.id === previousStayId; });
  if (oldStay) oldStay.status = 'wishlist';
  if (newStay) {
    newStay.status = (oldStay && (oldStay.status || '').toLowerCase() === 'booked') ? 'booked' : 'planned';
  }

  var route = getPlannedRoute();
  if (!STATE.docs.accommodation) STATE.docs.accommodation = {};
  if (!Array.isArray(STATE.docs.accommodation.route)) {
    STATE.docs.accommodation.route = JSON.parse(JSON.stringify(route));
  }
  var nightId = newStay ? getStayNightId(newStay) : '';
  var leg = STATE.docs.accommodation.route.find(function (l) {
    return (oldStay && l.stayId === oldStay.id) || (nightId && l.id === nightId);
  });
  if (leg && newStay) {
    leg.stayId = newStay.id;
    leg.hotelName = newStay.name || newStay.hotel;
    leg.status = newStay.status.charAt(0).toUpperCase() + newStay.status.slice(1);
    if (newStay.price_per_night) {
      leg.rate = new Intl.NumberFormat().format(newStay.price_per_night) + ' ' + (newStay.currency || 'VND') + ' / night';
    }
  }

  saveAccommodationDoc();
  if (newStay) {
    syncLegStayToItinerary(newStay.name || newStay.hotel, newStay.status);
  }
  renderAccommodation();
  showToast('Swapped to: ' + (newStay ? newStay.name : 'New Stay'));
}

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
  var route = getPlannedRoute();
  var container = ce('div', 'glance-table-container');
  var table = ce('table', 'glance-table flipped stay-route-table');

  var thead = ce('thead');
  var hrow = ce('tr');
  var thCorner = ce('th', 'glance-th glance-dimension-cell', 'Night & Dates');
  hrow.appendChild(thCorner);

  route.forEach(function (leg) {
    var th = ce('th', 'glance-th glance-col-day-th');
    var headWrap = ce('div', 'glance-day-header');
    headWrap.appendChild(ce('div', 'glance-day-num', leg.nights));
    th.appendChild(headWrap);
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = ce('tbody');

  // Row 1: Region / Base
  var trRegion = ce('tr', 'stay-route-tr glance-tr glance-tr-focus');
  trRegion.appendChild(ce('td', 'glance-dimension-cell', '📍 Region / Base'));
  route.forEach(function (leg) {
    var td = ce('td', 'glance-col-day-cell');
    td.appendChild(ce('span', 'glance-day-base', leg.city));
    trRegion.appendChild(td);
  });
  tbody.appendChild(trRegion);

  // Row 2: Active Planned Stay
  var trStay = ce('tr', 'stay-route-tr glance-tr');
  trStay.appendChild(ce('td', 'glance-dimension-cell', '🏨 Active Stay'));
  route.forEach(function (leg) {
    var td = ce('td', 'glance-col-day-cell');
    var hotelBox = ce('div', 'stay-hotel-name', '🏨 ' + leg.hotelName);
    td.appendChild(hotelBox);

    if (leg.alts && leg.alts.length > 0) {
      var altBox = ce('div', 'stay-alts-tag', '⇄ ' + leg.alts.join(' · '));
      td.appendChild(altBox);
    }

    var matchedStay = stays.find(function (s) {
      var sName = (s.name || s.hotel || '').toLowerCase();
      var lName = leg.hotelName.toLowerCase();
      return (sName && (lName.includes(sName.slice(0, 8)) || sName.includes(lName.slice(0, 8))));
    });
    var bookUrl = (matchedStay && (matchedStay.booking_url || matchedStay.link)) || leg.booking_url;
    if (bookUrl) {
      var plat = (matchedStay && matchedStay.booking_platform) || (bookUrl.includes('booking.com') ? 'Booking.com' : (bookUrl.includes('airbnb') ? 'Airbnb' : (bookUrl.includes('12go') ? '12Go' : 'Online')));
      var bLink = ce('a', 'glance-booking-link', 'Book (' + plat + ') ↗');
      bLink.href = bookUrl;
      bLink.target = '_blank';
      bLink.rel = 'noopener';
      bLink.style.display = 'inline-block';
      bLink.style.marginTop = '4px';
      td.appendChild(bLink);
    }

    trStay.appendChild(td);
  });
  tbody.appendChild(trStay);

  // Row 3: Status (Toggleable Buttons: Planned / Booked)
  var trStatus = ce('tr', 'stay-route-tr glance-tr');
  trStatus.appendChild(ce('td', 'glance-dimension-cell', '📌 Status'));
  route.forEach(function (leg) {
    var td = ce('td', 'glance-col-day-cell');
    var isBooked = (leg.status || '').toLowerCase().includes('book');
    var statusBtn = ce('button', 'route-status-toggle' + (isBooked ? ' is-booked' : ' is-planned'), isBooked ? '✓ Booked' : 'Planned');
    statusBtn.title = 'Click to toggle Planned / Booked';
    statusBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleLegStatus(leg);
    });
    td.appendChild(statusBtn);
    trStatus.appendChild(td);
  });
  tbody.appendChild(trStatus);

  // Row 4: Estimated Rate
  var trRate = ce('tr', 'stay-route-tr glance-tr');
  trRate.appendChild(ce('td', 'glance-dimension-cell', '💰 Est. Rate'));
  route.forEach(function (leg) {
    var td = ce('td', 'glance-col-day-cell');
    td.appendChild(ce('div', 'stay-hotel-rate', leg.rate));
    trRate.appendChild(td);
  });
  tbody.appendChild(trRate);

  // Row 5: Strategic Notes
  var trNotes = ce('tr', 'stay-route-tr glance-tr');
  trNotes.appendChild(ce('td', 'glance-dimension-cell', '📝 Strategic Notes'));
  route.forEach(function (leg) {
    var td = ce('td', 'glance-col-day-cell');
    td.appendChild(ce('p', 'small muted', leg.notes));
    trNotes.appendChild(td);
  });
  tbody.appendChild(trNotes);

  table.appendChild(tbody);
  container.appendChild(table);
  root.appendChild(container);

  var tip = ce('p', 'muted small text-center', '💡 Nights are arranged horizontally across. Swipe horizontally to view all legs.');
  root.appendChild(tip);

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

function renderStayCard(s, isAlternative, activeStayId) {
  var card = ce('div', 'stay-card');
  var top = ce('div', 'stay-card-header');
  top.appendChild(ce('div', 'stay-name', s.name || s.hotel || 'Stay'));

  var actionsBox = ce('div', null);
  actionsBox.style.display = 'flex';
  actionsBox.style.alignItems = 'center';
  actionsBox.style.gap = '6px';
  actionsBox.style.flexWrap = 'wrap';

  if (isAlternative) {
    var swapBtn = ce('button', 'btn-swap-stay', '⇄ Swap');
    swapBtn.title = 'Swap this option into active lodging for this night';
    swapBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      swapToStay(s.id, activeStayId);
    });
    actionsBox.appendChild(swapBtn);
    actionsBox.appendChild(ce('span', 'badge', 'Wishlist'));
  } else {
    var isBooked = (s.status || '').toLowerCase() === 'booked';
    var statusBtn = ce('button', 'route-status-toggle' + (isBooked ? ' is-booked' : ' is-planned'), isBooked ? '✓ Booked' : 'Planned');
    statusBtn.title = 'Click to toggle Planned / Booked';
    statusBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setStayStatus(s.id, isBooked ? 'planned' : 'booked');
    });
    actionsBox.appendChild(statusBtn);
  }

  top.appendChild(actionsBox);
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

  return card;
}

function renderAccommodationDirectory(root, stays) {
  var toolbar = ce('div', 'card-panel');
  toolbar.style.padding = '10px 12px';
  toolbar.style.marginBottom = '14px';

  // Row 1: Filter by Night Pills
  var nightRow = ce('div', 'filter-pills-row');
  nightRow.style.marginBottom = '8px';
  var nightOptions = [
    { id: 'all', label: 'All Nights' },
    { id: 'night-1', label: 'Night 1' },
    { id: 'night-2', label: 'Night 2' },
    { id: 'night-3', label: 'Night 3' },
    { id: 'night-4', label: 'Night 4' },
    { id: 'night-5', label: 'Night 5' },
    { id: 'nights-6-7', label: 'Nights 6–7' },
    { id: 'night-8', label: 'Night 8' }
  ];
  if (!STATE.stayNightFilter) STATE.stayNightFilter = 'all';

  nightOptions.forEach(function (opt) {
    var pill = ce('button', 'filter-pill' + (STATE.stayNightFilter === opt.id ? ' active' : ''), opt.label);
    pill.addEventListener('click', function () {
      STATE.stayNightFilter = opt.id;
      renderAccommodation();
    });
    nightRow.appendChild(pill);
  });
  toolbar.appendChild(nightRow);

  // Row 2: Filter by Location Pills
  var locRow = ce('div', 'filter-pills-row');
  var locOptions = ['all', 'Hanoi', 'Ha Giang', 'Tam Coc'];
  if (!STATE.stayArea) STATE.stayArea = 'all';

  locOptions.forEach(function (loc) {
    var pill = ce('button', 'filter-pill' + (STATE.stayArea === loc ? ' active' : ''), loc === 'all' ? 'All Locations' : loc);
    pill.addEventListener('click', function () {
      STATE.stayArea = loc;
      renderAccommodation();
    });
    locRow.appendChild(pill);
  });
  toolbar.appendChild(locRow);
  root.appendChild(toolbar);

  // Render by Night Group with collapsible alternatives when booked
  var hasAny = false;
  NIGHT_GROUPS.forEach(function (ng) {
    if (STATE.stayNightFilter !== 'all' && STATE.stayNightFilter !== ng.id) {
      return;
    }

    var groupStays = stays.filter(function (s) {
      return getStayNightId(s) === ng.id;
    });

    if (STATE.stayArea !== 'all') {
      groupStays = groupStays.filter(function (s) {
        var a = ((s.area || s.location || '') + ' ' + (s.name || '')).toLowerCase();
        return a.includes(STATE.stayArea.toLowerCase());
      });
    }

    if (groupStays.length === 0) return;
    hasAny = true;

    var sec = ce('div', 'card-panel');
    sec.style.marginBottom = '14px';

    var h = ce('h3', null, ng.label);
    h.style.marginBottom = '10px';
    sec.appendChild(h);

    var bookedStay = groupStays.find(function (s) {
      return (s.status || '').toLowerCase() === 'booked';
    });
    var plannedStay = groupStays.find(function (s) {
      return (s.status || '').toLowerCase() === 'planned';
    });
    var activeStay = bookedStay || plannedStay;

    if (!activeStay) {
      var route = getPlannedRoute();
      var leg = route.find(function (l) { return l.id === ng.id; });
      if (leg && leg.stayId) {
        activeStay = groupStays.find(function (s) { return s.id === leg.stayId; });
      }
    }
    if (!activeStay && groupStays.length > 0) {
      activeStay = groupStays[0];
      activeStay.status = 'planned';
    }

    if (activeStay) {
      var isBooked = (activeStay.status || '').toLowerCase() === 'booked';
      var alternatives = groupStays.filter(function (s) { return s.id !== activeStay.id; });

      if (isBooked) {
        // Booked stay shown prominently; alternatives collapsed
        sec.appendChild(renderStayCard(activeStay, false, null));

        if (alternatives.length > 0) {
          var isExpanded = !!STATE.expandedNightGroups[ng.id];
          var toggleBtn = ce('button', 'btn-toggle-alts');
          toggleBtn.innerHTML = (isExpanded ? '▴ Hide ' : '▾ View ') + alternatives.length + ' alternative' + (alternatives.length > 1 ? 's' : '') + ' (Swap available)';
          toggleBtn.addEventListener('click', function () {
            STATE.expandedNightGroups[ng.id] = !STATE.expandedNightGroups[ng.id];
            renderAccommodation();
          });
          sec.appendChild(toggleBtn);

          if (isExpanded) {
            var altGrid = ce('div', 'stay-grid');
            altGrid.style.marginTop = '10px';
            alternatives.forEach(function (alt) {
              altGrid.appendChild(renderStayCard(alt, true, activeStay.id));
            });
            sec.appendChild(altGrid);
          }
        }
      } else {
        // Planned stay shown first, followed by alternatives with Swap button
        var grid = ce('div', 'stay-grid');
        grid.appendChild(renderStayCard(activeStay, false, null));
        alternatives.forEach(function (alt) {
          grid.appendChild(renderStayCard(alt, true, activeStay.id));
        });
        sec.appendChild(grid);
      }
    }

    root.appendChild(sec);
  });

  if (!hasAny) {
    root.appendChild(ce('p', 'muted small text-center', 'No stays matching these night and location filters.'));
  }
}

/* ==========================================================================
   3. EXPENSES TAB (Budget Ceiling, Headroom, Active Decision Adjustments)
   ========================================================================== */
function renderExpenses() {
  var root = $('#tab-expenses');
  clear(root);

  var b = calculateBudget();
  var plannedItems = getExpensesPlanned();

  // 1. Budget Headroom Visual Card (Moved from global trip banner)
  var headroomCard = ce('div', 'budget-headroom-banner');
  var hTop = ce('div', null);
  hTop.style.display = 'flex';
  hTop.style.justifyContent = 'space-between';
  hTop.style.alignItems = 'flex-start';
  hTop.style.marginBottom = '8px';

  var hLeft = ce('div', null);
  hLeft.appendChild(ce('div', 'muted small', 'Remaining Headroom'));
  var hVal = ce('div', null, b.headroom != null ? sgd(b.headroom) : '—');
  hVal.style.fontSize = '1.6rem';
  hVal.style.fontWeight = '800';
  hVal.style.color = (b.headroom != null && b.headroom >= 0) ? 'var(--good)' : 'var(--warn)';
  hLeft.appendChild(hVal);
  hTop.appendChild(hLeft);

  var hRight = ce('div', null);
  hRight.style.textAlign = 'right';
  hRight.style.fontSize = '0.78rem';
  hRight.appendChild(ce('div', null, 'Cap: ' + (b.cap != null ? sgd(b.cap) : '—')));
  var spentLine = ce('div', 'muted', 'Planned: ' + sgd(b.net) + (b.delta !== 0 ? ' (' + (b.delta > 0 ? '+' : '') + sgd(b.delta) + ')' : ''));
  hRight.appendChild(spentLine);
  hTop.appendChild(hRight);
  headroomCard.appendChild(hTop);

  var track = ce('div', 'budget-progress-track');
  track.style.height = '6px';
  track.style.background = 'rgba(255, 255, 255, 0.08)';
  track.style.borderRadius = '999px';
  track.style.overflow = 'hidden';

  var pct = (b.cap && b.net) ? Math.min(100, Math.round((b.net / b.cap) * 100)) : 0;
  var fill = ce('div', 'budget-progress-fill');
  fill.style.height = '100%';
  fill.style.width = pct + '%';
  fill.style.background = pct > 90 ? 'var(--warn)' : 'var(--good)';
  fill.style.borderRadius = '999px';
  track.appendChild(fill);
  headroomCard.appendChild(track);
  root.appendChild(headroomCard);

  // 2. Active Decision Deltas Summary Card
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

  // 3. Category Breakdown
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
    var p = totalValid > 0 ? Math.round((amt / totalValid) * 100) : 0;
    var bar = ce('div', 'cat-bar-item');
    var h = ce('div', 'cat-bar-header');
    h.appendChild(ce('span', null, cat.toUpperCase() + ' (' + p + '%)'));
    h.appendChild(ce('span', 'muted', sgd(amt)));
    bar.appendChild(h);

    var cTrack = ce('div', 'cat-bar-track');
    var cFill = ce('div', 'cat-bar-fill');
    cFill.style.width = p + '%';
    cFill.style.background = cat === 'accommodation' ? '#38bdf8' : (cat === 'activities' ? '#34d399' : '#818cf8');
    cTrack.appendChild(cFill);
    bar.appendChild(cTrack);
    catBoxes.appendChild(bar);
  });
  catCard.appendChild(catBoxes);
  root.appendChild(catCard);

  // 4. Space-Saving Itemized Expenses with Sort & Filter Toolbar
  var listCard = ce('div', 'card-panel');
  listCard.appendChild(ce('h3', null, 'Itemized Planning Records'));

  // Filter & Sort Toolbar
  var filterWrap = ce('div', 'expense-filters-toolbar');

  // Category filter pills
  var filterRow = ce('div', 'filter-pills-row');
  filterRow.style.margin = '0';
  var expCats = ['all', 'accommodation', 'transport', 'food', 'activities', 'misc'];
  expCats.forEach(function (c) {
    var pill = ce('button', 'filter-pill' + (STATE.expenseFilterCat === c ? ' active' : ''), c === 'all' ? 'All' : c.slice(0, 5).toUpperCase());
    pill.addEventListener('click', function () {
      STATE.expenseFilterCat = c;
      renderExpenses();
    });
    filterRow.appendChild(pill);
  });
  filterWrap.appendChild(filterRow);

  // Sort buttons
  var sortRow = ce('div', 'view-toggle-group');
  var sorts = [
    { key: 'cost-desc', label: '💰 Cost ↓' },
    { key: 'cost-asc', label: '💰 Cost ↑' },
    { key: 'cat', label: '🏷️ Cat' },
    { key: 'name', label: '🔤 Name' }
  ];
  sorts.forEach(function (s) {
    var sBtn = ce('button', 'view-toggle-btn' + (STATE.expenseSort === s.key ? ' active' : ''), s.label);
    sBtn.style.fontSize = '0.68rem';
    sBtn.style.padding = '3px 7px';
    sBtn.addEventListener('click', function () {
      STATE.expenseSort = s.key;
      renderExpenses();
    });
    sortRow.appendChild(sBtn);
  });
  filterWrap.appendChild(sortRow);
  listCard.appendChild(filterWrap);

  // Filter items
  var filtered = plannedItems.filter(function (it) {
    if (STATE.expenseFilterCat === 'all') return true;
    var c = (it.category || 'misc').toLowerCase();
    return c.includes(STATE.expenseFilterCat.toLowerCase());
  });

  // Sort items
  filtered.sort(function (a, b) {
    var costA = num(a.amount != null ? a.amount : (a.cost_sgd || a.amount_sgd)) || 0;
    var costB = num(b.amount != null ? b.amount : (b.cost_sgd || b.amount_sgd)) || 0;
    if (STATE.expenseSort === 'cost-desc') return costB - costA;
    if (STATE.expenseSort === 'cost-asc') return costA - costB;
    if (STATE.expenseSort === 'cat') return (a.category || '').localeCompare(b.category || '');
    if (STATE.expenseSort === 'name') {
      var nameA = (a.description || a.item || a.name || '');
      var nameB = (b.description || b.item || b.name || '');
      return nameA.localeCompare(nameB);
    }
    return 0;
  });

  if (filtered.length > 0) {
    var table = ce('div', 'compact-expense-table');
    filtered.forEach(function (it) {
      var row = ce('div', 'compact-expense-row');

      var left = ce('div', 'compact-expense-left');
      var catLabel = it.category ? it.category.slice(0, 4).toUpperCase() : 'MISC';
      left.appendChild(ce('span', 'compact-expense-cat', catLabel));

      var info = ce('div', null);
      info.style.minWidth = '0';
      info.style.overflow = 'hidden';
      info.appendChild(ce('div', 'compact-expense-name', it.description || it.item || it.name || it.category));

      var subMeta = [];
      if (it.paid_by) subMeta.push('Paid: ' + it.paid_by);
      if (it.status) subMeta.push(it.status);
      if (it.notes) subMeta.push(it.notes.slice(0, 40) + (it.notes.length > 40 ? '...' : ''));
      if (subMeta.length > 0) {
        var subDiv = ce('div', 'muted tiny', subMeta.join(' · '));
        subDiv.style.textOverflow = 'ellipsis';
        subDiv.style.overflow = 'hidden';
        subDiv.style.whiteSpace = 'nowrap';
        info.appendChild(subDiv);
      }
      left.appendChild(info);
      row.appendChild(left);

      var cost = num(it.amount != null ? it.amount : (it.cost_sgd || it.amount_sgd));
      row.appendChild(ce('div', 'compact-expense-cost', cost != null ? sgd(cost) : '—'));

      table.appendChild(row);
    });
    listCard.appendChild(table);
  } else {
    listCard.appendChild(ce('p', 'muted small text-center', 'No expense items matching this filter.'));
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
        if (STATE.activeTab === 'itinerary') renderItinerary();
        if (STATE.activeTab === 'accommodation') renderAccommodation();
        if (STATE.activeTab === 'expenses') renderExpenses();
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
   5. PACKING TAB (Multi-Traveller Checklists & Exact Categories)
   ========================================================================== */

function getTripTravellersList() {
  var list = [];
  var seen = {};

  var tData = getTravellersData();
  var myName = (tData.my_passport && tData.my_passport.full_name) || (TripAuth.status().user && (TripAuth.status().user.name || TripAuth.status().user.email)) || 'Kester';
  var myId = 'traveller-primary';
  list.push({
    id: myId,
    name: myName,
    isPrimary: true
  });
  seen[myName.toLowerCase()] = true;

  if (Array.isArray(tData.companions)) {
    tData.companions.forEach(function (c, idx) {
      var cName = c.full_name || ('Companion ' + (idx + 1));
      if (!seen[cName.toLowerCase()]) {
        seen[cName.toLowerCase()] = true;
        list.push({
          id: c.id || ('comp-' + idx),
          name: cName,
          isCompanion: true
        });
      }
    });
  }

  // Also include team members if any
  if (Array.isArray(STATE.members)) {
    STATE.members.forEach(function (m, idx) {
      var mName = m.name || (m.invited_email ? m.invited_email.split('@')[0] : (m.email ? m.email.split('@')[0] : ''));
      if (mName && !seen[mName.toLowerCase()]) {
        seen[mName.toLowerCase()] = true;
        list.push({
          id: m.id || ('member-' + idx),
          name: mName,
          isMember: true
        });
      }
    });
  }

  return list;
}

function getTravellerPackingState(travellerId) {
  var doc = STATE.docs.packing;
  if (doc && doc.traveller_checks && doc.traveller_checks[travellerId]) {
    return doc.traveller_checks[travellerId];
  }
  // Fallback to localStorage
  var lsKey = LS_PACKING_PREFIX + (STATE.activeTripId || 'default') + '_' + travellerId;
  var saved = localStorage.getItem(lsKey);
  if (saved) {
    try { return JSON.parse(saved); } catch (e) {}
  }
  // Legacy fallback for primary traveller
  if (travellerId === 'traveller-primary') {
    var oldKey = LS_PACKING_PREFIX + (STATE.activeTripId || 'default');
    var oldSaved = localStorage.getItem(oldKey);
    if (oldSaved) {
      try { return JSON.parse(oldSaved); } catch (e) {}
    }
  }
  return {};
}

function setTravellerPackingState(travellerId, checkedState) {
  var doc = STATE.docs.packing;
  if (!doc || Array.isArray(doc)) {
    var categories = Array.isArray(doc) ? doc : (doc && doc.categories ? doc.categories : []);
    STATE.docs.packing = {
      categories: categories,
      traveller_checks: {}
    };
    doc = STATE.docs.packing;
  }
  if (!doc.traveller_checks) doc.traveller_checks = {};
  doc.traveller_checks[travellerId] = checkedState;

  var lsKey = LS_PACKING_PREFIX + (STATE.activeTripId || 'default') + '_' + travellerId;
  localStorage.setItem(lsKey, JSON.stringify(checkedState));

  savePackingDoc();
}

function renderPacking() {
  var root = $('#tab-packing');
  clear(root);

  var cats = getPackingCategories();
  // Filter out any photo category
  cats = cats.filter(function (c) {
    var catName = (c.category || c.name || '').toLowerCase();
    return !catName.includes('photo');
  });

  if (!cats.length) {
    root.appendChild(renderEmpty('No packing checklist configured.'));
    return;
  }

  var travellers = getTripTravellersList();
  if (!STATE.activePackingTravellerId || !travellers.some(function (t) { return t.id === STATE.activePackingTravellerId; })) {
    STATE.activePackingTravellerId = travellers[0] ? travellers[0].id : 'traveller-primary';
  }

  // 1. Traveller Checklist Selector Bar
  var travBar = ce('div', 'packing-traveller-bar');
  var travBarLabel = ce('span', 'muted tiny', 'Traveller Checklist:');
  travBarLabel.style.fontWeight = '700';
  travBarLabel.style.marginRight = '4px';
  travBar.appendChild(travBarLabel);

  var totalAllItems = 0;
  cats.forEach(function (cat) {
    totalAllItems += (cat.items || []).length;
  });

  travellers.forEach(function (trav) {
    var travState = getTravellerPackingState(trav.id);
    var packedCount = 0;
    cats.forEach(function (cat) {
      var catKey = cat.category || cat.name || 'items';
      (cat.items || []).forEach(function (it) {
        var itemText = typeof it === 'string' ? it : (it.item || it.name || '');
        var itemId = catKey + '_' + itemText;
        if (travState[itemId]) packedCount++;
      });
    });

    var isActive = (trav.id === STATE.activePackingTravellerId);
    var shortName = (trav.name || 'Traveller').split(' ')[0];
    var pillText = '👤 ' + shortName + ' (' + packedCount + '/' + totalAllItems + ')';

    var pill = ce('button', 'filter-pill' + (isActive ? ' active' : ''), pillText);
    pill.title = 'View and edit ' + (trav.name || 'traveller') + '\'s checklist';
    pill.addEventListener('click', function () {
      STATE.activePackingTravellerId = trav.id;
      renderPacking();
    });
    travBar.appendChild(pill);
  });
  root.appendChild(travBar);

  var currentTrav = travellers.find(function (t) { return t.id === STATE.activePackingTravellerId; }) || travellers[0] || { name: 'Traveller' };
  var checkedState = getTravellerPackingState(STATE.activePackingTravellerId);

  cats.forEach(function (cat) {
    var catKey = cat.category || cat.name || 'items';
    var cBox = ce('div', 'packing-category');

    var headerRow = ce('div', 'packing-cat-header');

    var titleBox = ce('div');
    titleBox.style.display = 'flex';
    titleBox.style.alignItems = 'center';
    titleBox.style.gap = '8px';

    var hTitle = ce('h3', null, cat.name || cat.category || 'Items');
    hTitle.style.margin = '0';
    titleBox.appendChild(hTitle);

    var totalItems = (cat.items || []).length;
    var packedCount = (cat.items || []).filter(function (it, idx) {
      var itemText = typeof it === 'string' ? it : (it.item || it.name || '');
      var itemId = catKey + '_' + itemText;
      return !!checkedState[itemId];
    }).length;

    var countBadge = ce('span', 'badge' + (packedCount === totalItems && totalItems > 0 ? ' badge-good' : ''), packedCount + '/' + totalItems + ' packed');
    titleBox.appendChild(countBadge);
    headerRow.appendChild(titleBox);

    // + Add Item Button
    var addBtn = ce('button', 'btn-cat-add-item', '+');
    addBtn.type = 'button';
    addBtn.title = 'Add item to ' + (cat.name || cat.category);
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var newItemName = prompt('Add item to ' + (cat.name || cat.category) + ':');
      if (newItemName && newItemName.trim()) {
        if (!cat.items) cat.items = [];
        cat.items.push({ item: newItemName.trim(), notes: '' });
        savePackingDoc();
        renderPacking();
        showToast('Added: ' + newItemName.trim());
      }
    });
    headerRow.appendChild(addBtn);
    cBox.appendChild(headerRow);

    var list = ce('div', 'checklist');
    (cat.items || []).forEach(function (it, idx) {
      var itemText = typeof it === 'string' ? it : (it.item || it.name || '');
      var itemNotes = typeof it === 'string' ? '' : (it.notes || '');
      var itemId = catKey + '_' + itemText;
      var isDone = !!checkedState[itemId];

      var row = ce('div', 'check-item' + (isDone ? ' done' : ''));

      var box = ce('div', 'check-box', isDone ? '✓' : '');
      box.addEventListener('click', function (e) {
        e.stopPropagation();
        checkedState[itemId] = !checkedState[itemId];
        setTravellerPackingState(STATE.activePackingTravellerId, checkedState);
        renderPacking();
      });
      row.appendChild(box);

      var textWrap = ce('div', null);
      textWrap.style.flex = '1';
      textWrap.style.minWidth = '0';
      textWrap.addEventListener('click', function () {
        checkedState[itemId] = !checkedState[itemId];
        setTravellerPackingState(STATE.activePackingTravellerId, checkedState);
        renderPacking();
      });

      var span = ce('span', 'check-text', itemText);
      textWrap.appendChild(span);
      if (itemNotes) {
        var nEl = ce('div', 'muted tiny', itemNotes);
        textWrap.appendChild(nEl);
      }
      row.appendChild(textWrap);

      // Actions: Edit (✏️) and Delete (−)
      var actions = ce('div', 'packing-item-actions');

      var editBtn = ce('button', 'btn-item-action', '✏️');
      editBtn.type = 'button';
      editBtn.title = 'Edit item';
      editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var updated = prompt('Edit item:', itemText);
        if (updated && updated.trim()) {
          var wasDone = checkedState[itemId];
          delete checkedState[itemId];

          if (typeof it === 'string') {
            cat.items[idx] = updated.trim();
          } else {
            it.item = updated.trim();
          }

          var newId = catKey + '_' + updated.trim();
          if (wasDone) checkedState[newId] = true;
          setTravellerPackingState(STATE.activePackingTravellerId, checkedState);

          savePackingDoc();
          renderPacking();
          showToast('Updated: ' + updated.trim());
        }
      });
      actions.appendChild(editBtn);

      var delBtn = ce('button', 'btn-item-action', '−');
      delBtn.type = 'button';
      delBtn.title = 'Delete item';
      delBtn.style.fontWeight = '800';
      delBtn.style.color = 'var(--warn)';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (confirm('Delete "' + itemText + '"?')) {
          cat.items.splice(idx, 1);
          delete checkedState[itemId];
          setTravellerPackingState(STATE.activePackingTravellerId, checkedState);
          savePackingDoc();
          renderPacking();
          showToast('Deleted item');
        }
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });

    cBox.appendChild(list);
    root.appendChild(cBox);
  });
}

/* ==========================================================================
   6. IDEAS / RECOMMENDATIONS TAB (Curated Pool, Filter by Location & Cat)
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

  // Location filter pills
  var locRow = ce('div', 'filter-pills-row');
  locRow.style.marginBottom = '6px';
  var locs = ['all', 'Hanoi', 'Ha Giang', 'Ninh Binh'];
  locs.forEach(function (loc) {
    var pill = ce('button', 'filter-pill' + (STATE.recLocation === loc ? ' active' : ''), loc === 'all' ? 'All Locations' : loc);
    pill.addEventListener('click', function () {
      STATE.recLocation = loc;
      renderRecommendations();
    });
    locRow.appendChild(pill);
  });
  searchBar.appendChild(locRow);

  // Category filter pills
  var catRow = ce('div', 'filter-pills-row');
  var cats = ['all', 'food', 'coffee', 'culture', 'nature', 'nightlife'];
  cats.forEach(function (c) {
    var pill = ce('button', 'filter-pill' + (STATE.recCategory === c ? ' active' : ''), c === 'all' ? 'All Types' : c.toUpperCase());
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
    if (STATE.recLocation !== 'all') {
      var locMatch = ((r.area || '') + ' ' + (r.location || '') + ' ' + (r.title || '')).toLowerCase();
      if (!locMatch.includes(STATE.recLocation.toLowerCase())) return false;
    }
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

  // Instant Onboarding Link box
  var linkBox = ce('div', 'card-panel');
  linkBox.style.marginTop = '20px';
  linkBox.appendChild(ce('h3', null, '🔗 Instant Onboarding Link'));
  linkBox.appendChild(ce('p', 'muted tiny', 'Anyone with this link can join this trip and collaborate in real-time.'));

  var linkRow = ce('div');
  linkRow.style.display = 'flex';
  linkRow.style.gap = '8px';
  linkRow.style.alignItems = 'center';

  var linkInp = ce('input', 'search-input');
  linkInp.style.flex = '1';
  linkInp.readOnly = true;
  linkInp.value = getTripInviteLink(STATE.activeTripId);

  var copyBtn = ce('button', 'btn btn-secondary small', '📋 Copy Link');
  copyBtn.addEventListener('click', function () {
    copyTripInviteLink(STATE.activeTripId);
  });

  linkRow.appendChild(linkInp);
  linkRow.appendChild(copyBtn);
  linkBox.appendChild(linkRow);
  card.appendChild(linkBox);

  // Invite by email form
  if (STATE.canEdit) {
    var inviteBox = ce('div', 'card-panel');
    inviteBox.style.marginTop = '20px';
    inviteBox.appendChild(ce('h3', null, 'Invite by Email'));
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

function getImmigrationAdvisory(dest, customReq) {
  if (customReq) {
    if (typeof customReq === 'string') {
      return {
        title: (dest ? dest + ' ' : '') + 'Immigration & Entry Requirements',
        text: customReq
      };
    }
    if (typeof customReq === 'object') {
      return {
        title: customReq.title || ((dest ? dest + ' ' : '') + 'Immigration & Entry Advisory'),
        text: customReq.text || customReq.description || customReq.notes || ''
      };
    }
  }

  var d = (dest || '').toLowerCase();
  if (d.includes('vietnam')) {
    return {
      title: 'Vietnam Immigration & Visa-Free Advisory',
      text: 'Singapore and ASEAN passport holders enjoy visa-free entry to Vietnam for up to 30 days. Other passport holders may require an eVisa (available online for up to 90 days). Immigration strictly requires a minimum of 6 months passport validity upon entry date. Verify all travellers have sufficient validity and return tickets before departing.'
    };
  }
  if (d.includes('japan')) {
    return {
      title: 'Japan Immigration & Entry Advisory',
      text: 'Singapore and visa-waiver passport holders enjoy visa-free entry to Japan for up to 90 days for tourism. Passports must be valid for the duration of stay (6+ months validity strongly recommended). Travellers are encouraged to complete the Visit Japan Web digital customs/immigration declaration before departure.'
    };
  }
  if (d.includes('thailand')) {
    return {
      title: 'Thailand Immigration & Entry Advisory',
      text: 'Singapore and visa-exempt nationalities enjoy visa-free entry for up to 60 days. Minimum 6 months passport validity required upon date of entry. Proof of onward travel and sufficient funds may be requested by immigration authorities.'
    };
  }
  if (d.includes('korea')) {
    return {
      title: 'South Korea Immigration & K-ETA Advisory',
      text: 'Singapore passport holders enjoy visa-free entry for up to 90 days (K-ETA currently temporarily exempted or easily obtained online for eligible nationals). Ensure at least 6 months passport validity upon entry.'
    };
  }
  if (d.includes('taiwan')) {
    return {
      title: 'Taiwan Immigration & Entry Advisory',
      text: 'Singapore passport holders enjoy visa-free entry for up to 30 days. Passport must be valid for at least 6 months upon entry date. Online arrival card can be completed within 30 days prior to landing.'
    };
  }
  if (d.includes('indonesia') || d.includes('bali')) {
    return {
      title: 'Indonesia Immigration & Entry Advisory',
      text: 'ASEAN passport holders enjoy visa-free entry for up to 30 days; other nationalities can purchase an Electronic Visa on Arrival (e-VoA). Passport must have at least 6 months remaining validity. Electronic Customs Declaration (e-CD) must be completed online within 3 days prior to arrival.'
    };
  }
  if (d.includes('malaysia')) {
    return {
      title: 'Malaysia Immigration & MDAC Advisory',
      text: 'Singapore passport holders enter visa-free. All foreign travellers (except Malaysian permanent residents and Singapore citizens entering via land checkpoints) must submit the Malaysia Digital Arrival Card (MDAC) within 3 days prior to arrival. Passport must be valid for at least 6 months.'
    };
  }

  // Fallback for custom or international destination
  return {
    title: (dest ? dest + ' ' : 'International ') + 'Immigration & Travel Advisory',
    text: 'Standard international travel regulations require passports to have at least 6 months of validity beyond your planned return date. Verify visa requirements, digital arrival declarations, or return flight prerequisites for ' + (dest || 'your destination') + ' prior to departure.'
  };
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

  // Dynamic Immigration Advisory Card
  var t = STATE.docs.trip || STATE.trip || {};
  var dest = getCleanDestination(t);
  var customReq = (data && data.entry_requirements) || (t && t.entry_requirements) || null;
  var adv = getImmigrationAdvisory(dest, customReq);

  var noticeCard = ce('div', 'passport-notice-card');
  var noticeIcon = ce('div', 'notice-icon', 'ℹ️');
  noticeCard.appendChild(noticeIcon);
  var noticeContent = ce('div');
  noticeContent.appendChild(ce('div', 'notice-title', adv.title));
  noticeContent.appendChild(ce('p', 'notice-text', adv.text));
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

/* ==========================================================================
   9. STRUCTURED MASTER TRIP JSON & AI GENERATION ENGINE
   ========================================================================== */

function getTripInviteLink(tripId) {
  var id = tripId || STATE.activeTripId;
  if (!id) return window.location.href;
  var base = window.location.origin + window.location.pathname;
  return base + '?trip=' + encodeURIComponent(id);
}

function copyTripInviteLink(tripId) {
  var id = tripId || STATE.activeTripId;
  if (!id) {
    showToast('⚠️ No active trip selected.');
    return;
  }
  var link = getTripInviteLink(id);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(function () {
      showToast('🔗 Invite link copied to clipboard!');
    }).catch(function () {
      prompt('Copy this trip invite link:', link);
    });
  } else {
    prompt('Copy this trip invite link:', link);
  }
}

function exportMasterTripJson() {
  var t = STATE.docs.trip || STATE.trip || {};
  var itiDays = getItineraryDays();
  var stays = getAccommodations();
  var route = getPlannedRoute();
  var expenses = getExpensesPlanned();
  var decisions = getDecisions();
  var packing = getPackingCategories();
  var recs = getRecommendations();
  var budgetObj = calculateBudget();

  var master = {
    schema_version: '1.0',
    exported_at: new Date().toISOString(),
    trip: {
      id: STATE.activeTripId || undefined,
      destination: t.destination || t.city || t.title || t.name || 'Nomad Trip',
      start_date: t.start_date || t.start || '',
      end_date: t.end_date || t.end || '',
      currency: t.currency || 'SGD',
      budget_cap: (t.budget_cap != null) ? t.budget_cap : (budgetObj.cap || 2500),
      travellers: t.travellers || 2,
      description: t.description || t.notes || ''
    },
    itinerary: {
      days: itiDays
    },
    accommodation: {
      route: route,
      stays: stays
    },
    expenses: {
      budget_cap: (t.budget_cap != null) ? t.budget_cap : (budgetObj.cap || 2500),
      currency: t.currency || 'SGD',
      planned: expenses
    },
    decisions: decisions,
    packing: {
      categories: packing
    },
    recommendations: recs
  };

  return master;
}

function applyMasterTripJson(master) {
  if (!master || typeof master !== 'object') {
    throw new Error('Invalid JSON format: Expected an object.');
  }

  var tripInfo = master.trip || {};
  var itineraryData = master.itinerary || (master.days ? { days: master.days } : null);
  var accData = master.accommodation || (master.stays ? { stays: master.stays, route: master.route || [] } : null);
  var expData = master.expenses || (master.planned_expenses ? { planned: master.planned_expenses } : null);
  var decsData = master.decisions || null;
  var packData = master.packing || (master.packing_categories ? { categories: master.packing_categories } : null);
  var recsData = master.recommendations || null;

  if (tripInfo.destination || tripInfo.title || tripInfo.name) {
    STATE.docs.trip = Object.assign({}, STATE.docs.trip || {}, tripInfo);
    if (STATE.trip) {
      STATE.trip.name = tripInfo.destination || tripInfo.title || tripInfo.name || STATE.trip.name;
      STATE.trip.destination = tripInfo.destination || STATE.trip.destination;
      STATE.trip.start_date = tripInfo.start_date || STATE.trip.start_date;
      STATE.trip.end_date = tripInfo.end_date || STATE.trip.end_date;
      STATE.trip.currency = tripInfo.currency || STATE.trip.currency;
      if (tripInfo.budget_cap != null) STATE.trip.budget_cap = tripInfo.budget_cap;
    }
  }

  if (itineraryData) {
    STATE.docs.itinerary = itineraryData;
  }
  if (accData) {
    STATE.docs.accommodation = accData;
  }
  if (expData) {
    STATE.docs.expenses = expData;
  }
  if (decsData) {
    STATE.docs.decisions = decsData;
  }
  if (packData) {
    STATE.docs.packing = packData;
  }
  if (recsData) {
    STATE.docs.recommendations = recsData;
  }

  // Persist updated documents to backend & local storage
  if (STATE.activeTripId) {
    TripAuth.saveDocs(STATE.activeTripId, STATE.docs).catch(function (e) {
      console.warn('Failed to save imported docs:', e);
    });
  }

  renderTripBanner();
  renderCurrentTab();
}

function createBlankTrip(dest, startDate, endDate, budget, currency) {
  var tripName = dest || 'New Adventure';
  var cur = currency || 'SGD';
  var bCap = Number(budget) || 2000;
  var sDate = startDate || '';
  var eDate = endDate || '';

  // Calculate day count
  var dayCount = 3;
  if (sDate && eDate) {
    var d1 = new Date(sDate);
    var d2 = new Date(eDate);
    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
      var diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
      if (diffDays > 0 && diffDays <= 60) dayCount = diffDays;
    }
  }

  // Generate blank itinerary days
  var blankDays = [];
  for (var i = 1; i <= dayCount; i++) {
    var curD = '';
    if (sDate) {
      var dObj = new Date(sDate);
      dObj.setDate(dObj.getDate() + (i - 1));
      if (!isNaN(dObj.getTime())) {
        curD = dObj.toISOString().slice(0, 10);
      }
    }
    blankDays.push({
      day: i,
      date: curD,
      focus: 'Day ' + i + ' Focus',
      location: dest.split(',')[0].trim() || 'Destination',
      day_cost_estimate: 0,
      items: []
    });
  }

  // Standard 6 packing categories
  var defaultPacking = [
    {
      id: 'cat-clothings',
      name: 'Clothings',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Light jacket / windbreaker', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Comfortable daily outfits (x' + Math.min(dayCount, 5) + ')', checked: false }
      ]
    },
    {
      id: 'cat-footwear',
      name: 'Footwear',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Walking sneakers', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Slip-on sandals', checked: false }
      ]
    },
    {
      id: 'cat-electronics',
      name: 'Electronics',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Phone charger & cable', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Portable power bank (10,000–20,000mAh)', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Universal travel adapter', checked: false }
      ]
    },
    {
      id: 'cat-documents',
      name: 'Documents',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Passport (valid > 6 months)', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Ballpoint pen (for arrival / customs cards)', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Printed or offline e-ticket & insurance policy', checked: false }
      ]
    },
    {
      id: 'cat-toiletries',
      name: 'Toiletries',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Travel toothbrush & paste', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Sunscreen SPF 50+', checked: false }
      ]
    },
    {
      id: 'cat-medicine',
      name: 'Medicine',
      items: [
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Paracetamol / Pain relief', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Motion sickness & digestive pills', checked: false },
        { id: 'p-' + Math.random().toString(36).slice(2, 7), name: 'Band-aids & antiseptic wipes', checked: false }
      ]
    }
  ];

  var scaffoldDocs = {
    trip: {
      destination: dest,
      start_date: sDate,
      end_date: eDate,
      budget_cap: bCap,
      currency: cur,
      travellers: 2
    },
    itinerary: {
      days: blankDays
    },
    accommodation: {
      route: [],
      stays: []
    },
    expenses: {
      budget_cap: bCap,
      currency: cur,
      planned: []
    },
    decisions: [],
    packing: {
      categories: defaultPacking
    },
    recommendations: []
  };

  showLoading('Creating trip template...');
  return TripAuth.createTrip({
    name: tripName,
    destination: dest,
    start_date: sDate,
    end_date: eDate,
    currency: cur,
    budget_cap: bCap,
    travellers: 2,
    docs: scaffoldDocs
  }).then(function (createdTrip) {
    hideLoading();
    showToast('✨ Trip template created!');
    return TripAuth.listTrips().then(function (trips) {
      STATE.trips = trips || [];
      selectTrip(createdTrip.id);
      return createdTrip;
    });
  }).catch(function (e) {
    hideLoading();
    console.error('Failed to create trip:', e);
    alert('Failed to create trip: ' + (e.message || e));
  });
}

function openAiGeneratorModal(dest, sDate, eDate, budget, curr) {
  var t = STATE.docs.trip || STATE.trip || {};
  var dInp = $('#ai-gen-dest-input');
  var sInp = $('#ai-gen-start-input');
  var eInp = $('#ai-gen-end-input');
  var bInp = $('#ai-gen-budget-input');
  var cSel = $('#ai-gen-currency-select');

  if (dInp) dInp.value = dest || t.destination || t.city || t.title || t.name || '';
  if (sInp) sInp.value = sDate || t.start_date || t.start || '';
  if (eInp) eInp.value = eDate || t.end_date || t.end || '';
  if (bInp) bInp.value = budget != null ? budget : (t.budget_cap || t.budget || 2500);
  if (cSel) cSel.value = curr || t.currency || 'SGD';

  $('#ai-gen-form-view').hidden = false;
  $('#ai-gen-progress-view').hidden = true;
  $('#ai-generator-modal').hidden = false;
}

function closeAiGeneratorModal() {
  $('#ai-generator-modal').hidden = true;
}

function executeAICompletion(messages, onStatus) {
  var provider = localStorage.getItem('nomad_ai_provider') || 'openrouter';
  var apiKey = (localStorage.getItem('nomad_ai_key') || '').trim();
  var customModel = (localStorage.getItem('nomad_ai_model') || '').trim();
  var customEndpoint = (localStorage.getItem('nomad_ai_endpoint') || '').trim();

  if (!apiKey && provider !== 'custom') {
    return Promise.reject(new Error('Please configure your AI API key in Account Settings first.'));
  }

  var endpoint = '';
  var model = '';
  var headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }

  if (provider === 'openrouter') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    model = customModel || 'google/gemini-2.0-flash-001';
    headers['HTTP-Referer'] = window.location.origin || 'https://alienlab.tailbed832.ts.net:10000/trip/';
    headers['X-Title'] = 'Nomad Trip Planner';
  } else if (provider === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    model = customModel || 'gpt-4o-mini';
  } else if (provider === 'gemini') {
    endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    model = customModel || 'gemini-2.0-flash';
  } else if (provider === 'groq') {
    endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    model = customModel || 'llama-3.3-70b-versatile';
  } else if (provider === 'deepseek') {
    endpoint = 'https://api.deepseek.com/chat/completions';
    model = customModel || 'deepseek-chat';
  } else if (provider === 'custom') {
    endpoint = customEndpoint || 'http://localhost:11434/v1/chat/completions';
    model = customModel || 'default';
  }

  if (typeof onStatus === 'function') onStatus('Sending request to ' + provider + ' (' + model + ')...');

  var payload = {
    model: model,
    messages: messages,
    temperature: 0.7
  };

  return fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        var errDetail = t;
        try {
          var parsedErr = JSON.parse(t);
          errDetail = (parsedErr.error && parsedErr.error.message) || t;
        } catch (e) {}
        throw new Error('AI API Error (' + res.status + '): ' + errDetail);
      });
    }
    return res.json();
  }).then(function (data) {
    if (!data || !data.choices || !data.choices.length || !data.choices[0].message) {
      throw new Error('AI returned an empty or invalid response format.');
    }
    return data.choices[0].message.content;
  });
}

function extractJsonFromAiResponse(rawText) {
  var text = (rawText || '').trim();
  var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }
  var firstBrace = text.indexOf('{');
  var lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(text);
}

function startAiTripGeneration() {
  var key = (localStorage.getItem('nomad_ai_key') || '').trim();
  var prov = localStorage.getItem('nomad_ai_provider') || 'openrouter';
  if (!key && prov !== 'custom') {
    alert('AI API Key Required:\nPlease configure your API key in Account Settings (top right avatar → AI Trip Planner Settings) before generating trips.');
    closeAiGeneratorModal();
    openUserModal(TripAuth.status().user || {});
    return;
  }

  var dest = ($('#ai-gen-dest-input').value || '').trim();
  if (!dest) {
    alert('Please enter a destination.');
    return;
  }
  var sDate = $('#ai-gen-start-input').value;
  var eDate = $('#ai-gen-end-input').value;
  var budget = parseFloat($('#ai-gen-budget-input').value) || 2500;
  var curr = $('#ai-gen-currency-select').value || 'SGD';
  var promptNotes = ($('#ai-gen-prompt-input').value || '').trim();

  var activeVibePill = $('#ai-gen-vibe-pills .filter-pill.active');
  var vibe = activeVibePill ? (activeVibePill.dataset.vibe || activeVibePill.textContent) : 'Balanced Highlights & Must-Sees';

  $('#ai-gen-form-view').hidden = true;
  $('#ai-gen-progress-view').hidden = false;
  $('#ai-gen-progress-title').textContent = 'Consulting AI travel intelligence...';
  $('#ai-gen-progress-sub').textContent = 'Structuring ' + dest + ' daily schedule, stays & budget';

  var systemPrompt = 
    "You are Nomad, an elite AI travel architect. Given a destination, dates, budget, and travel vibe, " +
    "create a detailed, realistic, and complete trip plan. You MUST respond with ONLY a single raw JSON object " +
    "conforming strictly to the Nomad Master Trip Schema. Do NOT include markdown code blocks (no ```json), commentary, or text outside the JSON.\n\n" +
    "SCHEMA FORMAT:\n" +
    "{\n" +
    '  "schema_version": "1.0",\n' +
    '  "trip": {\n' +
    '    "destination": "' + dest + '",\n' +
    '    "start_date": "' + sDate + '",\n' +
    '    "end_date": "' + eDate + '",\n' +
    '    "currency": "' + curr + '",\n' +
    '    "budget_cap": ' + budget + ',\n' +
    '    "travellers": 2,\n' +
    '    "description": "Short summary"\n' +
    '  },\n' +
    '  "itinerary": {\n' +
    '    "days": [\n' +
    '      {\n' +
    '        "day": 1,\n' +
    '        "date": "YYYY-MM-DD",\n' +
    '        "focus": "Daily theme / highlight",\n' +
    '        "location": "City or Neighborhood",\n' +
    '        "day_cost_estimate": 40,\n' +
    '        "items": [\n' +
    '          {\n' +
    '            "time": "09:00",\n' +
    '            "what": "Activity title",\n' +
    '            "type": "stay" | "food" | "activity" | "transit",\n' +
    '            "slot": "morning" | "afternoon" | "evening" | "night",\n' +
    '            "cost": 15,\n' +
    '            "currency": "' + curr + '",\n' +
    '            "booking_url": "https://...",\n' +
    '            "booking_platform": "Klook / Booking.com / 12Go / Direct",\n' +
    '            "notes": "Practical local tip or address"\n' +
    '          }\n' +
    '        ]\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  "accommodation": {\n' +
    '    "route": [\n' +
    '      {\n' +
    '        "id": "leg-1",\n' +
    '        "stayId": "acc-1",\n' +
    '        "nights": "Night 1 (DD–DD MMM)",\n' +
    '        "city": "City area",\n' +
    '        "hotelName": "Hotel name",\n' +
    '        "rate": "price per night",\n' +
    '        "status": "Planned",\n' +
    '        "notes": "Location highlights"\n' +
    '      }\n' +
    '    ],\n' +
    '    "stays": [\n' +
    '      {\n' +
    '        "id": "acc-1",\n' +
    '        "name": "Hotel Name",\n' +
    '        "city": "City Area",\n' +
    '        "nights": "Night 1",\n' +
    '        "status": "planned" | "wishlist",\n' +
    '        "price_sgd": 65,\n' +
    '        "price_local": "Local currency price",\n' +
    '        "rating": 9.2,\n' +
    '        "badge": "Recommended",\n' +
    '        "booking_url": "https://booking.com",\n' +
    '        "notes": "Pros and amenities"\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  "expenses": {\n' +
    '    "budget_cap": ' + budget + ',\n' +
    '    "currency": "' + curr + '",\n' +
    '    "planned": [\n' +
    '      { "id": "exp-1", "category": "Flights"|"Lodging"|"Activities"|"Transit"|"Food & Dining"|"Buffer", "name": "Item name", "amount_sgd": 350, "notes": "Details" }\n' +
    '    ]\n' +
    '  },\n' +
    '  "decisions": [\n' +
    '    {\n' +
    '      "id": "dec-1",\n' +
    '      "title": "Decision title",\n' +
    '      "question": "Decision question or trade-off",\n' +
    '      "status": "open",\n' +
    '      "options": [\n' +
    '        {\n' +
    '          "id": "opt-1",\n' +
    '          "label": "Option Title",\n' +
    '          "cost_delta": 0,\n' +
    '          "summary": "Pros and tradeoffs",\n' +
    '          "schedule_impact": [\n' +
    '            { "day": 2, "action": "replace", "target": "old activity", "what": "New Activity Title", "type": "activity", "slot": "morning", "cost": 15 }\n' +
    '          ],\n' +
    '          "accommodation_impact": [\n' +
    '            { "leg_id": "leg-1", "hotel_name": "Alternative Hotel", "rate": "85 SGD", "stay_id": "acc-1" }\n' +
    '          ]\n' +
    '        }\n' +
    '      ]\n' +
    '    }\n' +
    '  ],\n' +
    '  "packing": {\n' +
    '    "categories": [\n' +
    '      { "id": "cat-clothings", "name": "Clothings", "items": [{ "id": "p-1", "name": "Item", "checked": false }] },\n' +
    '      { "id": "cat-footwear", "name": "Footwear", "items": [{ "id": "p-2", "name": "Item", "checked": false }] },\n' +
    '      { "id": "cat-electronics", "name": "Electronics", "items": [{ "id": "p-3", "name": "Item", "checked": false }] },\n' +
    '      { "id": "cat-documents", "name": "Documents", "items": [{ "id": "p-4", "name": "Passport", "checked": false }, { "id": "p-5", "name": "Ballpoint pen (for arrival cards)", "checked": false }] },\n' +
    '      { "id": "cat-toiletries", "name": "Toiletries", "items": [{ "id": "p-6", "name": "Item", "checked": false }] },\n' +
    '      { "id": "cat-medicine", "name": "Medicine", "items": [{ "id": "p-7", "name": "Item", "checked": false }] }\n' +
    '    ]\n' +
    '  },\n' +
    '  "recommendations": [\n' +
    '    { "id": "rec-1", "name": "Spot Name", "category": "Food & Drink"|"Must-See"|"Hidden Gem"|"Nightlife", "location": "Area", "rating": 4.9, "cost_estimate": "$$", "notes": "Why visit" }\n' +
    '  ]\n' +
    '}';

  var userPrompt =
    "Generate a complete trip plan for " + dest + ".\n" +
    (sDate && eDate ? ("- Dates: " + sDate + " to " + eDate + "\n") : "") +
    "- Target Budget: " + budget + " " + curr + "\n" +
    "- Travel Style: " + vibe + "\n" +
    (promptNotes ? ("- Specific Preferences: " + promptNotes + "\n") : "") +
    "\nEnsure every day has rich morning, afternoon, evening, and night activities with explicit 'type' and 'slot' fields. Include stays with 'status', budget breakdown, fork decisions, 6 packing categories (Clothings, Footwear, Electronics, Documents including ballpoint pen, Toiletries, Medicine), and top recommendations.";

  var messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  executeAICompletion(messages, function (statusText) {
    $('#ai-gen-progress-sub').textContent = statusText;
  }).then(function (rawText) {
    $('#ai-gen-progress-title').textContent = 'Finalizing trip plan...';
    $('#ai-gen-progress-sub').textContent = 'Applying daily schedule and lodging';
    var parsed = extractJsonFromAiResponse(rawText);
    applyMasterTripJson(parsed);
    closeAiGeneratorModal();
    showToast('✨ ' + dest + ' trip planned successfully with AI!');
  }).catch(function (err) {
    console.error('AI Trip Generation Error:', err);
    $('#ai-gen-form-view').hidden = false;
    $('#ai-gen-progress-view').hidden = true;
    alert('AI Trip Planning Error:\n' + (err.message || err));
  });
}

function openJsonIoModal(defaultTab) {
  var activeTab = defaultTab || 'export';
  setJsonIoTab(activeTab);

  if (activeTab === 'export') {
    var master = exportMasterTripJson();
    $('#json-export-textarea').value = JSON.stringify(master, null, 2);
  }

  $('#json-io-modal').hidden = false;
}

function closeJsonIoModal() {
  $('#json-io-modal').hidden = true;
}

function setJsonIoTab(tab) {
  var expBtn = $('#json-tab-export-btn');
  var impBtn = $('#json-tab-import-btn');
  var expPane = $('#json-export-pane');
  var impPane = $('#json-import-pane');

  if (tab === 'export') {
    expBtn.classList.add('active');
    impBtn.classList.remove('active');
    expPane.hidden = false;
    impPane.hidden = true;
    var master = exportMasterTripJson();
    $('#json-export-textarea').value = JSON.stringify(master, null, 2);
  } else {
    impBtn.classList.add('active');
    expBtn.classList.remove('active');
    impPane.hidden = false;
    expPane.hidden = true;
  }
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

/// <reference path="../pb_data/types.d.ts" />
//
// 10_trip_docs_immutable_trip.pb.js — a document cannot be moved to another trip
// (added by Nova, alienlab — closes audit finding F1, card t_55377bca)
//
// Why this has to be a hook: collection *rules* are evaluated against the
// record's pre-update state, so `trip_docs.updateRule` (membership of the OLD
// trip) is satisfied before the submitted `trip` value is applied. A signed-in
// user with zero memberships could therefore PATCH its own document onto any
// trip id it could name: data injected into that trip's documents, plus a squat
// on an unused (trip, section) slot through the unique index.
//
// This hook runs on the update *request* path (REST API + admin dashboard),
// where `e.record` already carries the submitted values while
// `e.record.original()` still holds the stored ones. Genuine superuser requests
// (admin dashboard, ops scripts) stay exempt, and migrations or direct
// `$app.save()` calls never fire request hooks, so schema work is unaffected.
//
// Verified against PocketBase 0.40.4 on this box: `original()` is populated for
// update requests, and `e.hasSuperuserAuth()` is false for an impersonated
// (non-superuser) token.

onRecordUpdateRequest((e) => {
  const rec = e.record;
  if (!rec) {
    return e.next();
  }

  const orig = rec.original();
  const before = orig ? (orig.getString("trip") || "") : "";
  const after = rec.getString("trip") || "";

  if (before === after) {
    return e.next(); // no re-point: every other field stays freely writable
  }

  if (e.hasSuperuserAuth()) {
    return e.next(); // superuser / admin dashboard / ops move documents on purpose
  }

  console.log("[trip_docs] blocked trip FK move: doc=" + rec.id
    + " from=" + (before || "(none)") + " to=" + (after || "(none)")
    + " auth=" + (e.auth ? e.auth.collection().name + ":" + e.auth.id : "none"));

  throw new ForbiddenError("A document cannot be moved to another trip.");
}, "trip_docs");

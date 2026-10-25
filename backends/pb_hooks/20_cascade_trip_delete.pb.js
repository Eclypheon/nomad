/// <reference path="../pb_data/types.d.ts" />
//
// 20_cascade_trip_delete.pb.js — deleting a trip deletes everything that hangs
// off it (documents, memberships, invitations, picks).
//
// Why a hook: PocketBase has no foreign-key cascade, and its delete rules are
// per-collection. Without this, removing a `trips` record leaves orphaned
// trip_docs / trip_members / trip_invites rows that no trip can reach — dead
// rows in the database that still satisfy "is this email a member" checks.
//
// It runs AFTER the delete succeeded (onRecordAfterDeleteSuccess), so a refused
// trip delete (wrong owner, rule) never takes the children with it.
//
// NOTE (PocketBase caveat): each handler runs in its own isolated context, so
// there are no file-scope helpers here — the collections are inlined.

onRecordAfterDeleteSuccess((e) => {
  const tripId = e.record ? e.record.id : "";
  if (!tripId) {
    return e.next();
  }

  const collections = ["trip_docs", "trip_members", "trip_invites", "trip_picks"];
  for (let i = 0; i < collections.length; i++) {
    const name = collections[i];
    try {
      const rows = $app.findRecordsByFilter(name, "trip = {:trip}", "", 500, 0, { trip: tripId });
      for (let j = 0; j < rows.length; j++) {
        $app.delete(rows[j]);
      }
      if (rows.length) {
        $app.logger().info("trip delete cascade", "collection", name, "trip", tripId, "rows", rows.length);
      }
    } catch (err) {
      // a missing collection (e.g. picks not deployed) must not fail the delete
      $app.logger().warn("trip delete cascade skipped", "collection", name, "error", String(err));
    }
  }

  e.next();
}, "trips");

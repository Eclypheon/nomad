/// <reference path="../pb_data/types.d.ts" />
//
// 00_invite_gate.pb.js — invite-only sign-up gate + email normalisation + onboarding link auto-join
// (alienlab trip backend; updated 2026-10-07)
//
// A `users` record may only be created when ONE of these holds:
//   1. its email is listed in the OWNER_EMAILS env var (comma separated), or
//   2. the one-shot bootstrap marker file exists, `users` is still EMPTY, and
//      (OWNER_EMAILS is empty OR the email is in it), or
//   3. a `trip_invites` row already exists for that email (created via email invite
//      or created via OAuth onboarding link for an existing trip).
//
// Anything else is rejected with 403.
//
// When a user signs up via an onboarding link (?trip=<id>):
//   - onRecordAuthWithOAuth2Request validates the trip ID and creates a trip_invites row
//     for (trip, oAuth2User.email) before record creation occurs.
//   - onRecordCreate checks trip_invites, finds the newly created invite, and permits account creation.
//   - onRecordAfterCreateSuccess automatically adds the new user to trip_members for all
//     their pending invites, preloading the trip into their trips list.
//
// In addition:
//   - /api/nomad/join endpoint allows authenticated users opening invite links to join trips.
//
// NOTE (PocketBase caveat): every handler below is serialized and executed in
// its own isolated context, so helpers/constants declared at file scope are NOT
// visible inside a handler — the logic is deliberately inlined per handler.
// Ref: https://pocketbase.io/docs/js-overview/#handlers-scope
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Normalise emails on create & update
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
    e.record.set("invite_email", (e.record.getString("invite_email") || "").trim().toLowerCase());
    e.next();
}, "trip_invites");

onRecordUpdate((e) => {
    e.record.set("invite_email", (e.record.getString("invite_email") || "").trim().toLowerCase());
    e.next();
}, "trip_invites");

onRecordCreate((e) => {
    e.record.set("email", (e.record.getString("email") || "").trim().toLowerCase());
    e.next();
}, "users");

onRecordUpdate((e) => {
    e.record.set("email", (e.record.getString("email") || "").trim().toLowerCase());
    e.next();
}, "users");

// ---------------------------------------------------------------------------
// Onboarding link detection during OAuth2 flow
// Runs BEFORE user record creation.
// ---------------------------------------------------------------------------
onRecordAuthWithOAuth2Request((e) => {
    let tripId = "";

    // 1. Check createData
    if (e.createData && e.createData["invite_trip"]) {
        tripId = String(e.createData["invite_trip"] || "").trim();
        delete e.createData["invite_trip"];
    }

    // 2. Fallback to requestInfo query / body / headers
    if (!tripId && e.requestInfo) {
        try {
            const req = e.requestInfo();
            if (req && req.query && (req.query["trip"] || req.query["join"])) {
                tripId = String(req.query["trip"] || req.query["join"] || "").trim();
            } else if (req && req.body && req.body["createData"] && req.body["createData"]["invite_trip"]) {
                tripId = String(req.body["createData"]["invite_trip"] || "").trim();
            } else if (req && req.headers && req.headers["x-nomad-trip"]) {
                tripId = String(req.headers["x-nomad-trip"] || "").trim();
            }
        } catch (_) {}
    }

    // Clean up if raw link/query was passed
    if (tripId) {
        const m = tripId.match(/(?:^|[#?&/])(?:trip|join)=([^&\s]+)/i);
        if (m) {
            tripId = m[1].replace(/\/+$/, "");
        }
    }

    const email = (e.oAuth2User && e.oAuth2User.email ? e.oAuth2User.email : "").trim().toLowerCase();

    if (tripId && email) {
        let trip = null;
        try {
            trip = $app.findRecordById("trips", tripId);
        } catch (_) {
            trip = null;
        }

        if (trip) {
            // Create invite if not already present
            let inviteRec = null;
            try {
                inviteRec = $app.findFirstRecordByFilter(
                    "trip_invites",
                    "trip = {:trip} && invite_email = {:email}",
                    { trip: trip.id, email: email }
                );
            } catch (_) {
                inviteRec = null;
            }

            if (!inviteRec) {
                try {
                    const invitesColl = $app.findCollectionByNameOrId("trip_invites");
                    inviteRec = new Record(invitesColl);
                    inviteRec.set("trip", trip.id);
                    inviteRec.set("invite_email", email);
                    inviteRec.set("role", "member");
                    inviteRec.set("trip_title", trip.getString("title") || "");
                    inviteRec.set("invited_by", trip.getString("owner") || "");
                    $app.save(inviteRec);
                    $app.logger().info("invite gate: created invite row for oauth onboarding", "trip", trip.id, "email", email);
                } catch (err) {
                    $app.logger().error("invite gate: failed creating invite for oauth onboarding", "error", String(err));
                }
            }

            // If user already exists (e.isNewRecord === false), add them to trip_members immediately
            if (!e.isNewRecord && e.record) {
                const userId = e.record.id;
                let memberRec = null;
                try {
                    memberRec = $app.findFirstRecordByFilter(
                        "trip_members",
                        "trip = {:trip} && member = {:member}",
                        { trip: trip.id, member: userId }
                    );
                } catch (_) {
                    memberRec = null;
                }
                if (!memberRec) {
                    try {
                        const membersColl = $app.findCollectionByNameOrId("trip_members");
                        memberRec = new Record(membersColl);
                        memberRec.set("trip", trip.id);
                        memberRec.set("member", userId);
                        memberRec.set("role", "member");
                        memberRec.set("member_email", email);
                        memberRec.set("member_name", e.record.getString("name") || (e.oAuth2User && e.oAuth2User.name) || "");
                        memberRec.set("member_avatar", e.record.getString("avatar") || (e.oAuth2User && e.oAuth2User.avatarURL) || "");
                        $app.save(memberRec);
                        $app.logger().info("invite gate: added existing user to trip_members", "trip", trip.id, "user", userId);
                    } catch (err) {
                        $app.logger().error("invite gate: failed adding existing user to trip_members", "error", String(err));
                    }
                }
            }
        }
    }

    e.next();
}, "users");

// ---------------------------------------------------------------------------
// The invite gate itself (enforced on users creation).
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
    const email = (e.record.getString("email") || "").trim().toLowerCase();
    if (email === "") {
        throw new ForbiddenError("An email address is required.");
    }

    const owners = ($os.getenv("OWNER_EMAILS") || "")
        .split(",")
        .map((s) => (s || "").trim().toLowerCase())
        .filter((s) => s !== "");

    // 1. configured owner address
    if (owners.indexOf(email) >= 0) {
        return e.next();
    }

    // 2. explicit one-shot bootstrap on an empty user table
    let markerPresent = false;
    try {
        $os.stat("/pb_data/.allow-bootstrap");
        markerPresent = true;
    } catch (err) {
        markerPresent = false;
    }
    if (markerPresent && $app.countRecords("users") === 0 && (owners.length === 0 || owners.indexOf(email) >= 0)) {
        $app.logger().info("invite gate: one-shot bootstrap used", "email", email);
        return e.next();
    }

    // 3. invited address
    try {
        $app.findFirstRecordByFilter("trip_invites", "invite_email = {:email}", { email: email });
        return e.next();
    } catch (err) {
        throw new ForbiddenError(
            "This app is invite-only. Ask the trip owner to invite " + email + " first."
        );
    }
}, "users");

// ---------------------------------------------------------------------------
// After successful user creation: consume marker + auto-join invited trips
// ---------------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
    // 1. Consume bootstrap marker if present
    try {
        $os.stat("/pb_data/.allow-bootstrap");
        try {
            $os.remove("/pb_data/.allow-bootstrap");
            $app.logger().info("invite gate: bootstrap marker consumed");
        } catch (err) {
            $app.logger().error("invite gate: could not remove bootstrap marker", "error", String(err));
        }
    } catch (err) {}

    // 2. Auto-join any trips where this email has an invite
    try {
        const userEmail = (e.record.getString("email") || "").trim().toLowerCase();
        const userId = e.record.id;
        if (userEmail && userId) {
            const invites = $app.findRecordsByFilter(
                "trip_invites",
                "invite_email = {:email}",
                "-created",
                50,
                0,
                { email: userEmail }
            );
            if (invites && invites.length > 0) {
                const membersColl = $app.findCollectionByNameOrId("trip_members");
                for (let i = 0; i < invites.length; i++) {
                    const inv = invites[i];
                    if (!inv) continue;
                    const tripId = inv.getString("trip");
                    if (!tripId) continue;
                    let existingMember = null;
                    try {
                        existingMember = $app.findFirstRecordByFilter(
                            "trip_members",
                            "trip = {:trip} && member = {:member}",
                            { trip: tripId, member: userId }
                        );
                    } catch (_) {}
                    if (!existingMember) {
                        const memberRec = new Record(membersColl);
                        memberRec.set("trip", tripId);
                        memberRec.set("member", userId);
                        memberRec.set("role", "member");
                        memberRec.set("member_email", userEmail);
                        memberRec.set("member_name", e.record.getString("name") || "");
                        memberRec.set("member_avatar", e.record.getString("avatar") || "");
                        $app.save(memberRec);
                        $app.logger().info("invite gate: auto-joined new user to trip", "trip", tripId, "user", userId);
                    }
                }
            }
        }
    } catch (joinErr) {
        $app.logger().error("invite gate: failed to auto-join invited trips", "error", String(joinErr));
    }

    e.next();
}, "users");

// ---------------------------------------------------------------------------
// Endpoint for authenticated users to join a trip via link
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/nomad/join", (e) => {
    const user = e.auth;
    if (!user) {
        throw new UnauthorizedError("You must be signed in to join a trip.");
    }
    const info = e.requestInfo();
    const body = (info && info.body) || {};
    let tripId = String(body.trip || (info.query && info.query.trip) || "").trim();
    if (!tripId) {
        throw new BadRequestError("No trip specified.");
    }
    const m = tripId.match(/(?:^|[#?&/])(?:trip|join)=([^&\s]+)/i);
    if (m) {
        tripId = m[1].replace(/\/+$/, "");
    }

    let trip = null;
    try {
        trip = $app.findRecordById("trips", tripId);
    } catch (_) {
        throw new NotFoundError("Trip not found.");
    }

    const userId = user.id;
    const userEmail = (user.getString("email") || "").trim().toLowerCase();
    const userName = user.getString("name") || "";
    const userAvatar = user.getString("avatar") || "";

    // 1. Ensure invite record exists
    let inviteRec = null;
    try {
        inviteRec = $app.findFirstRecordByFilter(
            "trip_invites",
            "trip = {:trip} && invite_email = {:email}",
            { trip: trip.id, email: userEmail }
        );
    } catch (_) {}
    if (!inviteRec) {
        try {
            const invitesColl = $app.findCollectionByNameOrId("trip_invites");
            inviteRec = new Record(invitesColl);
            inviteRec.set("trip", trip.id);
            inviteRec.set("invite_email", userEmail);
            inviteRec.set("role", "member");
            inviteRec.set("trip_title", trip.getString("title") || "");
            inviteRec.set("invited_by", trip.getString("owner") || "");
            $app.save(inviteRec);
        } catch (_) {}
    }

    // 2. Ensure member record exists
    let memberRec = null;
    try {
        memberRec = $app.findFirstRecordByFilter(
            "trip_members",
            "trip = {:trip} && member = {:member}",
            { trip: trip.id, member: userId }
        );
    } catch (_) {}
    if (!memberRec) {
        const membersColl = $app.findCollectionByNameOrId("trip_members");
        memberRec = new Record(membersColl);
        memberRec.set("trip", trip.id);
        memberRec.set("member", userId);
        memberRec.set("role", "member");
        memberRec.set("member_email", userEmail);
        memberRec.set("member_name", userName);
        memberRec.set("member_avatar", userAvatar);
        $app.save(memberRec);
    }

    return e.json(200, {
        success: true,
        trip: trip.id,
        title: trip.getString("title") || ""
    });
}, $apis.requireAuth("users"));

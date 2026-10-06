# Sources & audit trail — Northern Vietnam plan (Christmas → New Year 2026/27)

Two people, from SIN. Plan files: `data/trip.json`, `data/itinerary.json`,
`data/packing.json`, `data/expenses.json`. This file exists so every non-obvious
number in them can be traced or dismissed.

**Provenance labels used below:**

- **[me]** — I (Nomad) opened the page/source myself and read the claim. All `[me]`
  checks were done **2026-10-07** unless a different date is shown.
- **[researcher]** — the claim comes from the upstream research task (profile `mugger`,
  task `t_b9d8842b`, completed 2026-10-07) and its files in `research/` and `data/`.
  I did **not** re-open these pages.
- **[judgement]** — no source; a planning decision I am accountable for.

FX used throughout: **1 SGD = 20,285.32 VND**, **1 USD = 25,965 VND** (≈ 1 USD =
1.28 SGD). **[me]** — `https://open.er-api.com/v6/latest/SGD`, base SGD, response
`time_last_update_utc` = *Tue, 06 Oct 2026 00:02:31 +0000*, fetched 2026-10-07.
This matches the researcher's FX exactly, so the two files' conversions agree.

---

## 1. What I (Nomad) verified myself on 2026-10-07

| # | Claim, as used in the plan | Source | Note |
|---|---|---|---|
| 1 | **Singapore passports enter Vietnam visa-free, up to 30 days per entry.** Used in `packing.json` (documents) and day 1 of the itinerary. | [me] Singapore MFA, Vietnam travel page — `https://www.mfa.gov.sg/travelling-overseas/travel-advisories-notices-and-visa-information/vietnam/` | Verbatim: *"Generally, Singapore Passport Holders do not require a visa to enter Vietnam and can remain up to 30 days per entry."* MFA adds that entry approval is ultimately at the discretion of Vietnam Immigration. |
| 2 | **The pre-arrival online information declaration does NOT apply at Noi Bai (Hanoi)** — it is currently enforced only at Tan Son Nhat (HCMC). Used in day 1. | [me] same MFA page | Verbatim: *"This system is expected to be deployed nationwide in the future but is currently only effective for Tan Son Nhat Airport in Ho Chi Minh City."* **Re-check before departure** — this is exactly the kind of rule that changes. |
| 3 | **Tap water is not safe to drink**; avoid unboiled water and ice from unknown sources. Used in `packing.json` (trekking, health). | [me] same MFA page | MFA also recommends charcoal and diarrhoea medication on standby, and immunisation against cholera, hepatitis A & B, typhoid, tetanus, polio, encephalitis and rabies. |
| 4 | **eRegister with MFA before departure**; emergency numbers police 113 / fire 114 / ambulance 115. Used in `packing.json` and day 9. | [me] same MFA page | `https://eregister.mfa.gov.sg` |
| 5 | **Duty-free allowance into Vietnam: other goods to VND 5,000,000**, and the customs declaration form is required above it. Used in `packing.json` (documents, cash line). | [me] Vietnam Government Portal, `https://vietnam.gov.vn/visa-exemption-68946` | Official government portal. The same page carries the customs currency section. |
| 6 | **Scoot economy baggage: cabin 2 pieces, max 10 kg TOTAL** (carry-on ≤ 54 × 38 × 23 cm / 115 cm linear; personal item ≤ 40 × 30 × 10 cm); **checked baggage is NOT included in the Basic fare**; Value/Flex include 20 kg; ScootPlus 30 kg; up to 40 kg purchasable; max 32 kg per bag and ≤ 158 cm linear. Used in `packing.json` (basis.baggage_allowance_used) and day 9. | [me] `https://www.flyscoot.com/en/plan/booking-your-flight/fares-fees` and `.../booking-your-flight/baggage` | This is the "real baggage allowance of a likely carrier" the brief asked packing to be derived from. |
| 7 | **Spare lithium batteries / power banks must travel in the cabin**, max 2 power banks per passenger, and **power banks may not be stowed in the overhead locker**. Used in `packing.json` (photo). | [me] Scoot baggage page (above) | Matters for a camera-heavy trip in cold weather. |
| 8 | **The weekdays in the plan are correct**: 24 Dec 2026 = Thursday … 31 Dec = Thursday, 1 Jan 2027 = Friday. | [me] local `date` on this machine | Trivial but load-bearing for a plan built around Christmas Eve and NYE. |
| 9 | **FX rate** (see the top of this file). | [me] open.er-api.com | — |

### Checked and found *not* to exist
| Claim | Finding | Source |
|---|---|---|
| An **overnight train** to Ha Giang | **It does not exist.** Ha Giang has no railway and no airport; the road (bus / limousine van / private car) is the only way. The brief's example of "the overnight train" as a booking deadline therefore maps onto the **overnight sleeper bus**. The Hanoi–Lao Cai SP1–SP4 night trains serve **Sapa**, which this plan excludes. | [researcher] `research/transport.md` §3 and §5 |
| A **forecast** for the trip window | **None exists.** The window is ~2.5 months away and operational outlooks run ~14 days. `packing.json` is therefore derived from **climatological normals**, stated as such in `packing.json.basis`, with a "re-check ~7 days out" instruction. | [me] — this is an availability statement, not a sourced page: I did not find any service publishing a daily forecast for Dec 2026. The authoritative re-check point is the Vietnam National Centre for Hydro-Meteorological Forecasting (`https://kttv.gov.vn/`). |

---

## 2. From the research task (`mugger`) — I did not re-open these

Everything below is **[researcher]**, all checked **2026-10-07**. Full citations,
including the operator/commercial-vs-official caveats the researcher attached to each,
live in `research/*.md`; this is the index of what the plan actually leans on.

**Entry & documents** — `research/entry-and-logistics.md`
- Vietnam Government Portal visa-exemption list, row 44 (Singapore): passport valid
  ≥ 6 months + onward/return ticket as conditions of the visa-free entry.
  `https://vietnam.gov.vn/visa-exemption-68946`
- The 45-day unilateral exemption does **not** cover Singapore (Singapore is on the
  separate 1997/2003 bilateral, 30 days).
- e-visa (only if a traveller is NOT on a Singapore passport): 90 days, US$25 single /
  US$50 multiple, official portals `https://evisa.gov.vn` and
  `https://thithucdientu.gov.vn` only. Fee corroborated via third parties, **not** read
  off the official portal.
- Medication limits commonly quoted (30 days ordinary / 7 days narcotic-class / 10 days
  psychotropic) come from **commercial** sites; the researcher could not open an official
  Vietnamese customs page stating them. Used in `packing.json` with that caveat attached.
- CDC Vietnam pages for vaccine recommendations (Hep A/B, typhoid; **consider** JE and
  rabies for rural riding/homestays). `https://wwwnc.cdc.gov/travel/destinations/traveler/none/vietnam`

**Weather** — `research/weather.md`
- Hanoi December 15–23 °C days / 12–16 °C nights, misty, one of the driest months
  (Vietnam Airlines travel guide, `vietnam.travel`, Weatherspark).
- Ninh Binh 16–22 °C, low rain, valley mist at dawn (tnktravel, vietnamtravel, AccuWeather).
- Ha Giang: December is the dry end of the year, roads dry, but the 1,000–1,400 m passes
  are cold with morning fog risk and operators advise starting mid-morning — **operator
  blogs, treated as guidance**.
- Excluded on weather: Sapa/Fansipan (~7 °C days, fog, frost, mud) and Ha Long/Cat Ba
  (fog, cold, cancellation risk); Cao Bang/Ban Gioc too far and the waterfall is at
  dry-season low.

**Regions & routing logic** — `research/regions.md`
- The reason Ninh Binh sits **after** Ha Giang (recovery day; and reversing the order
  ends the trip on the hardest transit) is the researcher's argument, and I adopted it.
- Ha Giang 3-day/2-night as the standard minimum; 4D/3N adds Dữ Già.

**Transport & the motorbike trap** — `research/transport.md`
- SIN–HAN carriers and fare bands (ShopBack SG, Scoot's own route page).
- Noi Bai → Old Quarter options and fares (Bus 86 45,000–50,000 VND; Grab 200,000–380,000;
  the 3 Aug 2026 car-park pickup change; the tout warning).
- Hanoi → Ha Giang: sleeper bus 7–8 h / 250,000–400,000 VND; limousine van 6–7 h /
  350,000–450,000 VND; private car 3,800,000–5,500,000 VND. Named operators.
- Hanoi ↔ Ninh Binh: train 95,000–150,000 VND / 2 h 20 m; limousine van 200,000–350,000 VND;
  the Giap Bat → Yên Sở terminal move.
- **The IDP finding the brief flagged**: AA Singapore issues **1949**-Convention IDPs and
  says on its own site that *"China, Myanmar and Vietnam do not recognise this
  international driving licence"* (`https://aas.com.sg/idp-carnet/`), while Vietnam's
  statutory route is the **1968** Convention. The US Embassy in Hanoi goes further:
  foreign licences, "even when accompanied by an international driving permit, are not
  valid in Vietnam" (`https://vn.usembassy.gov/driving-in-vietnam/`). Conclusion used in
  the plan: **self-riding > 50 cc is not legal and would not be insurable → easy rider.**
  The insurance consequence is the researcher's **reasoned conclusion**, not a quoted
  policy term — no policy wording was opened.
- Ha Giang border-area permit: operators advise a ~US$10 permit from 1 Jun 2026, but
  Time Out could not find an official government notice behind it
  (`https://www.timeout.com/asia/news/...-061426`). Treated as **operator guidance**.
  Used as a "ask the operator in writing" action in `packing.json` and day 3.
- Ha Giang tour prices: 3D/2N easy rider "from US$206" (GetYourGuide listing — the page
  403s to an automated fetch), 4D/3N US$200–250, 2D/1N 3,200,000 VND, 5D/4N
  Ha Giang+Cao Bang 7,800,000 VND. Easy-rider tip 200,000–300,000 VND/day.
- Grab coverage: good in Hanoi, patchy around Tam Coc, **inferred** to be unreliable in
  Ha Giang province (not sourced).

**Accommodation** — `research/accommodation.md`, `data/accommodation.json`
- Every shortlisted property, its area and its "typical" nightly rate, plus the
  booking-urgency argument (24, 25 and 31 Dec in Hanoi is the tightest window of the
  Vietnamese year; Nov–Dec runs 30–50 % above low season). **All rates are 2026 guide /
  aggregator figures, not quotes for these dates.**
- `data/accommodation.json` (23 entries) is the researcher's file. The `acc-0xx` ids the
  itinerary's `lodging` field cites are **its** ids, unchanged.

**Costs** — `research/costs.md`
- Street-food, beer, entrance-fee, boat and transport price bands; the three daily spend
  tiers (frugal 400,000 / comfortable 750,000 / splurge 1,500,000 VND).
- The researcher's own trip-level estimate (~S$1,039–1,089 per person excluding flights)
  and its arithmetic. I rebuilt it (see §6) rather than inherit it, and the differences
  are explained there.

**Food & experiences** — `research/food-and-experiences.md`, `data/recommendations.json`
- Michelin Guide Hanoi pages for the named restaurants (`guide.michelin.com`); Train
  Street's current access rules; the "no reliably-sourced named restaurants in Ha Giang
  province" finding, and the honest gaps (no sourced cooking class, massage or food-tour
  price; no second named Ninh Binh venue).

---

## 3. What could NOT be verified — by either of us — and how the plan handles it

| Gap | How the plan handles it |
|---|---|
| **Live SIN–HAN fares for 24 Dec 2026 – 2 Jan 2027** — no booking engine was opened, and the brief forbids booking. | `expenses.json` carries the flight as a **text range, not a number** (S$450–700 per person), so it cannot silently inflate the figure the app tracks against S$1,500. Day 1 says plainly it is not booked and gives the booking deadline. This is the single largest uncertainty in the plan. |
| **Live hotel rates and availability for the actual nights** | Every hotel figure is labelled a guide "typical". `expenses.json.basis.peak_season_sensitivity` quantifies the risk: +30–50 % on rooms moves the total to ~S$1,042–1,085, still ≥ S$415 inside the cap. |
| **A forecast for the trip window** | None exists (see §1). Packing is built on climatological normals and says so. |
| **The Ha Giang border permit — law or operator practice?** | Booked as an explicit written question to the operator with a re-check 1 week out (day 3, `packing.json`). |
| **Medication day-limits on an official Vietnamese customs page; the cash declaration threshold** | `packing.json` cites the commonly-quoted limits with the caveat, and routes the traveller to the doctor and the Vietnamese embassy in Singapore, red channel on arrival. Cash: declare rather than risk it. |
| **Temple of Literature fee; Hang Mua fee (3 conflicting figures); Hoa Lo Prison fee (2 figures)** | Budgeted at the high end (Hang Mua 150,000; Hoa Lo 50,000) or as a labelled assumption (Temple 50,000). Every one is flagged in its `expenses.json` note. |
| **A travel insurance quote** | S$50 per person is a **labelled assumption**. Also an action: get the policy to state in writing what it covers for a pillion passenger. |
| **Hanoi cooking-class, massage and food-tour prices** | Massage (S$30) and the street-food tour (S$20) are **labelled assumptions**; the cooking class is not in the plan. |
| **Whether the "≤ 50 cc needs no licence" rule is real** | Unverified, and irrelevant to this plan because it rides pillion. Explicitly not relied on. |
| **Vietnam's current motorcycle licence class thresholds** (A1 to 125 cc or 175 cc — sources disagree after the 2025 road-traffic law) | Not relied on; the plan avoids the question by not self-riding. |
| **Named restaurants in Ha Giang province; a second named Ninh Binh venue; a specific Tam Coc café** | Not invented. The itinerary says to eat at markets and homestays, and to ask the homestay in Ninh Binh. |
| **St Joseph's Cathedral Christmas 2026 Mass times** | Not in the plan; no source found. |
| **Grab coverage in Ha Giang province** | Marked as an inference, and the plan assumes cash. |
| **SIM/eSIM price; ATM withdrawal fees** | Both labelled unsourced estimates in `expenses.json`. |
| **Whether Tam Coc's pools are heated** | Not assumed; the plan only says hot water matters. |

---

## 4. My judgement calls (no source — the planning decisions I own)

1. **Three bases, in this order: Hanoi → Ha Giang → Ninh Binh → Hanoi.** Two bases would
   be cleaner and dropping Ninh Binh is the obvious way to remove the one hard day, but
   Ninh Binh has the best weather of the three and the best photographs in the window,
   and putting it last means the trip ends on a 2-hour hop into NYE rather than on a
   10-hour transit. Rejected alternatives and their reasons: Sapa/Fansipan (weather),
   Ha Long/Cat Ba (fog and cancellation risk), Cao Bang (4–5 days minimum, dry waterfall),
   Mai Châu/Pu Luong (less drama per day).
2. **Hanoi round 1 is ONE night (24–25 Dec), not two.** The 25th is spent on the 21:00
   sleeper bus, so paying for a second Hanoi night would be paying for a bed nobody
   sleeps in. This is a **correction to the research's accommodation table** (which
   assumed 24–26 Dec) and it saves ~S$59 per person. The trade-off — no hotel room to
   nap in before the night bus — is stated on day 2, together with the alternative
   (2 Hanoi nights + a daytime van on the 26th, at the cost of one Tam Coc night).
   **Knock-on effect I am NOT papering over — now FIXED (2026-10-07):** `data/accommodation.json`
   (the researcher's file, `acc-001`–`acc-008`) carried `checkin 2026-12-24 / checkout
   2026-12-26` and `nights: 2` for the round-1 Hanoi shortlist, so the **Stay tab showed 2
   nights for the 24th–26th while the plan and the budget use 1 night (24th–25th)**. I
   flagged the mismatch rather than fixing it while the file was the researcher's. It is now
   my file to reconcile and I have: all eight entries carry `nights: 1` and `checkout
   2026-12-25`, each with a one-line note saying why, and **nothing else about them changed**
   — same prices, areas, links, statuses and sources. `acc-009` (the NYE night) and `acc-010`
   (Tam Coc) were already correct for this plan.
3. **The loop is 3 days / 2 nights, not 4.** A fourth riding day only fits by giving up
   a Ninh Binh night, and Ninh Binh is the trip's best-weather photography base.
4. **No multi-day trek is planned**, so the packing list is a walking-and-riding list,
   not an expedition list. The trip's "trekking/homestays" interest is served by the two
   village homestay nights and the loop's walking stops, not by a trek; the genuine
   trekking destination (Sapa) is the one the weather rules out.
5. **The 29 Dec transit day (~10 h) is accepted** rather than converted into an overnight
   bus, because a hot shower and a real bed after three days on a bike is worth half a
   day. The alternative is written into day 6 so the decision is visible, not buried.
6. **Day costs are per person and include that night's share of the room.** Trip-level
   items (insurance, eSIM, buffer, laundry) are not attributed to a day.

---

## 5. Deliberate shape differences from the brief / the app contract

The brief's schemas and the actual app (`app.js`, 1511 lines, read 2026-10-07) disagree in
four places. **The app is the consumer, so the app wins where they conflict — and the
brief's fields are carried alongside wherever they can be.** None of this changes the
plan; it is recorded so nobody has to reverse-engineer it.

1. **Money is SGD throughout, not VND per item.** The app renders the itinerary's day and
   item costs with a single currency, taken from `expenses.currency` (falling back to
   `trip.currency`) — so a VND item cost would have been printed with an "SGD" prefix.
   The brief's `"currency":"VND"` on items is therefore honoured as **`"SGD"`, with the
   VND basis in the `notes`** and the FX rate recorded in `trip.json.notes` and here.
2. **`transit` is a string, not an object** — `app.js` reads `transit`/`transport` with
   `firstString()`, which returns `''` for an object, so an object would render *nothing*.
   The brief's `{from,to,mode,duration}` is kept verbatim in an adjacent
   **`transit_detail`** object, and the human-readable string carries the same facts.
3. **`expenses.json` uses the app's wrapper `{currency, planned, actuals}`**, with the
   brief's row fields (`description`, `paid_by`, `status`, per-row `currency`,
   `date:"plan"`) on every row. The app reads the row label from `description` directly,
   and `Export` writes this wrapper back out, so this is the shape that round-trips.
   `actuals` is present and empty for the same reason.
4. **The international-flight rows have a text amount, not a number.** `app.js` shows a
   non-numeric amount as written and **excludes it from the sums** (its own documented
   behaviour), which is exactly what "include the flight estimate separately so the
   excl.-flights budget stays comparable" needs. A machine-readable
   `amount_estimate_sgd_point` / `_low` / `_high` accompanies each row.
5. **Both `day_cost` (what the app reads) and `day_cost_estimate` (what the brief asks
   for) are set** to the same value on every day, and `lodging` carries the `acc-0xx` id
   *plus* the property name, because the app prints `lodging` as plain text.
6. **`packing.json` carries two extra top-level keys** the app ignores — `basis` (the
   weather window, the activities and the real baggage allowance the list is derived
   from) and the per-item `buy` flags the README documents for "buy or arrange before
   departure". Ten items are flagged; the IDP is deliberately flagged **false**, because
   the correct action is *not* to buy one.
7. **`data/decisions.json` is a new file** (2026-10-07), the source of truth for every open
   choice. It is an array of decision objects with exactly these keys: `id`, `title`,
   `question`, `primary_option_id`, `status`, `decided_by`, `options`. Each option has
   exactly: `id`, `label`, `summary`, `changes`, `cost_delta_sgd`, `booking_impact`,
   `tradeoffs`, `sources`. `cost_delta_sgd` is a signed difference **against that decision's
   own primary**, which is therefore always `0`; the alternatives are what the plan is not
   spending (or is). `status` is `open` on all of them — they are propositions the two of
   you flip, not states the app mutates. **`app.js`'s `FILES` list does not include it yet**
   — the UI that renders it is separate work — so until that lands the file is inert:
   nothing in the app reads it, and every headline number in the other files already
   reflects the primaries. Section 7 lists what each primary rests on.

---

## 6. The arithmetic (per person, SGD, on the ground)

| Category | SGD | Where |
|---|---|---|
| Accommodation | **213** | 1 night Hanoi 24–25 Dec (59) + 2 homestay nights inside the tour (0) + 1 night Ha Giang city 28–29 Dec (26) + 2 nights Tam Coc 29–31 Dec (58) + 1 NYE night 31 Dec (70) |
| Activities (incl. the loop tour) | **397** | 3D/2N easy-rider tour US$210 = 269 + easy-rider tip 37 + food tour 20 + Trang An 12 + Hang Mua 7 + Tam Coc boat+tip 11 + bicycle 2 + Hoa Lò 2 + Temple 2 + massage 30 + market 5 |
| Food & drink | **169** | Hanoi 24–25 Dec 43 + loop 26–28 Dec 25 (meals are inside the tour) + transit/Tam Coc 29–30 Dec 59 + NYE/departure 31 Dec–1 Jan 42 |
| Transport | **97** | airport transfers 14 + sleeper bus 17 + Ha Giang→Hanoi van 22 + Hanoi→Tam Coc van 17 + Tam Coc→Hanoi train 7 + local Grab 20 |
| Misc (incl. health & prep) | **102** | insurance 50 + eSIM 15 + buffer/tips/ATM 25 + laundry 5 + NYE extras 7 |
| **Total on the ground** | **978** | |
| **Budget cap (excl. international flights)** | **1500** | per the brief |
| **Headroom** | **522** | deliberately kept: peak-season rooms, a splurge dinner, shopping, a nicer room |

Cross-checks that the files actually hold up (recomputed by script, not by eye):
- the itinerary's nine `day_cost` values sum to **883**, and adding the four trip-level
  rows (insurance 50 + eSIM 15 + buffer 25 + laundry 5 = 95) gives **978** — matching the
  sum of the numeric rows in `expenses.json` exactly;
- on every day, the sum of the item costs equals that day's `day_cost`;
- the one non-numeric amount in `expenses.json` (`exp-fl1`, the international flight) is
  correctly excluded from the total;
- every `acc-0xx` id cited by the itinerary exists in `data/accommodation.json`.

The researcher's own estimate was ~S$1,039–1,089 per person. Mine is **S$978** and the
difference is explainable, not hand-waving: −S$59 (one Hanoi night instead of two, §4.2),
−S$19 (a 3D/2N tour instead of their 4D/3N at US$225), −S$53 (food re-modelled at five
paid days plus three loop days whose meals are inside the tour, rather than 8 days at the
full rate), +S$20 (the guided street-food tour), and the rest is rounding. I did **not**
include a foreign-transaction or card-fee line, because no fee schedule was sourced.

**What the headroom could buy instead**, if you'd rather spend it than keep it: a second
Hanoi night for a slower finish, the 4-day loop with Dữ Già, La Siesta-class rooms
throughout, or private-car transfers on the two long legs (~+S$75–100 per person each).
All four are now priced options rather than prose — see §7.

---

## 7. The decisions: every open choice, its primary, and what the primary rests on

Decided **2026-10-07**. All of it lives in `data/decisions.json` (contract in §5.7). The
plan, the budget and the Stay tab are committed to the **primary** in each row; every delta
below is per person and signed against that decision's primary, so it can be applied
straight to the S$978.

| # | Decision | Primary — what the plan does | Priced alternatives (`cost_delta_sgd`) | What the primary rests on |
|---|---|---|---|---|
| 1 | **Budget reading** (`dec-budget`) | S$1,500 is on-the-ground; the SIN–HAN fare sits outside it; **Ninh Binh stays** | Fly home on 31 Dec and drop the NYE night, to fit a S$580 fare inside the cap (**−154**) | §6: S$978 against S$1,500. The fare is unquoted, so the cap's reading is the brief's own. Swapping Ninh Binh's S$58 of rooms for Hanoi's S$102–118 is *not* a saving |
| 2 | **Dates** (`dec-dates`) | 24 Dec (Thu) → 1 Jan (Fri) | Shift to 26 Dec → 3 Jan (**0** on the ground) | §1.8 weekdays; the fare bands in §2. The shifted window's saving is unmeasured, and NYE lands on a travelling day |
| 3 | **NYE base** (`dec-nye`) | Hanoi Old Quarter; fireworks over Hoàn Kiếm | Tam Coc for the night and a 1 Jan run to the airport (**−31**); an Old Quarter fallback hotel (**−19**) | The Hanoi NYE sourcing and the old-quarter scarcity argument; acc-009 booked first |
| 4 | **Loop start** (`dec-loop-start`) | Ride out the same day off the 04:30–06:00 arrival, one Hanoi night | Two Hanoi nights + a daytime van on the 26th (**+40**); the daytime van on the 25th (**+31**) | The sleeper-bus timetable and the operator's late-morning start advice; the 25th on a bus is a night nobody sleeps in a hotel |
| 5 | **Loop length** (`dec-loop-length`) | 3 days / 2 nights | 4 days / 3 nights, Dữ Già (**−56**) | 3D/2N is the sourced standard minimum; Ninh Binh has the better weather and the better photograph. The 4-day version is *cheaper* because the loop day sits inside the tour price |
| 6 | **29 Dec transit** (`dec-transit-29`) | Keep the Ha Giang reset night **and** do the 10h transit in daylight | Sleeper bus straight through, no reset night (**−26**); private car door-to-door (**+76**) | A hot shower and a real bed after three days on a bike; the mountain road is only worth seeing in daylight (§2) |
| 7 | **Ride** (`dec-ride`) | Easy rider — pillion behind a licensed local | Self-ride (**−202**) | The 1949-vs-1968 IDP finding: a Singapore licence plus a Singapore IDP is not legal for >50cc, so self-ride is uninsurable. Cost is not the reason |
| 8 | **Boats** (`dec-boat`) | Both: Trang An on the 30th, the Tam Coc boat at first light on the 31st | Trang An only (**−11**); Tam Coc only (**−12**) | The sourced bands — Trang An 250,000 VND vs Tam Coc 150,000–200,000 VND plus a tip |
| 9 | **Food** (`dec-food`) | The guided Old Quarter street-food walk on Christmas Day | Eat the same streets unguided (**−15**) | Michelin-listed venues are named and checkable; the S$20 tour fee is an **assumption** — the least-verified line in the plan |
| 10 | **Splurge** (`dec-splurge`) | Keep the S$522 unspent, as peak-season buffer | P'apiu Resort for the post-loop night (**+326**); La Siesta-class rooms throughout (**+46**) | `expenses.basis.peak_season_sensitivity`: a 30–50% Christmas premium is the live risk |
| 11 | **Insurance** (`dec-insurance`) | Mid-range comprehensive, S$50/person | Fly uninsured (**−50**) | MFA's advice, and the pillion question. S$50 is an **assumption**, not a quote — get the pillion wording in writing |

**What committing to the primaries actually changed in the plan files:**
- `data/itinerary.json` — the five items that used to read "DECISION:" or "TRADE-OFF, YOUR
  CALL:" now state the primary and cite the decision id. **No date, cost or `day_cost`
  changed**: the nine day costs still sum to 883.
- `data/expenses.json` — **no row changed value**, and the tracked total is still 978. One
  factual slip was corrected: the acc-014 note read "~S$18/person/night" against a
  375,000 VND *room* rate — it is ~S$18 per room, about **S$9 per person**.
- `data/trip.json` — `notes` now states the primaries. Dates, budget, cap and currency
  untouched.
- `data/accommodation.json` — `acc-001`–`acc-008` reconciled to one night (§4.2), which is
  the change that makes the Stay tab agree with the budget instead of double-counting the
  25th.
- `data/sources.md` — this section, plus §4.2 and §5.7.

The headline numbers are deliberately unchanged: **S$978 per person on the ground, S$1,500
cap, S$522 headroom** — every primary is what the plan already showed. What is new is that
each of them now has a price attached to the alternatives.

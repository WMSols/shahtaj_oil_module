# Delivery Man — Planning & Delivery Milestones

Record of agreed design: one standard Odoo sales order (SO), distributor-planned DM jobs, optional split by quantity, simple van pickup, statuses/notes, GPS, incidents, and outsider drops.

**End-to-end flow:** Confirm SO → assign (or split) DMs → pick to van → drive with status/notes → GPS deliver → if blocked, report & reassign → optional outsider log → planner tools keep the day organized.

**Implementation progress**
- **M1 (done ~19.0.1.1.67+):** Manual assign — one SO → one DM + day/time; Dispatch Orders / Delivery Jobs.
- **M2 + M3 (19.0.1.1.72):** Split one SO across DMs by product qty; each job has `qty_assigned`; pick / Today Load only load that share; job status is per-share (not whole SO).
- **M4 (19.0.1.1.77):** Separate **Stop** (`field_state`) from **Stock** (`state`); notes required for Shop Closed / Could Not Deliver; native DM buttons + distributor filters.
- **M5 (19.0.1.1.77):** Deliver wizard requires real GPS (Use My GPS); no shop-GPS prefill; distance vs max; `gps_verified` on success.

---

### M0 — Agree rules

**What:** One SO only; assign after SO is confirmed; split by quantity; GPS comes later.

**Why:** So everyone shares the same order truth and we don’t build GPS before the main planning works.

**Flow:** Rules locked → build starts on a clear path.

---

### M1 — Manual assign (1 SO → 1 DM)

**What:** Distributor picks a confirmed SO, chooses one DM, day and time → that DM gets one delivery job.

**Why:** Distributor controls who goes where, instead of only auto booker→DM links.

**Flow:** SO confirmed → distributor assigns DM1 for Tuesday 10:00 → DM1 sees that job.

---

### M2 — Split same SO across DMs

**What:** Same SO can have several jobs with product qtys (e.g. 100 Oil → DM1 50 + DM2 50). SO is complete when all delivered qty matches the order.

**Why:** One van may not hold the full order; two DMs can share one customer order.

**Flow:** Distributor splits qty → each DM delivers their share → Odoo SO shows partial, then full when both finish.

---

### M3 — Simple van pickup

**What:** DM opens job(s), sees products and qtys to pick, loads warehouse → van (one or many products).

**Why:** Field work stays simple: take only what was assigned.

**Flow:** DM arrives WH → picks assigned list → stock sits on van ready for shops.

---

### M4 — Statuses + notes

**What:** Job statuses: in transit / not attended / partial / delivered / failed, plus notes (e.g. shop closed).

**Why:** Distributor and DM see the same story; SO still shows real partial/full delivery.

**Flow:** DM updates status/notes after each stop → distributor monitors progress.

**Shipped:** Stock stays on `state`; field story on `field_state` (Not Started / On the Way / Shop Closed / Could Not Deliver / Stop Done). Notes required for closed/failed. Distributor can Reset Stop.

---

### M5 — GPS on deliver

**What:** To confirm stock given to shop, DM must pass GPS check.

**Why:** Proves delivery happened at the shop, not from far away.

**Flow:** DM at shop → GPS OK → confirm deliver qty → job/SO update.

**Shipped:** Deliver wizard “Use My GPS”; no shop prefill; live distance vs max; blocks if too far / missing coords; sets `gps_verified`.

---

### M6 — Incident reports + reassign

**What:** DM reports road block / accident; jobs stay open; distributor can move remaining work to another DM.

**Why:** Problems don’t cancel the customer order; work can continue.

**Flow:** Incident logged → distributor sees it → reassigns leftover qty → next DM continues.

---

### M7 — Outsider one-time drop

**What:** DM logs a shop not in the system (basic name/details + stock given) once, without full shop registration.

**Why:** Rare off-list drops are recorded without heavy master data.

**Flow:** Extra stock given → outsider form → saved for distributor review.

---

### M8 — Planner polish

**What:** Route/booker helpers on planner, Today Load with splits, rights, refresh.

**Why:** Faster daily planning and a smooth DM day view.

**Flow:** Distributor plans from routes/bookers → DMs work Today Load → live updates stay clear.

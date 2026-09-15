# Shahtaj Delivery Man API — Flutter Developer Reference

Technical reference for the **Delivery Man (DM) mobile API** in `shahtaj_oil` (Odoo 19).

This API powers the Flutter delivery man app: login, day session (**On the Way**), office load, free WH↔van transfers, live delivery plan, GPS job deliver / free deliver, and shop outcomes.

Distributor work (assign jobs, invoicing, payments, inventory setup) stays on the Odoo web / portal UI and is **out of scope** for this API.

---

## 1. Base conventions

| Item | Value |
|------|--------|
| Base path | `/api/shahtaj/v1/dm/...` |
| Protocol | Odoo **`json2`** POST (JSON-RPC style body params) |
| Auth | Bearer API key (except login) |
| CORS | `*` |
| Success envelope | `{ "ok": true, "data": { ... } }` |
| Errors | Odoo raises `UserError` / `AccessError` / `AccessDenied` (HTTP / JSON error payload) |

### Auth header (all routes except login)

```http
Authorization: Bearer <api_key>
```

### Who can use it

- User must be in group **Delivery Man** (`shahtaj_oil.group_shahtaj_delivery_man`)
- Account must have `shahtaj_is_delivery_man = True`
- **Rejected:** distributors, administrators, order bookers, public users

### vs Order Booker API

| | Order Booker | Delivery Man |
|--|--------------|--------------|
| Prefix | `/api/shahtaj/v1/...` | `/api/shahtaj/v1/dm/...` |
| Login | `/auth/login` | `/dm/auth/login` |
| User id field | `order_booker_id` | `delivery_man_id` |
| Day concept | Visit tasks / visits | Day **session** + delivery **jobs** |

API keys last **90 days** (same pattern as booker).

---

## 2. Recommended app flow

```
Login
  → Office: load/today + load/pick (and optional van/load)
  → session/depart  → overall "On the Way"
  → plan/today (refresh often for live assigns)
  → For each stop:
        plan/job
        job/deliver (GPS + lines)  OR  shop-closed / failed
        optional: recovery/shop + recovery/collect  (no check-in required)
  → Optional: shops/search + deliver/free
  → Optional: van/return leftover, job/return-undelivered
  → Optional: wallet/get / wallet/collections
  → session/end
```

**Important UX:** **On the Way** is **one day-level session**, not a per-job toggle. Departing syncs open loaded jobs’ `field_state` toward field work.

**Recovery** is independent of GPS check-in: cash against open shop invoices → DM wallet.

---

## 3. Status vocabulary

### Day session (`shahtaj.dm.day.session`)

| `state` | Meaning |
|---------|---------|
| `office` | At office / loading |
| `on_the_way` | Left office (overall) |
| `ended` | Day closed |

### Job stock lifecycle (`state` on delivery job)

| `state` | Meaning |
|---------|---------|
| `not_ready` | Waiting invoice / not ready to pick |
| `ready` | Ready to pick from WH |
| `picked` | Loaded on van |
| `partial` | Partially delivered |
| `delivered` | Fully delivered |
| `returned` | Undelivered returned to WH |

### Job field stop (`field_state`)

| `field_state` | Meaning |
|---------------|---------|
| `pending` | Not started |
| `in_transit` | On the way (after day depart / field work) |
| `not_attended` | Shop closed |
| `failed` | Could not deliver |
| `done` | Stop finished |

---

## 4. Authentication & presence

### `POST /api/shahtaj/v1/dm/auth/login`

No Bearer required.

**Params**

| Param | Type | Required |
|-------|------|----------|
| `database` | string | yes |
| `login` | string | yes |
| `password` | string | yes |

**Success `data`**

```json
{
  "database": "shahtaj_dev19",
  "api_key": "...",
  "expires_in_days": 90,
  "user": {
    "id": 42,
    "delivery_man_id": 42,
    "name": "Ali DM",
    "login": "ali.dm",
    "employee_code": "DM-01",
    "online_status": "online",
    "last_seen_at": "2026-09-08 12:00:00"
  },
  "session": {
    "id": 1,
    "state": "office",
    "date": "2026-09-08",
    "departed_at": false,
    "ended_at": false
  },
  "online_status": "online",
  "last_seen_at": "2026-09-08 12:00:00"
}
```

Store `api_key` securely and send it on every later call.

---

### `POST /api/shahtaj/v1/dm/auth/me`

Bearer required. Refreshes presence and returns user + today’s session.

**Success `data`:** `{ user, session, online_status, last_seen_at }` (same shapes as login).

---

### `POST /api/shahtaj/v1/dm/presence/heartbeat`

Bearer required. Call periodically (e.g. every 1–5 minutes) so distributors see the DM online.

**Success `data`:** presence object (`online_status`, `last_seen_at`, …).

---

## 5. Day session (overall On the Way)

### `POST /api/shahtaj/v1/dm/session/get`

Returns today’s session (creates `office` if missing).

### `POST /api/shahtaj/v1/dm/session/depart`

Mark overall **On the Way** after office load.

| Param | Type | Required |
|-------|------|----------|
| `notes` | string | no |

### `POST /api/shahtaj/v1/dm/session/end`

End the day.

| Param | Type | Required |
|-------|------|----------|
| `notes` | string | no |

---

## 6. Office load (job stock)

### `POST /api/shahtaj/v1/dm/load/today`

Office “Today Load” screen: shops/jobs still open, aggregated `pick_lines`, van/WH totals, session.

**Success `data` (shape)**

```json
{
  "date": "2026-09-08",
  "session": { "id": 1, "state": "office", "departed_at": false, "ended_at": false },
  "shops": [
    {
      "job_id": 10,
      "shop_id": 55,
      "shop_name": "Ali Store",
      "order_name": "SO001",
      "state": "ready",
      "field_state": "pending",
      "scheduled_date": "2026-09-08",
      "lines": [
        {
          "line_id": 100,
          "product_id": 7,
          "name": "Oil 1L",
          "qty_assigned": 10,
          "qty_picked": 0,
          "qty_still": 10,
          "qty_delivered": 0,
          "uom": "Units"
        }
      ]
    }
  ],
  "pick_lines": [
    {
      "product_id": 7,
      "name": "Oil 1L",
      "uom": "Units",
      "qty_still": 10,
      "qty_assigned": 10,
      "qty_picked": 0,
      "qty_on_van": 0,
      "qty_in_warehouse": 50,
      "qty_to_pick": 10
    }
  ],
  "van_qty_total": 0,
  "warehouse_qty_total": 50
}
```

### `POST /api/shahtaj/v1/dm/load/pick`

Collective pick for today (allocates qty across today’s jobs).

| Param | Type | Required |
|-------|------|----------|
| `lines` | `[{ product_id, qty }]` | yes (at least one qty &gt; 0) |

**Success `data`:** `{ jobs_picked, load }` (`load` = refreshed `load/today`).

### `POST /api/shahtaj/v1/dm/job/pick`

Pick stock for **one** job.

| Param | Type | Required |
|-------|------|----------|
| `job_id` | int | yes |
| `lines` | `[{ line_id, qty }]` | yes |

**Success `data`:** `{ job }` (full job detail).

---

## 7. Free van transfers (WH ↔ van)

Independent of assigned jobs — optional extra load / return.

### `POST /api/shahtaj/v1/dm/van/snapshot`

Current van inventory.

```json
{
  "van_location_id": 12,
  "items": [{ "product_id": 7, "name": "Oil 1L", "qty": 5, "uom": "Units" }],
  "qty_total": 5
}
```

### `POST /api/shahtaj/v1/dm/van/products`

Products with warehouse and/or van qty (for free-load UI).

**Success `data`:** `{ products: [{ product_id, name, qty_in_warehouse, qty_on_van, uom }] }`

### `POST /api/shahtaj/v1/dm/van/load`

Free load WH → van.

| Param | Type | Required |
|-------|------|----------|
| `lines` | `[{ product_id, qty }]` | yes |

### `POST /api/shahtaj/v1/dm/van/return`

Free return van → WH.

| Param | Type | Required |
|-------|------|----------|
| `lines` | `[{ product_id, qty }]` | yes |

Both return `{ van: <van_snapshot> }`.

---

## 8. Live plan (assigned stops)

Refresh often — distributor can assign/split jobs while the DM is out.

### `POST /api/shahtaj/v1/dm/plan/today`

**Success `data`**

```json
{
  "date": "2026-09-08",
  "session": { "id": 1, "state": "on_the_way", "departed_at": "...", "ended_at": false },
  "jobs": [
    {
      "job_id": 10,
      "shop_id": 55,
      "shop_name": "Ali Store",
      "shop_address": "...",
      "latitude": 24.86,
      "longitude": 67.00,
      "order_name": "SO001",
      "state": "picked",
      "field_state": "in_transit",
      "scheduled_date": "2026-09-08",
      "qty_on_van": 10,
      "notes": "",
      "gps_verified": false
    }
  ]
}
```

Open jobs are listed before finished ones.

### `POST /api/shahtaj/v1/dm/plan/job`

| Param | Type | Required |
|-------|------|----------|
| `job_id` | int | yes |

**Success `data`:** `{ job }` including `lines` (assigned / picked / delivered / on van).

---

## 9. Field stop actions

### `POST /api/shahtaj/v1/dm/job/notes`

| Param | Required |
|-------|----------|
| `job_id` | yes |
| `notes` | yes (can be empty string) |

### `POST /api/shahtaj/v1/dm/job/shop-closed`

| Param | Required |
|-------|----------|
| `job_id` | yes |
| `notes` | yes (non-empty) |

Sets `field_state` to shop closed / not attended.

### `POST /api/shahtaj/v1/dm/job/failed`

| Param | Required |
|-------|----------|
| `job_id` | yes |
| `notes` | yes (non-empty) |

### `POST /api/shahtaj/v1/dm/job/deliver`

GPS-verified delivery for an **assigned job**.

| Param | Type | Required |
|-------|------|----------|
| `job_id` | int | yes |
| `latitude` | float | yes |
| `longitude` | float | yes |
| `lines` | `[{ line_id, qty }]` | yes (at least one qty &gt; 0) |
| `notes` | string | no |

Uses the **same company GPS min/max range** as order booker check-in (default max **100 m**). Failed GPS is logged server-side and the call errors; show the backend message to the user.

**Success `data`:** `{ distance_m, job }`

### `POST /api/shahtaj/v1/dm/job/return-undelivered`

Return remaining undelivered job stock to warehouse.

| Param | Required |
|-------|----------|
| `job_id` | yes |

---

## 10. Free deliver (any approved shop)

For van stock delivered outside a pre-assigned job (qty + notes + GPS).

### `POST /api/shahtaj/v1/dm/shops/search`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | no |
| `limit` | int | no (default 30) |

**Success `data`**

```json
{
  "shops": [
    {
      "shop_id": 55,
      "name": "Ali Store",
      "address": "...",
      "latitude": 24.86,
      "longitude": 67.00
    }
  ]
}
```

Only **approved** Shahtaj shops.

### `POST /api/shahtaj/v1/dm/deliver/free`

| Param | Type | Required |
|-------|------|----------|
| `shop_id` | int | yes |
| `latitude` | float | yes |
| `longitude` | float | yes |
| `lines` | `[{ product_id, qty }]` | yes |
| `notes` | string | no |

GPS rules same as job deliver. Stock must exist on the DM’s van.

**Success `data`:** `{ distance_m, shop_id, shop_name, notes, van }`

---

## 11. GPS rules (deliver)

- Distance = Haversine between DM GPS and shop `partner_latitude` / `partner_longitude`
- Limits from company settings:
  - `shahtaj_min_shop_distance_m` (default `0`)
  - `shahtaj_max_shop_distance_m` (default `100`)
- Typical failures:
  - too far / too close
  - shop GPS missing
  - user GPS missing / invalid coords
- Every attempt (OK or blocked) is stored in `shahtaj.gps.attempt` (purpose `deliver`)

App should **always surface the server error message**.

---

## 12. Endpoint checklist

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/shahtaj/v1/dm/auth/login` | none | Login → API key |
| POST | `/api/shahtaj/v1/dm/auth/me` | Bearer | Session resume |
| POST | `/api/shahtaj/v1/dm/presence/heartbeat` | Bearer | Keep online |
| POST | `/api/shahtaj/v1/dm/session/get` | Bearer | Today session |
| POST | `/api/shahtaj/v1/dm/session/depart` | Bearer | On the Way |
| POST | `/api/shahtaj/v1/dm/session/end` | Bearer | End day |
| POST | `/api/shahtaj/v1/dm/load/today` | Bearer | Office load snapshot |
| POST | `/api/shahtaj/v1/dm/load/pick` | Bearer | Collective pick |
| POST | `/api/shahtaj/v1/dm/job/pick` | Bearer | Pick one job |
| POST | `/api/shahtaj/v1/dm/van/snapshot` | Bearer | Van stock |
| POST | `/api/shahtaj/v1/dm/van/products` | Bearer | Free-load catalog |
| POST | `/api/shahtaj/v1/dm/van/load` | Bearer | WH → van |
| POST | `/api/shahtaj/v1/dm/van/return` | Bearer | van → WH |
| POST | `/api/shahtaj/v1/dm/plan/today` | Bearer | Live stop list |
| POST | `/api/shahtaj/v1/dm/plan/job` | Bearer | Job detail |
| POST | `/api/shahtaj/v1/dm/job/notes` | Bearer | Update notes |
| POST | `/api/shahtaj/v1/dm/job/shop-closed` | Bearer | Shop closed |
| POST | `/api/shahtaj/v1/dm/job/failed` | Bearer | Could not deliver |
| POST | `/api/shahtaj/v1/dm/job/deliver` | Bearer | GPS deliver job |
| POST | `/api/shahtaj/v1/dm/job/return-undelivered` | Bearer | Return leftover |
| POST | `/api/shahtaj/v1/dm/shops/search` | Bearer | Find shop |
| POST | `/api/shahtaj/v1/dm/deliver/free` | Bearer | Free GPS deliver |
| POST | `/api/shahtaj/v1/dm/recovery/shop` | Bearer | Shop open invoices (Recovery) |
| POST | `/api/shahtaj/v1/dm/recovery/collect` | Bearer | Collect cash → DM wallet |
| POST | `/api/shahtaj/v1/dm/wallet/get` | Bearer | Wallet balance summary |
| POST | `/api/shahtaj/v1/dm/wallet/collections` | Bearer | My wallet collection history |

---

## 13. Recovery / wallet (cash collection)

Recovery is **independent of check-in / GPS deliver**. Put a **Recovery** button on each shop (today plan or shop card). Cash goes into the DM wallet (`DMCASH` / account `101410`). **Settle wallet → bank** stays on distributor web only.

### App flow

```
plan/today (or shop card)
  → Recovery
  → recovery/shop   (open invoices + outstanding)
  → enter amounts (full / partial per invoice)
  → recovery/collect
  → optional wallet/get + wallet/collections
```

### `POST /recovery/shop`

Params:

| Param | Required | Notes |
|-------|----------|--------|
| `shop_id` | **yes** | Shahtaj shop id |

Example response `data`:

```json
{
  "shop_id": 42,
  "shop_name": "Ali Store",
  "shop_category": "credit",
  "outstanding": 15000.0,
  "posted_receivable": 15000.0,
  "effective_outstanding": 18000.0,
  "credit_limit": 50000.0,
  "credit_remaining": 32000.0,
  "invoice_count": 2,
  "invoices": [
    {
      "invoice_id": 101,
      "name": "INV/2026/0001",
      "invoice_date": "2026-09-01",
      "amount_total": 10000.0,
      "amount_residual": 10000.0,
      "payment_state": "not_paid",
      "is_legacy_balance": false
    }
  ],
  "wallet_balance": 2500.0
}
```

### `POST /recovery/collect`

Params:

| Param | Required | Notes |
|-------|----------|--------|
| `shop_id` | **yes** | Shahtaj shop id |
| `allocations` | yes | `[{ "invoice_id": 101, "amount": 5000 }, ...]` |
| `notes` | no | Optional note |

Returns collected amount, payment ids, refreshed `wallet` summary and `shop` recovery payload.

### `POST /wallet/get`

No params. Returns:

```json
{
  "delivery_man_id": 7,
  "currency": "PKR",
  "balance": 2500.0,
  "collected_today": 1000.0,
  "collected_total": 8000.0,
  "settled_total": 5500.0,
  "as_of": "2026-09-15"
}
```

### `POST /wallet/collections`

Params: optional `date_from`, `date_to`, `limit` (default 50, max 200).

Returns `{ collections: [...], count, wallet_balance }`.

---

## 14. Source files (backend)

| Area | Path |
|------|------|
| Auth | `controllers/api/dm_auth.py` |
| Ops routes | `controllers/api/dm_ops.py` |
| Recovery routes | `controllers/api/dm_recovery.py` |
| Helpers | `controllers/api/dm_base.py` |
| Service / payloads | `models/shahtaj_dm_api.py` |
| Recovery accounting | `models/shahtaj_dm_recovery.py` |
| Day session | `models/shahtaj_dm_day_session.py` |
| Jobs / stock | `models/shahtaj_dm_delivery.py` |

---

## 15. Quick test plan

1. Login as a delivery man user → store `api_key` + check `session.state == office`
2. `load/today` → pick some `pick_lines` via `load/pick`
3. Optional `van/load` extra product
4. `session/depart` → `on_the_way`
5. `plan/today` → open `plan/job`
6. Far from shop → `job/deliver` fails with distance error
7. Near shop → `job/deliver` succeeds; job quantities update
8. `shops/search` + `deliver/free` with van stock
9. **Recovery:** `recovery/shop` with `shop_id` → enter amounts → `recovery/collect` → `wallet/get`
10. `session/end`

---

*Module: `shahtaj_oil` · API prefix `/api/shahtaj/v1/dm` · Document aligned with implementation as of module `19.0.1.1.121`*
+
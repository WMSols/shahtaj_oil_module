# Shahtaj — Users, Roles & Access

Reference for who does what, which portals they use, and which custom-portal tabs / features each web user should see.

**Sources:** Client access & work-area matrix + current product (OB / DM apps, distributor custom portal, native Odoo).

**Status legend**
- **Existing** — already in the system (groups / apps / portal).
- **Planned (NEW)** — required by client matrix; not yet separate portal roles.

---

## 1. User summary

| User | Status | Primary interface | One-line job |
|------|--------|-------------------|--------------|
| Order Booker (OB) | Existing | Mobile app | Field visits, take cash/credit orders |
| Delivery Man (DM) | Existing | Mobile app | Load van, deliver, collect, recovery, walk-in |
| Distributor | Existing | Custom portal + native | Full ops + **always** financial; can approve special orders |
| Manager | Existing | Native Odoo (+ custom FE toggle) | Temporary Dist-equivalent access (distinct role); cut gradually later |
| KPO | Existing (phase 1) | Native Odoo (+ custom FE toggle, default OFF) | Distinct role; `kpo_acl` + `native_kpo_ui` (print/wallet + shop trading) |
| Warehouse Incharge | Existing (phase 1) | Native Odoo (+ custom FE toggle, default OFF) | Distinct role; `warehouse_acl` + `native_warehouse_ui` (jobs/load/stock) |

OB and DM are **app users**. The rest are **web portal users** (custom distributor-style UI and/or native Odoo for QA).

---

## 2. End-to-end work flow (client matrix)

```
OB takes order
    │
    ├─ Credit @ app price, within limit ──► (no approval) ──► KPO
    │
    ├─ Cash + discount ──────────────────► Manager / Distributor approve
    │                                              │
    └─ Credit + discount OR over-limit ──► Manager / Distributor approve
                                                   │
                                                   ▼
                                         KPO prints order + summary sheet
                                                   │
                                                   ▼
                                    Warehouse Incharge updates loaded qty
                                                   │
                                                   ▼
                                         DM delivers + collects + recovery
                                                   │
                                                   ▼
                                    KPO validates cash/recovery EOD → posts
                                                   │
                                                   ▼
                                         Distributor finance (P&L, TB, BS)
```

---

## 3. Order Booker (Existing) — app

### Work
- Take **cash orders with discount** → go to Manager/Distributor for review.
- Take **credit orders at app price within limit** → skip approval → KPO.
- Take **credit orders with discount or over limit** → Manager/Distributor review.

### Access
- Own visit tasks, shops (register / verify), orders, targets (current period via API).
- **No** web approval desk, print desk, warehouse load edit, company P&L/TB/BS, DM wallet settle.

### Portals
- **App only** (not the focus of the distributor web portal).
- Native “My Tasks / My Targets” may exist for testing.

---

## 4. Delivery Man (Existing) — app

### Work
- Deliver stock to shop; collect payment; mark delivered.
- Collect previous recoveries; update in app.
- Today plan / load / walk-in (unregistered customer only — not free deliver to registered shops without an order).

### Access
- Own jobs (today scheduled), van stock, wallet/collections, recovery for known shops.
- **No** order approval, print desk, full finance, other users’ staff admin.

### Portals
- **App only**.
- Native Delivery Jobs / Today Load for distributor testing of DM data.

---

## 5. Distributor (Existing) — web

### Work
- Same approval powers as Manager on special orders (review / edit / reject / approve).
- Full operational control and **financial statements** (P&L, Trial Balance, Balance Sheet).
- Staff, territory, targets, invoicing, bank, accounting.

### Custom portal — tabs & sub-tabs (full)

| Main tab | Sub-tabs / areas | Use |
|----------|------------------|-----|
| Dashboard Overview | — | KPIs, alerts |
| Territory & Routes | Zones, Routes, Shops | Master data |
| Warehouse & Stock | Product List, Stock Overview, Sales Taxes | Catalog & stock |
| Operations Tracking | Shop Check-ins/GPS, Live Orders, Bookers Performance, Pending Deliveries | Field + delivery oversight; approvals |
| Financials | Money Overview, Cash Activity, Invoice Management, PO Management, Credit Risk, Tax Ledger, Expenses, P&L | Trading & P&L |
| Schedules & Targets | Weekly Schedules, Performance Targets | OB planning |
| Staff Management | — | Bookers / DMs |
| Accounting | Journals, Trial Balance, Balance Sheet, … | Formal books |
| Bank / Transactions | (as enabled) | Cash/bank |
| Settings | — | Portal settings |

### Buttons / features
- Approve / Edit / Reject special orders.
- Assign DM, dispatch oversight, invoices, payments, settle DM wallet.
- Create staff, zones, routes, shops, targets.
- Full P&L / TB / BS.

### Native (live)
- All Shahtaj menus via UI packs on `group_shahtaj_native_distributor_ui`.
- Financial access is **always ON** for Distributor (ops-only Dist removed).
- Custom Portal toggle still chooses OWL portal vs native backend.
- Shared ops ACLs live on technical `group_shahtaj_office_ops` (implied by Dist + Manager).

---

## 6. Manager (Existing — temporary Dist mirror) — web

**Policy (current):** Manager is a **distinct** privilege role (`group_shahtaj_manager`), **not** Distributor. For now it gets **Dist-equivalent** model ACL, financial ACL, native apps, and native Shahtaj menus so native testing works (orders, `invoice_lines` / journal items, create OB/DM, etc.). Cut packs/menus/ACL **gradually** later (target: Dist ⊇ Manager ⊇ KPO).

### Work
- Same day-to-day native ops as Distributor while mirror is on: orders (create/edit/approve/reject), shops, staff create, DM ops, accounting screens, OB MIS.
- Review / edit / reject / approve special field orders (via `group_shahtaj_order_approver`).

### Security
- Role group: `group_shahtaj_manager` (implies `order_approver`, `office_ops`, `distributor_financial`, `distributor_native_apps`).
- Native menus: sync assigns `group_shahtaj_native_manager_ui` (OB/DM/catalog/field reports/staff + **`ui_pack_shop_trading`**).
- **Shop Accounting (native):** only **Step 2 — Billing & Returns** and **Step 3 — Shop balances** (hub + sidebar). Hidden for Manager: Step 1/4, bank/journals, tax, P&L/TB/BS.
- Dist keeps full finance via `ui_pack_finance` on `native_distributor_ui`.
- Custom frontend toggle: same as Dist (hidden for OB/DM). Leave OFF until Manager portal tabs exist.
- Dist stays Dist: Manager never receives `group_shahtaj_distributor`.

### Access rights (read / write) — temporary full mirror

| Area | Read | Write / create | Notes |
|------|:----:|:--------------:|-------|
| Field sales orders / lines | Yes | Yes | Includes `invoice_lines` → `account.move.line` via financial ACL |
| Invoices / payments / journals / P&L / TB / BS | Yes | As Dist financial | Temporary; cut statements later if desired |
| Shops + credit limit fields | Yes | Yes | `office_ops` + `order_approver` on credit field groups |
| Zones / routes / schedules / visits / targets / field reports | Yes | Yes | `office_ops` |
| Create / manage OB & DM | Yes | Yes | Staff admin pack + Python office_ops checks |
| DM dispatch / van / wallet | Yes | Yes | Temporary mirror |
| Products / inventory / native Sales apps | Yes | Via native_apps | Temporary mirror |

Technical: prefer trimming Manager **implied** packs/groups later rather than duplicating ACL rows.

### Custom portal — should see (planned later)

| Main tab | Sub-tabs | Purpose |
|----------|----------|---------|
| Dashboard Overview | Ops KPIs (pending approvals, booker stats) | Day start |
| Territory & Routes | Zones, Routes, Shops | Field structure |
| Operations Tracking | Check-ins/GPS, Live Orders, **Bookers Performance**, Pending Deliveries, **Approvals / verification** | Core job |
| Schedules & Targets | Schedules, Targets | Planning & MIS |
| Staff Management | View (create optional) | Booker oversight |

### Custom portal — hide
- Full Financials: P&L, PO Management, Tax Ledger, Expenses (unless dual-role Distributor).
- Accounting: Trial Balance, Balance Sheet.
- Product cost / deep inventory valuation if Dist-only.
- KPO print batch, Warehouse load-qty edit, DM wallet settle (unless needed).

### Buttons on shared tabs
- **Orders:** Approve, Edit, Reject — **show**.
- Print summary / Post EOD cash — **hide**.
- Update loaded qty — **hide**.

### Native (live — Shop Accounting cut started)
- Most Shahtaj native menus still mirrored (OB/DM/catalog/staff).
- **Shop Accounting:** Manager sees Billing & Returns + Shop balances only; Dist still sees full hub (Steps 1–4, purchase, statements) + P&L menu.
- Approve / Reject and order edit still available (ACL unchanged for now).

---

## 7. KPO — web

**Policy (current):** KPO is a **distinct** privilege role (`group_shahtaj_kpo`), **not** Distributor/Manager.

- Role group: `group_shahtaj_kpo` implies **only** `base.group_user` + **`group_shahtaj_kpo_acl`** (no `office_ops` / `distributor_financial` / `native_apps` / `order_approver`). Dist ACL CSV rows are untouched.
- **`group_shahtaj_kpo_acl`:** narrow `ir.model.access` for KPO workflow — sale orders/lines read, partners/products/users read, invoices/payments/journals/accounts/reconcile read, wallet settle wizard RW, settlements/collections read, accounting hub, UoM read.
- Native menus: `group_shahtaj_native_kpo_ui` → **`ui_pack_kpo`** + **`ui_pack_shop_trading`** only.
- **5. KPO Operations:** Orders to Print, DM Wallet Collections / Settle / Settlements.
- **8. Shop Accounting:** Billing & balances (via shop_trading) — ledgers/payments **view**.
- **Print** button on sale order form/list (standard Quotation/Order PDF) — KPO group only.
- Custom FE toggle: same as Dist/Manager.
- Hidden for KPO: OB ops, DM dispatch/staff, catalog, finance statements, Approve/Reject, Assign DM / Mark Delivery; no Dist native Sales/Inventory/Accounting apps.

### What KPO can do with `kpo_acl` (current)
- Open and **print** sale orders (read-only; stock picking fields via sudo/read ACL).
- View DM wallet **collections**, run **wallet settle** (EOD), **view** settlements (no cancel/edit).
- Python gates `_assert_can_settle` / `_assert_can_collect` allow KPO.
- View shop invoices, payments, and balances (**read-only** UI + ACL).
- Open accounting hub for shop trading context.

### What KPO cannot do
- Approve/Reject orders; Assign DM / Mark Delivery; Approve/Reject shops.
- Create/edit invoices, payments, products, stock, shops, schedules, staff.
- Cancel or edit posted wallet settlements (settle wizard posts only).
- P&L / Trial Balance / Balance Sheet / manufacturer summary.
- Dist portal native apps (Sales/Inventory/Purchase manager packs).

### Work (client target)
- Receive approved orders (and within-limit credit that skipped approval).
- **Print** all orders + **summary sheet**; hand to Warehouse.
- Receive DM cash & recovery data; **EOD validate** in app/portal; **post**.
- Access **customer ledgers** (and related) for validation.

### Custom portal — should see (target after cut)

| Main tab | Sub-tabs | Purpose |
|----------|----------|---------|
| Dashboard Overview | Print queue / cash-to-validate KPIs | Desk |
| Operations → Live Orders (or **Print desk**) | Ready-to-print list | Print order + summary |
| Financials (narrow) | Cash Activity, Payments, **Customer balances / ledgers**, related invoices | EOD + ledgers |
| Pending Deliveries | Optional read-only status | Context |

### Custom portal — hide (target)
- Territory admin, Staff create, Schedules/Targets edit.
- Check-ins / Bookers Performance (Manager MIS).
- P&L, Trial Balance, Balance Sheet, PO Management, credit-limit setup.
- Approve / Reject order buttons.
- Warehouse load-qty edit.

### Buttons / features (target)
- **Print order**, **Print summary sheet**.
- EOD: **Validate** recoveries & payments → **Post**.
- Open **customer ledger**.

### Native (live)
- `native_kpo_ui`: KPO desk menus + Shop Accounting (trading). Print button on orders (std sale PDF).
- No dedicated print-desk domain / summary sheet / EOD workflow yet (reuse wallet settle screens).
- Use Custom Frontend toggle available (portal tabs still Dist shell until filtered).

---

## 8. Warehouse Incharge — web

**Policy (current):** Warehouse Incharge is a **distinct** privilege role (`group_shahtaj_warehouse`), **not** Distributor/Manager/KPO.

- Role group: `group_shahtaj_warehouse` implies **only** `base.group_user` + **`group_shahtaj_warehouse_acl`** (no `office_ops` / `distributor_financial` / `native_apps` / `order_approver` / `kpo_acl`). Dist and KPO ACL CSV rows are untouched.
- **`group_shahtaj_warehouse_acl`:** narrow `ir.model.access` for load desk — DM deliveries/lines RW, Today Load + Van Transfer wizards RW, products/partners/users/orders read, stock quant/locations/warehouses/pickings read.
- Native menus: `group_shahtaj_native_warehouse_ui` → **`ui_pack_warehouse`** only.
- **5b. Warehouse Operations:** Delivery Men, Delivery Jobs, All Delivery Orders, Stock Overview, Product List.
- Open **Today Load** / **Van Stock Procedure** from a Delivery Man form (Python gates allow Warehouse like Dist office_ops).
- Custom FE toggle: same as Dist/Manager/KPO (**default OFF** → native desk).
- Hidden: OB ops, KPO wallet/print, Shop Accounting, finance statements, Approve/Reject, staff create; no Dist native Sales/Inventory/Accounting apps.

### What Warehouse can do with `warehouse_acl` (current)
- List Delivery Men and open **Today Load** / **Van Stock Procedure** for any DM.
- View and update **Delivery Jobs** (load / pick workflow).
- View **Stock Overview** and **Product List** (read-only catalog).

### What Warehouse cannot do
- Approve/Reject orders or shops; Assign DM (dispatch beyond load); wallet settle / print desk.
- Create/edit invoices, payments, products, shops, schedules, staff.
- P&L / Trial Balance / Balance Sheet / manufacturer summary / Add Stock wizard.
- Dist portal native apps (Sales/Inventory/Purchase manager packs).

### Work (client target)
- Update **actual quantity loaded** into the delivery vehicle (in portal/app).
- Delivery-related **reports / MIS** (client: Warehouse Incharge = Manager for **delivery** MIS).

### Custom portal — should see (target after cut)

| Main tab | Sub-tabs | Purpose |
|----------|----------|---------|
| Dashboard Overview | Load / dispatch KPIs | Day start |
| Warehouse & Stock | Stock Overview (+ load/dispatch) | Stock truth |
| Operations → Pending Deliveries / Dispatch | Jobs to load | **Update loaded qty** |
| Delivery reports / MIS | Delivery performance | Same idea as Manager’s delivery MIS |

### Custom portal — hide
- Order Approve / Reject.
- Print / Post cash.
- Financials P&L/TB/BS, Accounting.
- Check-ins, Bookers Performance, Schedules/Targets, Staff.
- Product price/cost admin if Dist-only.

### Buttons / features
- **Update / confirm loaded quantity** per order or job.
- Mark ready for DM today load (if used).
- View delivery MIS.

### Native (live)
- `native_warehouse_ui`: Warehouse desk menus only. Today Load / van via DM form.
- Use Custom Frontend toggle available (default OFF; portal tabs still Dist shell until filtered).

---

## 9. Same tab — feature visibility matrix (web)

Prefer **shared screens** with role-based hidden buttons.

| Feature on shared Orders / Ops screens | Distributor | Manager | KPO | Warehouse |
|----------------------------------------|:-----------:|:-------:|:---:|:---------:|
| Approve / Reject (discount / over-limit) | Yes | Yes | No | No |
| Print order + summary | Yes* | No | Yes | No |
| Update loaded qty | Yes* | No | No | Yes |
| Check-ins / GPS timeline | Yes | Yes | No / view | No |
| Bookers Performance (OB MIS) | Yes | Yes | No | No |
| Delivery MIS | Yes | Optional | No | Yes |
| Customer ledger | Yes | Optional | Yes | No |
| P&L / Trial Balance / Balance Sheet | Yes | Yes* | No | No |
| Staff / Targets / Territory admin | Yes | Yes* | No | No |

\*Manager currently mirrors Dist (temporary). Cut statements / staff create later when hierarchy Dist ⊇ Manager ⊇ KPO is enforced in UI.

\*Distributor may perform any step; day-to-day print = KPO, load qty = Warehouse.

---

## 10. Suggested custom portal menu by web user

### Distributor
All current tabs (Overview, Territory, Warehouse, Operations, Financials, Schedules & Targets, Staff, Accounting, Bank, Settings).

### Manager
Overview · Territory · Operations (check-ins, orders, performance, deliveries, **approvals**) · Schedules & Targets · Staff (light).

### KPO
Overview (print/cash KPIs) · Operations → Orders (**print desk**) · Financials → Cash + Ledgers/Balances + Payments · (no Accounting statements).

### Warehouse Incharge
Overview (load KPIs) · Warehouse/Stock · Operations → Deliveries / **load qty** · Delivery reports.

---

## 11. Reporting access (client matrix)

| Report / data area | Who |
|--------------------|-----|
| All Order Booker reports / MIS | Manager (+ Distributor) |
| All Delivery reports / MIS | Warehouse Incharge (= Manager for delivery MIS) (+ Distributor) |
| Customer ledgers | KPO (+ Distributor) |
| P&L, Trial Balance, Balance Sheet | Distributor |

---

## 12. Implementation notes

1. **Existing today:** OB, DM, Distributor (financial **always ON**), **Manager** (distinct; Dist-equivalent ACL + `native_manager_ui`), **KPO** (distinct; narrow `native_kpo_ui` = kpo desk + shop_trading; `kpo_acl`), **Warehouse Incharge** (distinct; `native_warehouse_ui` = warehouse desk; `warehouse_acl`).
2. **Native UI pattern:** menus gated by **UI packs** (`group_shahtaj_ui_pack_*`). Role → packs via `native_distributor_ui` / `native_manager_ui` / `native_kpo_ui` / `native_warehouse_ui`. Approval buttons use `group_shahtaj_order_approver`.
3. **Still to add:** gradual Manager cut; KPO print-desk domain + summary sheet; custom portal tab filters; ACL csv cuts when menus stable.
4. **Do not** give OB/DM the distributor custom portal as their primary UI.
5. Registered-shop delivery without an order: DM asks Distributor to create/assign order — **not** free shop search. Unregistered: **walk-in** only.

---

## 13. Quick reference — who uses which interface

| Interface | Users |
|-----------|--------|
| OB mobile app | Order Booker |
| DM mobile app | Delivery Man |
| Custom web portal | Distributor, Manager, KPO, Warehouse Incharge |
| Native Odoo (QA / power) | Same web users; Dist full; others limited menus |

---

*Document maintained for product & access design. Update when new groups or portal tabs ship.*

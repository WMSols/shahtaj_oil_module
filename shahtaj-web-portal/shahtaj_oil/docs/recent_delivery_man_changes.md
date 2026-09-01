# Delivery Man Operations — Recent Changes, Accounting Flow & Next Steps

This document serves as a complete reference for the recent Delivery Man (DM) operational and accounting enhancements in Shahtaj Oil (Odoo 19).

---

## 1. What Has Been Done (Completed)

### A. Accounting & Self-Healing Setup
* **Dedicated Current Asset Accounts**:
  * **`101410 Cash with Delivery Men (DM Wallet)`**: Current Assets, `reconcile=True`. Holds physical cash collected by DMs on the road until deposited into the bank.
  * **`110200 Van Stock (Goods in Transit)`**: Current Assets, `reconcile=False`. Linked as valuation account on `Delivery Vans` transit location (`usage='transit'`).
  * **`DMCASH DM Cash Collections Journal`**: Cash journal configured with `101410` as its default debit/credit payment account.
* **Modular Self-Healing Runner**:
  * Centralized setup code in `shahtaj_oil/setup/` (`accounting_setup.py`, `access_rights_setup.py`, `product_setup.py`, `runner.py`).
  * Automatically provisions missing accounts/journals during module install (`post_init_hook`) and upgrades (`post-migrate.py` + XML hook).

### B. Dynamic Assignment & Decoupling from Order Booker
* **Removed Legacy Booker-DM Hardcoding**:
  * Orders created directly by Distributors (or Order Bookers) now sync immediately upon invoice confirmation.
  * Removed the restriction requiring `o.shahtaj_order_booker_id` in `_sync_for_sale_orders()`.
  * Removed static auto-linking fallback; full dispatch control is now handled in real time via **Assign / Split Delivery Man**.
* **Real-time DM Dashboard Refresh**:
  * Updated `_refresh_for_delivery_man()` to search directly for all delivery jobs assigned to that Delivery Man, displaying orders immediately when invoice is posted.

### C. Split Order Dispatch & Dual-Status Architecture
* **Split Deliveries**: A single Sales Order can be split across multiple DMs with custom product quantities.
* **Two Independent Statuses**:
  1. **Stock Lifecycle (`state`)**: `not_ready` (Waiting Invoice) → `ready` (Ready to Pick) → `picked` (Loaded on Van) → `partial` / `delivered` (Delivered) / `returned` (Returned to WH).
  2. **Field Stop Lifecycle (`field_state`)**: `pending` (Not Started) → `in_transit` (On the Way) → `not_attended` (Shop Closed) / `failed` (Could Not Deliver) → `done` (Stop Done).
* **Mandatory Field Notes**: Required when marking a stop as *Shop Closed* or *Could Not Deliver*.

### D. Warehouse Van Loading & "Today Load"
* **Per-job Loading**: `Pick Stock from Warehouse` loads allocated items onto the van.
* **Collective Loading Dashboard**: `Today Load` (`shahtaj.dm.today.load`) aggregates all pending quantities across today's stops for one-click collective loading.

### E. Shop GPS Verification & Distributor Reset
* **Distributor GPS Reset**: Distributors can reset shop verification status (`shahtaj_field_verified = False`) and clear bad GPS coordinates so Order Bookers re-verify on-site.

---

## 2. How to Check & Verify Accounts in the Delivery Flow

### Account Overview & Roles

| Account Code | Account Name | Account Type | Role in the Distribution Workflow |
| :---: | :--- | :---: | :--- |
| **`101410`** | Cash with Delivery Men (DM Wallet) | Current Assets *(Reconcile=True)* | Tracks **physical cash** collected by DMs from retail shops on the road. |
| **`110200`** | Van Stock (Goods in Transit) | Current Assets *(Reconcile=False)* | Represents inventory valuation of **goods loaded on van wheels**. |
| **`121000`** | Accounts Receivable | Receivable | Tracks debt owed by the retail shop upon invoice posting. |
| **`400000`** | Product Sales | Income | Sales revenue recognized upon invoice confirmation. |
| **`101401`** | Bank | Bank & Cash | Company main bank account where collected cash is deposited at HQ. |

---

### End-to-End Accounting Verification Steps

```
[ Step 1: Post Invoice ]
   Debit:   121000 Accounts Receivable (Shop owes company)
   Credit:  400000 Product Sales (Sales Revenue recognized)
      ↓
[ Step 2: Load Stock to Van ]
   Physical inventory moves from WH/Stock to Delivery Vans/Van - [DM Name].
   Tracked in Inventory App under Location: Delivery Vans/Van - [DM Name].
      ↓
[ Step 3: Deliver Goods to Shop ]
   DM validates delivery. Status changes to Delivered.
   Stop status updates to Done.
      ↓
[ Step 4: Register Cash Collection (DM Wallet) ]
   Open Invoice → Register Payment → Journal: "DM Cash Collections (DMCASH)".
   Debit:   101410 DM Wallet (Cash held by DM)
   Credit:  121000 Accounts Receivable (Shop debt cleared / Invoice marked Paid)
      ↓
[ Step 5: End-of-Day Settlement (Bank Deposit) ]
   DM deposits cash at HQ.
   Debit:   101401 Main Bank Account
   Credit:  101410 DM Wallet (DM Wallet balance returns to $0.00)
```

---

### Step-by-Step UI Verification Checklist

#### 1. Verifying DM Wallet Entries (`101410`)
1. Log in as **Distributor / Administrator**.
2. Go to **Accounting / Invoicing → Accounting → Journal Items** (or **Shahtaj Oil → Accounting → Journal Transactions**).
3. Search for Account **`101410`**:
   * You will see the Debit entry for every invoice payment registered through `DM Cash Collections`.
   * Label and partner will show the shop and DM reference.
4. Go to **Accounting → Configuration → Chart of Accounts** → search `101410` → click **Balance**:
   * Displays the active cash balance currently held on the road by all DMs.

#### 2. Verifying Stock on Van (`110200` & Location)
1. On any Delivery Order, open the **`Van Stock`** tab or click the **`Open Van Stock`** header button.
2. In the **Inventory App**, go to **Inventory → Reporting → Stock / Locations**:
   * Filter by Location: `Delivery Vans/Van - dm1`.
   * Displays the exact product quantities on hand inside that DM's van.

---

## 3. What To Do Next (Upcoming Steps & Milestones)

- [ ] **Field Delivery & GPS Verification Test**:
  - Test DM delivery confirmation at the shop (`Deliver to Shop` button).
  - Verify GPS coordinate capture and radius check against shop coordinates.
- [ ] **Partial Delivery & Returns Flow**:
  - Test scenario where customer accepts partial quantity (e.g., 1 out of 2 units).
  - Use `Return Leftover to Warehouse` to return undelivered van stock back to `WH/Stock`.
- [ ] **End-of-Day Cash Settlement Verification**:
  - Test bank transfer / deposit entry from `101410 DM Wallet` to `101401 Bank Account`.
  - Confirm `101410` balance returns cleanly to `$0.00`.
- [ ] **Exception / Incident Handling**:
  - Test marking stops as *Shop Closed* or *Could Not Deliver* with required note logging.
  - Verify distributor dispatch filters for flagged stops (`Needs Attention`, `Shop Closed`, `Could Not Deliver`).
- [ ] **Outsider Drops / Ad-hoc Deliveries (M7)**:
  - Verify recording deliveries made by third-party drivers or unassigned stops.

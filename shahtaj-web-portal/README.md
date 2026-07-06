# Shahtaj Oil — Odoo 19 Addons

This repository contains **custom Odoo addons only**. Odoo 19 Community core, Python virtualenv, database dumps, and `odoo.conf` live **outside** this repo on each developer machine.

## What is in this repo

| Path | Purpose |
|------|---------|
| `shahtaj_oil/` | Main application module (distributor portal, order booker, API, accounting hooks) |
| `fastapi/` | OCA FastAPI integration (required dependency) |
| `endpoint_route_handler/` | OCA route handler (required by `fastapi`) |

Current module version: see `shahtaj_oil/__manifest__.py`.

## Frontend / OWL development

Custom distributor UI (OWL) lives under:

```
shahtaj_oil/static/src/
├── js/
│   ├── custom_portal_shell.js      # Minimal navbar (logout only)
│   └── components/
│       ├── dashboard.js
│       ├── territory_routes.js     # Zones, routes, shops
│       ├── warehouse_inventory.js
│       ├── financials_invoicing.js
│       ├── staff_management.js
│       ├── operations_tracking.js
│       ├── schedules_targets.js
│       └── settings.js
├── xml/                            # OWL templates (paired with components)
└── scss/
    └── custom_portal_shell.scss
```

Assets are registered in `shahtaj_oil/__manifest__.py` under `web.assets_backend`.

After JS/XML/SCSS changes:

1. Upgrade module: `-u shahtaj_oil`
2. Hard refresh browser (Ctrl+Shift+R) or use incognito

## Order booker mobile API

REST routes are under `shahtaj_oil/controllers/api/`. Base path:

```
/api/shahtaj/v1/
```

Interactive tester (when module is installed): **Shahtaj Oil → API Test** in Odoo, or `shahtaj_oil/static/api_test/`.

Serializers: `shahtaj_oil/api/serializers.py`

## Local setup (summary)

1. Install **Odoo 19 Community** separately (not from this repo).
2. Install **PostgreSQL** and create a database.
3. Clone this repo and add to `addons_path` in your local `odoo.conf`:

   ```ini
   addons_path = /path/to/odoo-19.0/addons,/path/to/this-repo
   ```

4. Install Python deps for FastAPI (see `fastapi/__manifest__.py` `external_dependencies`).
5. Start Odoo and install **Shahtaj Oil**:

   ```bash
   python odoo-bin -c odoo.conf -d your_db -i shahtaj_oil
   ```

6. For updates after pulling code:

   ```bash
   python odoo-bin -c odoo.conf -d your_db -u shahtaj_oil --stop-after-init
   ```

## Test users (dev)

Configure in Odoo after install — typical roles:

- **Distributor** — custom portal or native UI (`shahtaj_custom_frontend` on user)
- **Order booker** — field visits + mobile API
- **Admin** — full settings

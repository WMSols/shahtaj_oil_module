# -*- coding: utf-8 -*-
{
    'name': 'Shahtaj Oil',
    'version': '19.0.1.0.44',
    'post_init_hook': 'post_init_hook',
    'category': 'Sales/Distribution',
    'summary': 'Unified Command Center for Shahtaj Oil distributions, field booking, and SPA frontend',
    'author': 'WMsols',
    'depends': [
        'base', 
        'web', 
        'contacts', 
        'sale', 
        'sale_stock', 
        'mail', 
        'account', 
        'stock', 
        'fastapi'
    ],
    'data': [
        # ── 1. SECURITY (groups first, then access, then rules) ──
        'security/shahtaj_security.xml',
        'security/ir.model.access.csv',
        'security/shahtaj_record_rules.xml',
        'security/shahtaj_partner_access.xml',

        # ── 2. BASE DATA (no view/action dependencies) ──
        'data/shahtaj_account_data.xml',
        'data/shahtaj_product_data.xml',
        'data/shahtaj_api_data.xml',
        'data/shahtaj_cron.xml',

        # ── 3. CORE VIEWS + ACTIONS (no inherit from other module views) ──
        'views/shahtaj_route_views.xml',
        'views/shahtaj_zone_views.xml',
        'views/shahtaj_partner_views.xml',
        'views/shahtaj_schedule_views.xml',
        'views/shahtaj_visit_task_views.xml',
        'views/shahtaj_target_views.xml',

        # ── 4. VISIT VIEWS (before sale_accounting which inherits visit views) ──
        'data/shahtaj_visit_action_cleanup.xml',
        'views/shahtaj_visit_views.xml',
        'wizard/shahtaj_visit_checkin_views.xml',

        # ── 5. ACCOUNTING / PRODUCT VIEWS (inherit standard Odoo or partner views) ──
        'views/shahtaj_account_payment_views.xml',
        'views/shahtaj_accounting_views.xml',
        'views/shahtaj_sale_accounting_views.xml',
        'views/shahtaj_accounting_hub_views.xml',
        'views/shahtaj_product_views.xml',
        'views/shahtaj_sale_stock_fix.xml',

        # ── 6. HUB + USER MANAGEMENT VIEWS ──
        'views/shahtaj_schedule_hub_views.xml',
        'views/shahtaj_visit_hub_views.xml',
        'views/shahtaj_order_booker_users_views.xml',
        'views/res_users_views.xml',

        # ── 7. WIZARDS (actions used by menus) ──
        'wizard/shahtaj_generate_tasks_views.xml',
        'wizard/shahtaj_create_order_booker_views.xml',
        'wizard/shahtaj_quick_add_product_views.xml',
        'wizard/shahtaj_add_stock_views.xml',
        
        # ── 8. SECURITY FIXES (must update rules created in step 1) ──
        'security/shahtaj_record_rules_fix.xml',
        'security/shahtaj_booker_ui_fix.xml',
        'security/shahtaj_partner_access_upgrade.xml',

        # ── 9. DATA FIXES / CLEANUP (must run after actions they touch) ──
        'data/shahtaj_accounting_action_fix.xml',
        'data/shahtaj_accounting_menu_cleanup.xml',
        'data/shahtaj_ui_mode_sync.xml',
        'data/shahtaj_user_access_sync.xml',

        # ── 10. MENUS (ALWAYS LAST; includes distributor portal client action) ──
        'views/menus.xml', # All combined Menus
        'views/shahtaj_api_test_menu.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'shahtaj_oil/static/src/scss/custom_portal_shell.scss',
            'shahtaj_oil/static/src/js/custom_portal_shell.js',
            # Linked OWL layout template and component logic (Paths updated to shahtaj_oil)
            'shahtaj_oil/static/src/xml/dashboard.xml',
            'shahtaj_oil/static/src/js/components/staff_management.js',
            'shahtaj_oil/static/src/js/components/operations_tracking.js',
            'shahtaj_oil/static/src/js/components/territory_routes.js',
            'shahtaj_oil/static/src/js/components/warehouse_inventory.js',
            'shahtaj_oil/static/src/js/components/financials_invoicing.js',
            'shahtaj_oil/static/src/js/components/settings.js',
            'shahtaj_oil/static/src/js/components/schedules_targets.js',
            'shahtaj_oil/static/src/js/components/dashboard.js',
            'shahtaj_oil/static/src/xml/*.xml',
        ],
    },
    'application': True,
    'installable': True,
    'license': 'LGPL-3',
}
# -*- coding: utf-8 -*-
# Model load order: territory → shops → schedules → visits → targets → Odoo extensions.

from . import shahtaj_territory_sync
from . import shahtaj_zone
from . import shahtaj_route
from . import res_partner
from . import shahtaj_weekly_schedule
from . import shahtaj_visit_task
from . import shahtaj_visit
from . import shahtaj_visit_target
from . import sale_order
from . import sale_order_line
from . import product_product
from . import product_template
from . import account_move
from . import account_move_line
from . import account_payment
from . import account_move_reversal
from . import account_journal
from . import res_users
from . import shahtaj_accounting_hub
from . import shahtaj_pnl_dashboard
from . import shahtaj_stock_receipt
from . import shahtaj_manufacturer_summary
from . import ir_http
from . import ir_ui_menu

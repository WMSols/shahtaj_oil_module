# -*- coding: utf-8 -*-
"""Native Settings: Shahtaj field GPS distance limits."""
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    shahtaj_min_shop_distance_m = fields.Float(
        related='company_id.shahtaj_min_shop_distance_m',
        readonly=False,
    )
    shahtaj_max_shop_distance_m = fields.Float(
        related='company_id.shahtaj_max_shop_distance_m',
        readonly=False,
    )

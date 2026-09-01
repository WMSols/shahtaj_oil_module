# -*- coding: utf-8 -*-
"""Process incoming purchase receipts to update Weighted Average Cost (AVCO) in real time."""
from odoo import api, fields, models
from odoo.tools import float_compare


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    shahtaj_avco_processed = fields.Boolean(
        string='Shahtaj AVCO Processed',
        default=False,
        copy=False,
    )

    def button_validate(self):
        res = super().button_validate()
        self._shahtaj_process_incoming_avco()
        return res

    def _shahtaj_process_incoming_avco(self):
        """When an incoming purchase receipt is validated, recalculate product AVCO and log receipt."""
        for picking in self.filtered(
            lambda p: p.state == 'done' and p.picking_type_code == 'incoming' and not p.shahtaj_avco_processed
        ):
            receipt_date = (
                picking.date_done.date()
                if picking.date_done
                else fields.Date.context_today(self)
            )
            for move in picking.move_ids.filtered(lambda m: m.state == 'done'):
                product = move.product_id
                if not product or not product.is_storable:
                    continue
                rounding = product.uom_id.rounding or 0.01
                qty_received = move.quantity or move.product_uom_qty
                if float_compare(qty_received, 0.0, precision_rounding=rounding) <= 0:
                    continue

                po_line = move.purchase_line_id
                if po_line:
                    discount = getattr(po_line, 'discount', 0.0) or 0.0
                    unit_price = po_line.price_unit * (1.0 - discount / 100.0)
                else:
                    unit_price = product.standard_price or 0.0

                product.product_tmpl_id._shahtaj_apply_avco_receipt(
                    incoming_qty=qty_received,
                    incoming_unit_cost=unit_price,
                    source='add_stock',
                    receipt_date=receipt_date,
                )
            picking.sudo().write({'shahtaj_avco_processed': True})

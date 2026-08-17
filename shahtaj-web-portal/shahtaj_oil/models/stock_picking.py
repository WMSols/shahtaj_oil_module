# -*- coding: utf-8 -*-
"""Create a draft vendor bill when a purchase receipt is validated."""
import logging

from odoo import models

_logger = logging.getLogger(__name__)


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    def _action_done(self):
        res = super()._action_done()
        self._shahtaj_auto_create_vendor_bills()
        return res

    def _shahtaj_auto_create_vendor_bills(self):
        """After a PO incoming receipt, bill received qty that is not yet billed.

        Skips Add Stock / inventory adjustments (no purchase order), outgoing
        deliveries, and vendor returns. Failures are logged so stock receive
        still succeeds.
        """
        if self.env.context.get('shahtaj_skip_vendor_bill'):
            return
        incoming = self.filtered(
            lambda picking: (
                picking.state == 'done'
                and picking.picking_type_id.code == 'incoming'
                and picking.purchase_id
                and picking.location_dest_id.usage != 'supplier'
            )
        )
        if not incoming:
            return
        try:
            incoming.mapped('purchase_id')._shahtaj_create_draft_vendor_bill()
        except Exception:
            _logger.exception(
                'Shahtaj: vendor bill auto-create failed after receipts %s',
                ', '.join(incoming.mapped('name')),
            )

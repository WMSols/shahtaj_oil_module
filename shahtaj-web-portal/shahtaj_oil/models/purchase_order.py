# -*- coding: utf-8 -*-
"""Draft vendor bills from received purchase orders."""
import logging

from odoo import _, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools.float_utils import float_is_zero

_logger = logging.getLogger(__name__)


class PurchaseOrder(models.Model):
    _inherit = 'purchase.order'

    def _shahtaj_create_draft_vendor_bill(self):
        """Create a draft vendor bill for received quantities not yet billed.

        Uses standard ``action_create_invoice`` so products, prices, quantities,
        and the PO origin stay linked. The bill is left in draft so it can be
        checked before posting and paying. Does not open a window action.
        """
        precision = self.env['decimal.precision'].precision_get('Product Unit')
        to_bill = self.filtered(
            lambda order: order.state == 'purchase' and any(
                not line.display_type
                and not float_is_zero(
                    line.qty_to_invoice, precision_digits=precision,
                )
                for line in order.order_line
            )
        )
        if not to_bill:
            return self.env['account.move']

        existing = to_bill.mapped('invoice_ids')
        try:
            to_bill.with_context(shahtaj_auto_vendor_bill=True).action_create_invoice()
        except (AccessError, UserError, ValidationError) as err:
            _logger.warning(
                'Shahtaj: could not auto-create vendor bill for %s: %s',
                ', '.join(to_bill.mapped('name')),
                err,
            )
            for order in to_bill:
                order.message_post(body=_(
                    'Could not create a vendor bill automatically after '
                    'receipt. Use Create Bill on the purchase order if needed.'
                ))
            return self.env['account.move']

        to_bill.invalidate_recordset(['invoice_ids', 'invoice_count'])
        created = to_bill.mapped('invoice_ids') - existing
        for bill in created.filtered(lambda move: move.state == 'draft'):
            bill.message_post(body=_(
                'Draft vendor bill created automatically after products '
                'were received.'
            ))
        return created

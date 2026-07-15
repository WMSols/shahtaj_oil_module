# -*- coding: utf-8 -*-
"""Distributor wizard: mark full or partial delivery on a field sales order."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero


class ShahtajMarkDeliveryWizard(models.TransientModel):
    _name = 'shahtaj.mark.delivery.wizard'
    _description = 'Mark Shop Delivery'

    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(
        related='sale_order_id.partner_id',
        string='Shop',
    )
    line_ids = fields.One2many(
        'shahtaj.mark.delivery.wizard.line',
        'wizard_id',
        string='Products to Deliver',
    )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        order_id = self.env.context.get('active_id') or res.get('sale_order_id')
        order = self.env['sale.order'].browse(order_id)
        if not order.exists():
            return res
        res['sale_order_id'] = order.id
        pickings = order.picking_ids.filtered(
            lambda p: p.state not in ('done', 'cancel')
            and p.picking_type_code == 'outgoing'
        )
        draft = pickings.filtered(lambda p: p.state == 'draft')
        if draft:
            draft.action_confirm()
        pickings.action_assign()

        lines = []
        moves = pickings.move_ids.filtered(lambda m: m.state not in ('done', 'cancel'))
        for move in moves:
            sol = move.sale_line_id
            ordered = sol.product_uom_qty if sol else move.product_uom_qty
            already = sol.qty_delivered if sol else 0.0
            remaining = max(ordered - already, 0.0)
            if float_is_zero(remaining, precision_rounding=move.product_uom.rounding):
                continue
            lines.append((0, 0, {
                'move_id': move.id,
                'sale_line_id': sol.id if sol else False,
                'qty_ordered': ordered,
                'qty_already_delivered': already,
                'qty_to_deliver': remaining,
            }))
        res['line_ids'] = lines
        return res

    def action_deliver_all_remaining(self):
        self.ensure_one()
        for line in self.line_ids:
            line.qty_to_deliver = max(line.qty_ordered - line.qty_already_delivered, 0.0)
        return self.action_confirm_delivery()

    def action_confirm_delivery(self):
        self.ensure_one()
        if not self.line_ids:
            raise UserError(_(
                'No open delivery for this order. '
                'Stock may already be fully delivered, or the product is not tracked in inventory.'
            ))

        pickings = self.env['stock.picking']
        any_qty = False
        for line in self.line_ids:
            rounding = line.product_uom_id.rounding or 0.01
            remaining = line.qty_ordered - line.qty_already_delivered
            if float_compare(line.qty_to_deliver, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Delivered quantity cannot be negative.'))
            if float_compare(line.qty_to_deliver, remaining, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot deliver %(done)s of %(product)s — only %(left)s remaining.',
                    done=line.qty_to_deliver,
                    product=line.product_id.display_name,
                    left=remaining,
                ))
            move = line.move_id.sudo()
            if move.state in ('done', 'cancel'):
                continue
            if float_is_zero(line.qty_to_deliver, precision_rounding=rounding):
                move.quantity = 0.0
            else:
                any_qty = True
                move._set_quantity_done(line.qty_to_deliver)
                move.picked = True
            pickings |= move.picking_id

        if not any_qty:
            raise UserError(_('Enter a quantity to deliver on at least one product.'))

        pickings = pickings.sudo().filtered(lambda p: p.state not in ('done', 'cancel'))
        pickings.filtered(lambda p: p.state == 'draft').action_confirm()
        pickings.action_assign()
        # Re-apply quantities after assign (reservation can reset them).
        for line in self.line_ids:
            move = line.move_id.sudo()
            if move.state in ('done', 'cancel'):
                continue
            if not float_is_zero(
                line.qty_to_deliver,
                precision_rounding=line.product_uom_id.rounding or 0.01,
            ):
                move._set_quantity_done(line.qty_to_deliver)
                move.picked = True

        result = pickings.with_context(skip_backorder=True, skip_sms=True).button_validate()
        # With skip_backorder, partial qty creates a backorder automatically.
        # Keep a fallback if another wizard still appears.
        if isinstance(result, dict) and result.get('res_model') == 'stock.backorder.confirmation':
            ctx = dict(result.get('context') or {})
            wiz = self.env['stock.backorder.confirmation'].with_context(ctx).create({
                'pick_ids': [(6, 0, pickings.ids)],
                'backorder_confirmation_line_ids': [
                    (0, 0, {'to_backorder': True, 'picking_id': pid})
                    for pid in pickings.ids
                ],
            })
            wiz.process()

        return {
            'type': 'ir.actions.act_window',
            'name': _('Sales Order'),
            'res_model': 'sale.order',
            'res_id': self.sale_order_id.id,
            'view_mode': 'form',
            'target': 'current',
        }


class ShahtajMarkDeliveryWizardLine(models.TransientModel):
    _name = 'shahtaj.mark.delivery.wizard.line'
    _description = 'Mark Delivery Line'

    wizard_id = fields.Many2one(
        'shahtaj.mark.delivery.wizard',
        required=True,
        ondelete='cascade',
    )
    move_id = fields.Many2one('stock.move', string='Stock Move', required=True)
    sale_line_id = fields.Many2one('sale.order.line', string='Order Line')
    # Related so the web client can omit readonly product_id on save.
    product_id = fields.Many2one(
        related='move_id.product_id',
        string='Product',
        readonly=True,
    )
    product_uom_id = fields.Many2one(
        related='move_id.product_uom',
        string='Unit',
        readonly=True,
    )
    qty_ordered = fields.Float(string='Ordered', digits='Product Unit of Measure')
    qty_already_delivered = fields.Float(
        string='Already Delivered',
        digits='Product Unit of Measure',
    )
    qty_to_deliver = fields.Float(
        string='Deliver Now',
        digits='Product Unit of Measure',
        required=True,
    )

    @api.model_create_multi
    def create(self, vals_list):
        """Fill product/qty context from the move when readonly fields are dropped."""
        Move = self.env['stock.move']
        for vals in vals_list:
            move = Move.browse(vals.get('move_id')) if vals.get('move_id') else Move
            if move and not vals.get('sale_line_id') and move.sale_line_id:
                vals['sale_line_id'] = move.sale_line_id.id
            if move and 'qty_ordered' not in vals:
                sol = move.sale_line_id
                vals['qty_ordered'] = sol.product_uom_qty if sol else move.product_uom_qty
            if move and 'qty_already_delivered' not in vals:
                vals['qty_already_delivered'] = (
                    move.sale_line_id.qty_delivered if move.sale_line_id else 0.0
                )
        return super().create(vals_list)

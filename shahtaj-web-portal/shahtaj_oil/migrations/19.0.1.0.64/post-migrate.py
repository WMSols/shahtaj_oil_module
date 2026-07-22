# -*- coding: utf-8 -*-
"""Backfill frozen invoice costs and stock receipt ledger from historical data."""
from odoo import SUPERUSER_ID, api, fields


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})

    old_action = env.ref(
        'shahtaj_oil.action_shahtaj_manufacturer_summary',
        raise_if_not_found=False,
    )
    if old_action and old_action._name == 'ir.actions.act_window':
        old_action.unlink()

    invoice_lines = env['account.move.line'].sudo().search([
        ('move_id.move_type', 'in', ('out_invoice', 'out_refund')),
        ('move_id.state', '=', 'posted'),
        ('display_type', '=', 'product'),
        ('product_id', '!=', False),
        ('shahtaj_cost_unit', '=', 0),
    ])
    for line in invoice_lines:
        line.shahtaj_cost_unit = line.product_id.standard_price or 0.0

    if env['shahtaj.stock.receipt'].sudo().search_count([]):
        return

    Move = env['stock.move'].sudo()
    incoming_moves = Move.search([
        ('state', '=', 'done'),
        ('location_dest_id.usage', '=', 'internal'),
        ('location_id.usage', '!=', 'internal'),
        ('product_id', '!=', False),
    ], order='date asc, id asc')

    Receipt = env['shahtaj.stock.receipt'].sudo()
    for move in incoming_moves:
        Receipt.create({
            'product_id': move.product_id.id,
            'qty': move.product_uom_qty,
            'unit_cost': move.product_id.standard_price or 0.0,
            'source': 'backfill',
            'receipt_date': (
                move.date.date() if move.date else fields.Date.today()
            ),
        })

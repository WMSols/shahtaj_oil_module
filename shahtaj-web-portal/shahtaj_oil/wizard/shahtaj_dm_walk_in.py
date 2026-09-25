# -*- coding: utf-8 -*-
"""Native DM wizard: walk-in delivery (flush van stock → SO + invoice + full wallet pay)."""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools import float_compare


class ShahtajDmWalkIn(models.TransientModel):
    _name = 'shahtaj.dm.walk.in'
    _description = 'DM Walk-in Delivery'

    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    customer_name = fields.Char(string='Customer Name', required=True)
    phone = fields.Char(string='Phone')
    latitude = fields.Float(string='My Latitude', digits=(10, 7), required=True)
    longitude = fields.Float(string='My Longitude', digits=(10, 7), required=True)
    receiver_name = fields.Char(string='Receiver Name', required=True)
    delivery_proof_image = fields.Image(
        string='Delivery Proof',
        max_width=1920,
        max_height=1920,
        required=True,
    )
    notes = fields.Text(string='Notes')
    payment_method = fields.Selection(
        [
            ('cash', 'Cash'),
            ('cheque', 'Cheque'),
        ],
        string='Payment Method',
        default='cash',
        required=True,
    )
    cheque_number = fields.Char(string='Cheque Number')
    cheque_image = fields.Image(
        string='Cheque Photo',
        max_width=1920,
        max_height=1920,
    )
    currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env.company.currency_id,
        required=True,
    )
    pricelist_id = fields.Many2one(
        'product.pricelist',
        string='Pricelist',
        readonly=True,
        help='Company pricelist — DM cannot change prices.',
    )
    amount_total = fields.Monetary(
        string='Order Total (full pay)',
        compute='_compute_amount_total',
        currency_field='currency_id',
    )
    wallet_balance = fields.Monetary(
        string='Wallet (before)',
        currency_field='currency_id',
        readonly=True,
    )
    line_ids = fields.One2many(
        'shahtaj.dm.walk.in.line',
        'wizard_id',
        string='Van Products',
    )

    @api.onchange('payment_method')
    def _onchange_payment_method(self):
        if self.payment_method == 'cash':
            self.cheque_number = False
            self.cheque_image = False

    @api.depends('line_ids.price_subtotal')
    def _compute_amount_total(self):
        for wiz in self:
            wiz.amount_total = sum(wiz.line_ids.mapped('price_subtotal'))

    def _shahtaj_resolve_delivery_man(self):
        user = self.env.user
        ctx_dm = self.env.context.get('shahtaj_delivery_man_id')
        if ctx_dm and (
            user.has_group('shahtaj_oil.group_shahtaj_distributor')
            or user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui')
        ):
            return self.env['res.users'].browse(ctx_dm)
        if user.shahtaj_is_delivery_man:
            return user
        raise UserError(_('No delivery man selected.'))

    def _shahtaj_assert_can_run(self):
        self.ensure_one()
        user = self.env.user
        dm = self.delivery_man_id
        if not dm or not dm.shahtaj_is_delivery_man:
            raise UserError(_('Select a valid delivery man.'))
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return
        if user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui'):
            return
        if user.shahtaj_is_delivery_man and user.id == dm.id:
            return
        raise AccessError(_('You can only run walk-in delivery for your own van.'))

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        dm = self._shahtaj_resolve_delivery_man()
        Service = self.env['shahtaj.dm.api.service']
        pricelist = Service._company_sale_pricelist()
        Recovery = self.env['shahtaj.dm.recovery.service']
        res.update({
            'delivery_man_id': dm.id,
            'pricelist_id': pricelist.id if pricelist else False,
            'wallet_balance': Recovery.wallet_balance(dm),
            'currency_id': self.env.company.currency_id.id,
        })
        if 'line_ids' in fields_list or True:
            van = Service.van_snapshot(dm)
            commands = [(5, 0, 0)]
            Product = self.env['product.product']
            # Walk-in may only consume free/surplus van stock (not reserved for
            # open shop jobs). List every product on the van so reserved stock
            # is visible, but Deliver Qty is capped by qty_free.
            for item in van.get('items') or []:
                on_van = float(item.get('qty') or 0.0)
                if on_van <= 0:
                    continue
                free = float(item.get('qty_free') or 0.0)
                product = Product.browse(item['product_id'])
                price = 0.0
                if pricelist and product.exists():
                    price = pricelist._get_product_price(
                        product, 1.0, currency=self.env.company.currency_id,
                    )
                commands.append((0, 0, {
                    'product_id': item['product_id'],
                    'qty_on_van': on_van,
                    'qty_free': max(0.0, free),
                    'qty': 0.0,
                    'price_unit': price,
                }))
            res['line_ids'] = commands
        return res

    def action_confirm_walk_in(self):
        self.ensure_one()
        self._shahtaj_assert_can_run()
        if not self.customer_name:
            raise UserError(_('Customer name is required.'))
        if self.latitude is None or self.longitude is None:
            raise UserError(_('Capture GPS before confirming.'))
        if float_compare(self.latitude, 0.0, precision_digits=7) == 0 and float_compare(
            self.longitude, 0.0, precision_digits=7,
        ) == 0:
            raise UserError(_('Capture GPS before confirming (Use My GPS).'))
        if self.payment_method == 'cheque':
            if not (self.cheque_number or '').strip():
                raise UserError(_('Cheque number is required.'))
            if not self.cheque_image:
                raise UserError(_('Cheque photo is required.'))

        lines = []
        for line in self.line_ids:
            qty = float(line.qty or 0.0)
            if qty <= 0:
                continue
            free = float(line.qty_free or 0.0)
            if float_compare(qty, free, precision_digits=3) > 0:
                raise UserError(_(
                    'Qty for %(product)s exceeds free van stock '
                    '(%(free)s free of %(van)s on van). '
                    'Stock reserved for today\'s open shop deliveries cannot be '
                    'sold as walk-in until those stops are finished or closed. '
                    'Past-day open jobs do not reserve stock unless '
                    'rescheduled to today.',
                    product=line.product_id.display_name,
                    free=free,
                    van=line.qty_on_van,
                ))
            lines.append({
                'product_id': line.product_id.id,
                'qty': qty,
            })
        if not lines:
            raise UserError(_(
                'Set a deliver quantity on at least one product with free van stock. '
                'If Free is 0, finish today\'s open shop deliveries first '
                '(or load surplus / use stock from past-day jobs not '
                'rescheduled to today).'
            ))

        result = self.env['shahtaj.dm.api.service'].walk_in_deliver(
            customer_name=self.customer_name,
            phone=self.phone,
            latitude=self.latitude,
            longitude=self.longitude,
            lines=lines,
            notes=self.notes or '',
            receiver_name=self.receiver_name,
            delivery_proof_image=self.delivery_proof_image,
            payment_method=self.payment_method or 'cash',
            cheque_number=self.cheque_number,
            cheque_image=self.cheque_image,
            dm=self.delivery_man_id,
        )
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Walk-in complete'),
                'message': _(
                    '%(customer)s · %(invoice)s · paid %(amount).2f into DM wallet',
                    customer=result.get('partner_name'),
                    invoice=result.get('invoice_name'),
                    amount=result.get('amount_total') or 0.0,
                ),
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }

    @api.model
    def action_open(self):
        """Open walk-in wizard for current DM (or context DM)."""
        dm = self._shahtaj_resolve_delivery_man()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Walk-in Delivery'),
            'res_model': 'shahtaj.dm.walk.in',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'shahtaj_delivery_man_id': dm.id,
                'default_delivery_man_id': dm.id,
                'lock_delivery_man': True,
            },
        }


class ShahtajDmWalkInLine(models.TransientModel):
    _name = 'shahtaj.dm.walk.in.line'
    _description = 'DM Walk-in Delivery Line'

    wizard_id = fields.Many2one(
        'shahtaj.dm.walk.in',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
        readonly=True,
    )
    qty_on_van = fields.Float(
        string='On Van',
        digits='Product Unit of Measure',
        readonly=True,
        help='Physical quantity currently on the van.',
    )
    qty_free = fields.Float(
        string='Free',
        digits='Product Unit of Measure',
        readonly=True,
        help='Surplus available for walk-in: on van minus qty still reserved '
             'for today\'s scheduled open shop deliveries (picked − delivered). '
             'Past-day open jobs do not reserve stock unless rescheduled to today. '
             'Done/closed jobs release stock back to free.',
    )
    qty = fields.Float(
        string='Deliver Qty',
        digits='Product Unit of Measure',
        help='Cannot exceed Free.',
    )
    currency_id = fields.Many2one(related='wizard_id.currency_id', readonly=True)
    price_unit = fields.Monetary(
        string='Unit Price',
        currency_field='currency_id',
        readonly=True,
        help='From company pricelist (not editable).',
    )
    price_subtotal = fields.Monetary(
        string='Subtotal',
        compute='_compute_price_subtotal',
        currency_field='currency_id',
    )

    @api.depends('qty', 'price_unit')
    def _compute_price_subtotal(self):
        for line in self:
            line.price_subtotal = (line.qty or 0.0) * (line.price_unit or 0.0)

    @api.onchange('qty')
    def _onchange_qty(self):
        for line in self:
            free = float(line.qty_free or 0.0)
            if line.qty and float_compare(line.qty, free, precision_digits=3) > 0:
                return {
                    'warning': {
                        'title': _('Exceeds free van stock'),
                        'message': _(
                            'Only %(free)s is free for walk-in '
                            '(%(van)s on van; the rest is reserved for today\'s '
                            'open shop deliveries).',
                            free=free,
                            van=line.qty_on_van,
                        ),
                    },
                }

# -*- coding: utf-8 -*-
"""Distributor wizard: assign / split a confirmed SO across delivery men (M2)."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero


class ShahtajDmAssignWizard(models.TransientModel):
    _name = 'shahtaj.dm.assign.wizard'
    _description = 'Assign / Split Sales Order to Delivery Men'

    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(
        related='sale_order_id.partner_id',
        string='Shop',
        readonly=True,
    )
    order_booker_id = fields.Many2one(
        related='sale_order_id.shahtaj_order_booker_id',
        string='Order Booker',
        readonly=True,
    )
    amount_total = fields.Monetary(
        related='sale_order_id.amount_total',
        string='Order Total',
        readonly=True,
    )
    currency_id = fields.Many2one(
        related='sale_order_id.currency_id',
        readonly=True,
    )
    job_ids = fields.One2many(
        'shahtaj.dm.assign.wizard.job',
        'wizard_id',
        string='Delivery Men',
    )
    allocation_html = fields.Html(
        string='Allocation & Delivery',
        compute='_compute_allocation_html',
        sanitize=False,
        help='Assignable plan plus read-only pick/deliver progress from real DM jobs.',
    )

    @api.depends(
        'job_ids.line_ids.qty_assigned',
        'job_ids.line_ids.sale_order_line_id',
        'job_ids.existing_job_id',
        'job_ids.existing_job_id.state',
        'job_ids.existing_job_id.field_state',
        'job_ids.existing_job_id.line_ids.qty_picked',
        'job_ids.existing_job_id.line_ids.qty_delivered',
        'sale_order_id.order_line.product_uom_qty',
        'sale_order_id.shahtaj_dm_delivery_ids',
        'sale_order_id.shahtaj_dm_delivery_ids.state',
        'sale_order_id.shahtaj_dm_delivery_ids.field_state',
        'sale_order_id.shahtaj_dm_delivery_ids.line_ids.qty_assigned',
        'sale_order_id.shahtaj_dm_delivery_ids.line_ids.qty_picked',
        'sale_order_id.shahtaj_dm_delivery_ids.line_ids.qty_delivered',
    )
    def _compute_allocation_html(self):
        for wiz in self:
            if not wiz.sale_order_id:
                wiz.allocation_html = False
                continue
            sale_lines = wiz.sale_order_id.order_line.filtered(
                lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
            )
            rows = []
            ok = True
            for sol in sale_lines:
                assigned = 0.0
                for job in wiz.job_ids:
                    for line in job.line_ids.filtered(
                        lambda l, sid=sol.id: l.sale_order_line_id.id == sid
                    ):
                        assigned += line.qty_assigned
                rounding = sol.product_uom_id.rounding or 0.01
                left = sol.product_uom_qty - assigned
                if float_compare(assigned, sol.product_uom_qty, precision_rounding=rounding) > 0:
                    ok = False
                    cls = 'text-danger'
                elif float_is_zero(left, precision_rounding=rounding):
                    cls = 'text-success'
                else:
                    cls = 'text-warning'
                rows.append(
                    f'<tr class="{cls}">'
                    f'<td>{sol.product_id.display_name}</td>'
                    f'<td class="text-end">{sol.product_uom_qty:g}</td>'
                    f'<td class="text-end">{assigned:g}</td>'
                    f'<td class="text-end">{left:g}</td>'
                    f'</tr>'
                )
            status = (
                '<p class="mb-1 text-success"><b>Fully allocated.</b></p>'
                if ok and rows and all(
                    float_is_zero(
                        sol.product_uom_qty - sum(
                            line.qty_assigned
                            for job in wiz.job_ids
                            for line in job.line_ids
                            if line.sale_order_line_id.id == sol.id
                        ),
                        precision_rounding=sol.product_uom_id.rounding or 0.01,
                    )
                    for sol in sale_lines
                )
                else (
                    '<p class="mb-1 text-danger"><b>Over-allocated — reduce quantities.</b></p>'
                    if not ok
                    else '<p class="mb-1 text-muted">Unassigned leftover stays on the sales order until you allocate it.</p>'
                )
            )
            body = ''.join(rows) or '<tr><td colspan="4">No products</td></tr>'
            allocation_table = (
                status
                + '<table class="table table-sm table-bordered mb-3">'
                + '<thead><tr><th>Product</th><th class="text-end">Ordered</th>'
                + '<th class="text-end">Assigned</th><th class="text-end">Left</th></tr></thead>'
                + f'<tbody>{body}</tbody></table>'
            )
            wiz.allocation_html = allocation_table + wiz._shahtaj_delivery_progress_html()

    def _shahtaj_delivery_progress_html(self):
        """Read-only who delivered what (from real DM jobs on this SO)."""
        self.ensure_one()
        order = self.sale_order_id
        jobs = order.shahtaj_dm_delivery_ids.sorted('id')
        if not jobs:
            return (
                '<p class="mb-0 text-muted">'
                '<b>Delivery progress</b> — no DM jobs yet. Save assignments first.'
                '</p>'
            )
        state_labels = dict(jobs[:1]._fields['state'].selection)
        stop_labels = dict(jobs[:1]._fields['field_state'].selection)
        job_rows = []
        for job in jobs:
            dm = job.delivery_man_id.display_name if job.delivery_man_id else '—'
            assigned = sum(job.line_ids.mapped('qty_assigned'))
            picked = sum(job.line_ids.mapped('qty_picked'))
            delivered = sum(job.line_ids.mapped('qty_delivered'))
            job_rows.append(
                f'<tr>'
                f'<td>{dm}</td>'
                f'<td class="text-end">{assigned:g}</td>'
                f'<td class="text-end">{picked:g}</td>'
                f'<td class="text-end">{delivered:g}</td>'
                f'<td>{state_labels.get(job.state, job.state)}</td>'
                f'<td>{stop_labels.get(job.field_state, job.field_state)}</td>'
                f'</tr>'
            )
        product_rows = []
        sale_lines = order.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        for sol in sale_lines:
            assigned = picked = delivered = 0.0
            per_dm = []
            for job in jobs:
                line = job.line_ids.filtered(
                    lambda l, sid=sol.id: l.sale_order_line_id.id == sid
                )[:1]
                if not line:
                    continue
                assigned += line.qty_assigned
                picked += line.qty_picked
                delivered += line.qty_delivered
                if line.qty_assigned or line.qty_picked or line.qty_delivered:
                    dm = job.delivery_man_id.name if job.delivery_man_id else '—'
                    per_dm.append(
                        f'{dm}: A {line.qty_assigned:g} / P {line.qty_picked:g} / D {line.qty_delivered:g}'
                    )
            product_rows.append(
                f'<tr>'
                f'<td>{sol.product_id.display_name}</td>'
                f'<td class="text-end">{sol.product_uom_qty:g}</td>'
                f'<td class="text-end">{assigned:g}</td>'
                f'<td class="text-end">{picked:g}</td>'
                f'<td class="text-end">{delivered:g}</td>'
                f'<td class="small">{"; ".join(per_dm) or "—"}</td>'
                f'</tr>'
            )
        product_body = ''.join(product_rows) or '<tr><td colspan="6">No products</td></tr>'
        return (
            '<hr class="my-2"/>'
            '<p class="mb-1"><b>Delivery progress</b> '
            '<span class="text-muted">(read-only — from saved DM jobs)</span></p>'
            '<table class="table table-sm table-bordered mb-2">'
            '<thead><tr>'
            '<th>Delivery Man</th>'
            '<th class="text-end">Assigned</th>'
            '<th class="text-end">Picked</th>'
            '<th class="text-end">Delivered</th>'
            '<th>Stock</th><th>Stop</th>'
            '</tr></thead>'
            f'<tbody>{"".join(job_rows)}</tbody></table>'
            '<table class="table table-sm table-bordered mb-0">'
            '<thead><tr>'
            '<th>Product</th>'
            '<th class="text-end">Ordered</th>'
            '<th class="text-end">Assigned</th>'
            '<th class="text-end">Picked</th>'
            '<th class="text-end">Delivered</th>'
            '<th>Per DM (A/P/D)</th>'
            '</tr></thead>'
            f'<tbody>{product_body}</tbody>'
            '</table>'
        )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        order = self.env['sale.order'].browse(
            self.env.context.get('active_id')
            or self.env.context.get('default_sale_order_id')
        )
        if not order.exists():
            return res
        res['sale_order_id'] = order.id
        sale_lines = order.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        jobs = order.shahtaj_dm_delivery_ids.sorted('id')
        job_cmds = []
        if jobs:
            for job in jobs:
                line_cmds = []
                for sol in sale_lines:
                    existing = job.line_ids.filtered(
                        lambda l, sid=sol.id: l.sale_order_line_id.id == sid
                    )[:1]
                    qty = existing.qty_assigned if existing else 0.0
                    line_cmds.append((0, 0, {
                        'sale_order_line_id': sol.id,
                        'product_id': sol.product_id.id,
                        'product_uom_id': sol.product_uom_id.id,
                        'qty_ordered': sol.product_uom_qty,
                        'qty_assigned': qty,
                        'qty_picked': existing.qty_picked if existing else 0.0,
                        'qty_delivered': existing.qty_delivered if existing else 0.0,
                    }))
                job_cmds.append((0, 0, {
                    'delivery_man_id': job.delivery_man_id.id,
                    'scheduled_date': job.scheduled_date or fields.Date.context_today(self),
                    'scheduled_time': job.scheduled_time or 0.0,
                    'existing_job_id': job.id,
                    'line_ids': line_cmds,
                }))
        else:
            dm = (
                self.env.context.get('shahtaj_default_delivery_man_id')
                or (order.shahtaj_delivery_man_id.id if order.shahtaj_delivery_man_id else False)
            )
            line_cmds = [
                (0, 0, {
                    'sale_order_line_id': sol.id,
                    'product_id': sol.product_id.id,
                    'product_uom_id': sol.product_uom_id.id,
                    'qty_ordered': sol.product_uom_qty,
                    'qty_assigned': sol.product_uom_qty,
                    'qty_picked': 0.0,
                    'qty_delivered': 0.0,
                })
                for sol in sale_lines
            ]
            job_cmds.append((0, 0, {
                'delivery_man_id': dm,
                'scheduled_date': fields.Date.context_today(self),
                'scheduled_time': 0.0,
                'line_ids': line_cmds,
            }))
        res['job_ids'] = job_cmds
        return res

    def action_add_delivery_man(self):
        """Append another DM row with remaining unallocated qty."""
        self.ensure_one()
        # Persist current wizard first so nested edits are not lost / corrupted.
        sale_lines = self.sale_order_id.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        if not sale_lines:
            raise UserError(_('This sales order has no deliverable products.'))
        line_cmds = []
        for sol in sale_lines:
            taken = sum(
                line.qty_assigned
                for job in self.job_ids
                for line in job.line_ids
                if line.sale_order_line_id.id == sol.id
            )
            left = max(sol.product_uom_qty - taken, 0.0)
            line_cmds.append((0, 0, {
                'sale_order_line_id': sol.id,
                'product_id': sol.product_id.id,
                'product_uom_id': sol.product_uom_id.id,
                'qty_ordered': sol.product_uom_qty,
                'qty_assigned': left,
                'qty_picked': 0.0,
                'qty_delivered': 0.0,
            }))
        # delivery_man_id required: leave unset until user picks — use first available DM
        # only as empty slot; user must select. Create with False fails required field.
        Job = self.env['shahtaj.dm.assign.wizard.job']
        Job.create({
            'wizard_id': self.id,
            'scheduled_date': fields.Date.context_today(self),
            'scheduled_time': 0.0,
            'line_ids': line_cmds,
        })
        return {
            'type': 'ir.actions.act_window',
            'res_model': self._name,
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_remove_delivery_man(self, job_id=None):
        """Drop a wizard DM row. Picked/delivered jobs cannot be removed."""
        self.ensure_one()
        if isinstance(job_id, (list, tuple)):
            job_id = job_id[0] if job_id else False
        job = self.env['shahtaj.dm.assign.wizard.job'].browse(job_id)
        if not job.exists() or job.wizard_id.id != self.id:
            raise UserError(_('That delivery man row was not found.'))
        existing = job.existing_job_id
        if existing and (
            existing.state in ('picked', 'partial', 'delivered', 'returned')
            or any(l.qty_picked > 0 for l in existing.line_ids)
        ):
            raise UserError(_(
                'Cannot remove %(dm)s — stock was already picked or delivered on that job.',
                dm=existing.delivery_man_id.name or _('this delivery man'),
            ))
        job.unlink()
        return {
            'type': 'ir.actions.act_window',
            'res_model': self._name,
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_confirm_assign(self):
        self.ensure_one()
        self.sale_order_id._shahtaj_assert_not_cancelled()
        if self.sale_order_id.state not in ('sale', 'done'):
            raise UserError(_('Only confirmed sales orders can be assigned.'))
        self.sale_order_id._shahtaj_require_posted_invoice_for_dm()
        if not self.job_ids:
            raise UserError(_('Add at least one delivery man.'))

        # Drop any ghost product rows left by the web client.
        ghost_lines = self.job_ids.line_ids.filtered(lambda l: not l.sale_order_line_id)
        if ghost_lines:
            ghost_lines.unlink()

        assignments = []
        for job in self.job_ids:
            if not job.delivery_man_id:
                raise UserError(_('Select a delivery man on every assignment row.'))
            if not job.scheduled_date:
                raise UserError(_('Set a delivery day on every assignment row.'))
            if not job.line_ids:
                raise UserError(_(
                    'Open %(dm)s and set product quantities before saving.',
                    dm=job.delivery_man_id.name,
                ))
            lines = {
                line.sale_order_line_id.id: line.qty_assigned
                for line in job.line_ids
                if line.sale_order_line_id
            }
            if not lines:
                raise UserError(_(
                    'No product lines for %(dm)s. Open the row and set Assign Qty.',
                    dm=job.delivery_man_id.name,
                ))
            assignments.append({
                'delivery_man_id': job.delivery_man_id.id,
                'scheduled_date': job.scheduled_date,
                'scheduled_time': job.scheduled_time or 0.0,
                'lines': lines,
            })

        jobs = self.env['shahtaj.dm.delivery'].action_apply_split_plan(
            sale_order=self.sale_order_id,
            assignments=assignments,
            assigned_by=self.env.user,
        )
        return {
            'type': 'ir.actions.act_window',
            'name': _('DM Jobs — %s', self.sale_order_id.name),
            'res_model': 'shahtaj.dm.delivery',
            'view_mode': 'list,form',
            'domain': [('id', 'in', jobs.ids)],
            'target': 'current',
        }


class ShahtajDmAssignWizardJob(models.TransientModel):
    _name = 'shahtaj.dm.assign.wizard.job'
    _description = 'Assign Wizard — Delivery Man Job'

    wizard_id = fields.Many2one(
        'shahtaj.dm.assign.wizard',
        required=True,
        ondelete='cascade',
    )
    existing_job_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Existing Job',
        readonly=True,
    )
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    scheduled_date = fields.Date(
        string='Delivery Day',
        required=True,
        default=fields.Date.context_today,
    )
    scheduled_time = fields.Float(
        string='Time',
        default=0.0,
    )
    line_ids = fields.One2many(
        'shahtaj.dm.assign.wizard.line',
        'job_id',
        string='Products',
    )
    qty_assigned_total = fields.Float(
        string='Assigned Qty',
        compute='_compute_qty_totals',
        digits='Product Unit of Measure',
    )
    qty_picked_total = fields.Float(
        string='Picked',
        compute='_compute_qty_totals',
        digits='Product Unit of Measure',
    )
    qty_delivered_total = fields.Float(
        string='Delivered',
        compute='_compute_qty_totals',
        digits='Product Unit of Measure',
    )
    job_stock_state = fields.Selection(
        related='existing_job_id.state',
        string='Stock',
        readonly=True,
    )
    job_field_state = fields.Selection(
        related='existing_job_id.field_state',
        string='Stop',
        readonly=True,
    )

    @api.depends(
        'line_ids.qty_assigned',
        'line_ids.qty_picked',
        'line_ids.qty_delivered',
    )
    def _compute_qty_totals(self):
        for job in self:
            job.qty_assigned_total = sum(job.line_ids.mapped('qty_assigned'))
            job.qty_picked_total = sum(job.line_ids.mapped('qty_picked'))
            job.qty_delivered_total = sum(job.line_ids.mapped('qty_delivered'))

    @api.onchange('delivery_man_id', 'wizard_id')
    def _onchange_fill_product_lines(self):
        if self.line_ids or not self.wizard_id or not self.wizard_id.sale_order_id:
            return
        sale_lines = self.wizard_id.sale_order_id.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        lines = []
        for sol in sale_lines:
            taken = sum(
                line.qty_assigned
                for job in self.wizard_id.job_ids
                if job != self
                for line in job.line_ids
                if line.sale_order_line_id.id == sol.id
            )
            left = max(sol.product_uom_qty - taken, 0.0)
            lines.append((0, 0, {
                'sale_order_line_id': sol.id,
                'product_id': sol.product_id.id,
                'product_uom_id': sol.product_uom_id.id,
                'qty_ordered': sol.product_uom_qty,
                'qty_assigned': left,
                'qty_picked': 0.0,
                'qty_delivered': 0.0,
            }))
        self.line_ids = lines

    def action_remove(self):
        self.ensure_one()
        wizard = self.wizard_id
        return wizard.action_remove_delivery_man(self.id)


class ShahtajDmAssignWizardLine(models.TransientModel):
    _name = 'shahtaj.dm.assign.wizard.line'
    _description = 'Assign Wizard — Product Qty Share'

    job_id = fields.Many2one(
        'shahtaj.dm.assign.wizard.job',
        required=True,
        ondelete='cascade',
    )
    sale_order_line_id = fields.Many2one(
        'sale.order.line',
        string='Order Line',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
    )
    product_uom_id = fields.Many2one(
        'uom.uom',
        string='UoM',
    )
    qty_ordered = fields.Float(
        string='SO Qty',
        digits='Product Unit of Measure',
    )
    qty_assigned = fields.Float(
        string='Assign Qty',
        digits='Product Unit of Measure',
    )
    qty_picked = fields.Float(
        string='Picked',
        digits='Product Unit of Measure',
        readonly=True,
        help='Read-only from the saved DM job (0 if not created yet).',
    )
    qty_delivered = fields.Float(
        string='Delivered',
        digits='Product Unit of Measure',
        readonly=True,
        help='Read-only from the saved DM job (0 if not delivered yet).',
    )

    @api.model_create_multi
    def create(self, vals_list):
        """Drop ghost editable-list rows that have no SO line (web client glitch)."""
        cleaned = []
        for vals in vals_list:
            sol_id = vals.get('sale_order_line_id')
            if not sol_id:
                continue
            sol = self.env['sale.order.line'].browse(sol_id)
            if sol.exists():
                vals.setdefault('product_id', sol.product_id.id)
                vals.setdefault('product_uom_id', sol.product_uom_id.id)
                vals.setdefault('qty_ordered', sol.product_uom_qty)
            cleaned.append(vals)
        if not cleaned:
            return self.browse()
        return super().create(cleaned)


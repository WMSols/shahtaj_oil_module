# -*- coding: utf-8 -*-
"""Field / app issue reports from OB & DM (isolated from visits, jobs, payments).

Office (distributor / admin) reviews in native Odoo UI with chatter trail.
Mobile apps use dedicated report APIs only — no change to existing flows.
"""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from odoo.addons.shahtaj_oil.api.image_utils import normalize_image_b64

REPORT_STATES = [
    ('new', 'New'),
    ('in_progress', 'In Progress'),
    ('done', 'Done'),
    ('cancelled', 'Cancelled'),
]

REPORTER_ROLES = [
    ('order_booker', 'Order Booker'),
    ('delivery_man', 'Delivery Man'),
    ('other', 'Other'),
]

TAG_KINDS = [
    ('app_error', 'App Error'),
    ('field_activity', 'Field Activity'),
]


class ShahtajFieldReportTag(models.Model):
    _name = 'shahtaj.field.report.tag'
    _description = 'Field Report Tag'
    _order = 'kind, sequence, name, id'

    name = fields.Char(required=True, translate=True)
    code = fields.Char(
        string='Code',
        required=True,
        help='Stable API code (e.g. road_block, app_crash).',
    )
    kind = fields.Selection(TAG_KINDS, string='Kind', required=True, default='field_activity')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    color = fields.Integer(string='Color Index', default=0)

    _code_uniq = models.Constraint(
        'unique(code)',
        'Report tag code must be unique.',
    )


class ShahtajFieldReport(models.Model):
    _name = 'shahtaj.field.report'
    _description = 'Field / App Report'
    _order = 'create_date desc, id desc'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    name = fields.Char(
        string='Reference',
        required=True,
        copy=False,
        default=lambda self: _('New'),
        tracking=True,
    )
    subject = fields.Char(string='Subject', required=True, tracking=True)
    description = fields.Text(string='Details', required=True)
    state = fields.Selection(
        REPORT_STATES,
        string='Status',
        default='new',
        required=True,
        tracking=True,
        index=True,
    )
    tag_ids = fields.Many2many(
        'shahtaj.field.report.tag',
        'shahtaj_field_report_tag_rel',
        'report_id',
        'tag_id',
        string='Tags',
        required=True,
    )
    user_id = fields.Many2one(
        'res.users',
        string='Reported By',
        required=True,
        default=lambda self: self.env.user,
        index=True,
        tracking=True,
        ondelete='restrict',
    )
    reporter_role = fields.Selection(
        REPORTER_ROLES,
        string='Reporter Role',
        required=True,
        default='other',
        index=True,
    )
    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )
    screenshot = fields.Image(
        string='Screenshot / Capture',
        max_width=1920,
        max_height=1920,
    )
    has_screenshot = fields.Boolean(compute='_compute_has_screenshot')
    device_info = fields.Char(
        string='Device Info',
        help='Optional app/device string from the mobile client.',
    )
    closed_at = fields.Datetime(string='Closed At', readonly=True)
    closed_by_id = fields.Many2one('res.users', string='Closed By', readonly=True)
    closing_remark = fields.Text(
        string='Closing Remark',
        help='Short closing statement from office (distributor/admin) when the '
             'report is marked Done or Cancelled. Not the same as chatter notes.',
        tracking=True,
    )

    @api.depends('screenshot')
    def _compute_has_screenshot(self):
        for rec in self:
            rec.has_screenshot = bool(rec.screenshot)

    def _shahtaj_is_office_user(self):
        user = self.env.user
        return bool(
            user.has_group('shahtaj_oil.group_shahtaj_distributor')
            or user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui')
            or user.has_group('base.group_system')
        )

    def _shahtaj_resolve_reporter_role(self, user=None):
        user = user or self.env.user
        if user.shahtaj_is_delivery_man and user.has_group(
            'shahtaj_oil.group_shahtaj_delivery_man'
        ):
            return 'delivery_man'
        if user.shahtaj_is_order_booker and user.has_group(
            'shahtaj_oil.group_shahtaj_order_booker'
        ):
            return 'order_booker'
        return 'other'

    @api.model_create_multi
    def create(self, vals_list):
        Sequence = self.env['ir.sequence']
        for vals in vals_list:
            if vals.get('name', _('New')) in (False, _('New'), 'New'):
                vals['name'] = Sequence.next_by_code('shahtaj.field.report') or _('New')
            if not vals.get('user_id'):
                vals['user_id'] = self.env.uid
            if not vals.get('reporter_role'):
                vals['reporter_role'] = self._shahtaj_resolve_reporter_role()
            if not vals.get('company_id'):
                vals['company_id'] = self.env.company.id
        return super().create(vals_list)

    def write(self, vals):
        vals = dict(vals)
        if not self._shahtaj_is_office_user():
            blocked = {
                'state', 'user_id', 'company_id', 'closed_at', 'closed_by_id',
                'reporter_role', 'closing_remark',
            }
            dirty = blocked.intersection(vals)
            if dirty:
                raise AccessError(_(
                    'Only distributors or administrators can update report status / ownership.'
                ))
        if 'state' in vals:
            new_state = vals['state']
            if new_state in ('done', 'cancelled'):
                # Prefer remark from this write; else existing value on each record
                remark_in_vals = vals.get('closing_remark')
                for rec in self:
                    remark = (
                        (remark_in_vals if remark_in_vals is not None else rec.closing_remark)
                        or ''
                    ).strip()
                    if not remark:
                        raise UserError(_(
                            'Please enter a Closing Remark before closing this report '
                            '(what was done / why it was cancelled).'
                        ))
                if remark_in_vals is not None:
                    vals['closing_remark'] = remark_in_vals.strip()
                vals.setdefault('closed_at', fields.Datetime.now())
                vals.setdefault('closed_by_id', self.env.uid)
            elif new_state in ('new', 'in_progress'):
                vals['closed_at'] = False
                vals['closed_by_id'] = False
                # Clear so a new closing statement is required next time
                vals['closing_remark'] = False
        return super().write(vals)

    def action_mark_in_progress(self):
        self._shahtaj_assert_office()
        self.write({'state': 'in_progress'})
        return True

    def action_mark_done(self):
        self._shahtaj_assert_office()
        for rec in self:
            if not (rec.closing_remark or '').strip():
                raise UserError(_(
                    'Enter a Closing Remark on the report form, then click Mark Done.'
                ))
        self.write({'state': 'done'})
        return True

    def action_mark_cancelled(self):
        self._shahtaj_assert_office()
        for rec in self:
            if not (rec.closing_remark or '').strip():
                raise UserError(_(
                    'Enter a Closing Remark on the report form, then click Cancel.'
                ))
        self.write({'state': 'cancelled'})
        return True

    def action_reopen(self):
        self._shahtaj_assert_office()
        self.write({'state': 'in_progress'})
        return True

    def _shahtaj_assert_office(self):
        if not self._shahtaj_is_office_user():
            raise AccessError(_(
                'Only distributors or administrators can change report status.'
            ))

    # ── API helpers (used by OB / DM controllers) ─────────────────────

    @api.model
    def _shahtaj_api_tag_brief(self, tag):
        return {
            'tag_id': tag.id,
            'name': tag.name,
            'code': tag.code or '',
            'kind': tag.kind,
        }

    @api.model
    def shahtaj_api_list_tags(self):
        tags = self.env['shahtaj.field.report.tag'].search([('active', '=', True)])
        return {'tags': [self._shahtaj_api_tag_brief(t) for t in tags]}

    def _shahtaj_api_message_rows(self, limit=50):
        messages = self.message_ids.filtered(
            lambda m: m.message_type in ('comment', 'notification')
            and (m.body or m.attachment_ids)
        )[:limit]
        rows = []
        for msg in messages:
            rows.append({
                'message_id': msg.id,
                'date': msg.date.isoformat(sep=' ') if msg.date else False,
                'author': msg.author_id.name if msg.author_id else (
                    msg.create_uid.name if msg.create_uid else ''
                ),
                'author_user_id': msg.create_uid.id if msg.create_uid else False,
                'body': msg.body or '',
                'is_note': msg.is_internal,
            })
        return rows

    def shahtaj_api_report_dict(self, include_messages=False, include_screenshot=False):
        self.ensure_one()
        data = {
            'report_id': self.id,
            'name': self.name,
            'subject': self.subject,
            'description': self.description or '',
            'state': self.state,
            'tags': [self._shahtaj_api_tag_brief(t) for t in self.tag_ids],
            'reported_by': self.user_id.display_name,
            'reported_by_id': self.user_id.id,
            'reporter_role': self.reporter_role,
            'has_screenshot': bool(self.screenshot),
            'device_info': self.device_info or '',
            'create_date': self.create_date.isoformat(sep=' ') if self.create_date else False,
            'closed_at': self.closed_at.isoformat(sep=' ') if self.closed_at else False,
            'closing_remark': self.closing_remark or '',
        }
        if include_screenshot and self.screenshot:
            data['screenshot'] = self.screenshot.decode('utf-8') if isinstance(
                self.screenshot, bytes
            ) else self.screenshot
        if include_messages:
            data['messages'] = self._shahtaj_api_message_rows()
        return data

    @api.model
    def shahtaj_api_create_report(
        self,
        *,
        subject,
        description,
        tag_ids=None,
        tag_codes=None,
        screenshot=None,
        device_info='',
    ):
        subject = (subject or '').strip()
        description = (description or '').strip()
        if not subject:
            raise UserError(_('subject is required.'))
        if not description:
            raise UserError(_('description is required.'))

        Tag = self.env['shahtaj.field.report.tag']
        tags = Tag.browse()
        if tag_ids:
            tags = Tag.browse([int(x) for x in tag_ids]).exists()
        elif tag_codes:
            codes = [str(c).strip() for c in tag_codes if c]
            tags = Tag.search([('code', 'in', codes), ('active', '=', True)])
        if not tags:
            raise UserError(_('At least one valid tag is required (tag_ids or tag_codes).'))

        vals = {
            'subject': subject,
            'description': description,
            'tag_ids': [(6, 0, tags.ids)],
            'user_id': self.env.uid,
            'reporter_role': self._shahtaj_resolve_reporter_role(),
            'device_info': (device_info or '')[:255] or False,
        }
        if screenshot:
            image = normalize_image_b64(screenshot) if isinstance(screenshot, str) else screenshot
            if image:
                vals['screenshot'] = image

        report = self.create(vals)
        report.message_post(
            body=_('Report created from mobile app.'),
            message_type='notification',
            subtype_xmlid='mail.mt_note',
        )
        return report.shahtaj_api_report_dict(include_messages=True)

    @api.model
    def shahtaj_api_list_my_reports(self, state=None, limit=50, offset=0):
        """List reports for the logged-in OB/DM.

        Default (no state filter):
          - all open reports (new + in_progress)
          - last 3 completed/closed (done + cancelled)

        Optional state filter keeps the same response shape; for done/cancelled
        still returns at most the last 3. limit/offset are ignored for this
        curated inbox (API contract unchanged).
        """
        base = [('user_id', '=', self.env.uid)]
        open_order = 'create_date desc, id desc'
        closed_order = 'closed_at desc, create_date desc, id desc'

        if state in ('new', 'in_progress'):
            reports = self.search(base + [('state', '=', state)], order=open_order)
        elif state in ('done', 'cancelled'):
            reports = self.search(
                base + [('state', '=', state)],
                limit=3,
                order=closed_order,
            )
        else:
            open_reports = self.search(
                base + [('state', 'in', ('new', 'in_progress'))],
                order=open_order,
            )
            closed_reports = self.search(
                base + [('state', 'in', ('done', 'cancelled'))],
                limit=3,
                order=closed_order,
            )
            # Open first, then recent closed (preserve each search order)
            reports = open_reports + closed_reports

        return {
            'reports': [r.shahtaj_api_report_dict() for r in reports],
            'count': len(reports),
        }

    @api.model
    def shahtaj_api_get_report(self, report_id, include_screenshot=False):
        report = self.browse(int(report_id))
        if not report.exists():
            raise UserError(_('Report not found.'))
        # Record rules enforce own vs office visibility.
        report.check_access('read')
        return report.shahtaj_api_report_dict(
            include_messages=True,
            include_screenshot=bool(include_screenshot),
        )

    def shahtaj_api_reply(self, body, screenshot=None):
        self.ensure_one()
        self.check_access('read')
        text = (body or '').strip()
        if not text and not screenshot:
            raise UserError(_('Reply body or screenshot is required.'))
        attachment_ids = []
        if screenshot:
            image = normalize_image_b64(screenshot) if isinstance(screenshot, str) else screenshot
            if image:
                att = self.env['ir.attachment'].sudo().create({
                    'name': 'report_reply_%s.jpg' % self.id,
                    'type': 'binary',
                    'datas': image,
                    'res_model': self._name,
                    'res_id': self.id,
                    'mimetype': 'image/jpeg',
                })
                attachment_ids = att.ids
        self.message_post(
            body=text or _('(attachment)'),
            message_type='comment',
            subtype_xmlid='mail.mt_comment',
            attachment_ids=attachment_ids,
        )
        if self._shahtaj_is_office_user() and self.state == 'new':
            self.sudo().write({'state': 'in_progress'})
        return self.shahtaj_api_report_dict(include_messages=True)

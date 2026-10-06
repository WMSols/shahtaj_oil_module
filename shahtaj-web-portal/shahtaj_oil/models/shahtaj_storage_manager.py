# -*- coding: utf-8 -*-
"""Admin storage report, retention settings, and password-confirmed media purge."""
import logging
import os
import shutil
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import AccessDenied, AccessError, UserError
from odoo.http import request

_logger = logging.getLogger(__name__)

ICP_DELIVERY_DAYS = 'shahtaj.storage.retention.delivery_proof_days'
ICP_CHEQUE_DAYS = 'shahtaj.storage.retention.cheque_image_days'
ICP_FIELD_REPORT_DAYS = 'shahtaj.storage.retention.field_report_days'
ICP_ACTIVITY_DAYS = 'shahtaj.storage.retention.activity_log_days'
ICP_AUTO_PURGE = 'shahtaj.storage.auto_purge_enabled'

DEFAULT_DELIVERY_DAYS = 90
DEFAULT_CHEQUE_DAYS = 180
DEFAULT_FIELD_REPORT_DAYS = 90
DEFAULT_ACTIVITY_DAYS = 2
MAX_PASSWORD_ATTEMPTS = 2
SESSION_FAIL_KEY = 'shahtaj_storage_purge_fails'

PURGEABLE_CATEGORIES = (
    'delivery_proof',
    'cheque_photos',
    'field_report_screenshots',
    'activity_logs',
)

PHOTO_CATEGORIES = {
    'shop_photos': {
        'label': 'Shop photos (ID / shop front)',
        'protected': True,
        'help': 'Kept while the shop exists. Not deleted by cleanup.',
        'fields': [
            ('res.partner', 'shop_exterior_photo'),
            ('res.partner', 'owner_photo'),
            ('res.partner', 'owner_cnic_front'),
            ('res.partner', 'owner_cnic_back'),
        ],
    },
    'delivery_proof': {
        'label': 'Delivery photos',
        'protected': False,
        'help': 'Handoff proof and shop-closed photos from delivery stops.',
        'fields': [
            ('shahtaj.dm.delivery', 'delivery_proof_image'),
            ('shahtaj.dm.delivery', 'shop_closed_image'),
            ('stock.picking', 'shahtaj_delivery_proof_image'),
        ],
        'date_field': {
            'shahtaj.dm.delivery': 'write_date',
            'stock.picking': 'write_date',
        },
        'retention_icp': ICP_DELIVERY_DAYS,
        'retention_default': DEFAULT_DELIVERY_DAYS,
    },
    'cheque_photos': {
        'label': 'Cheque photos',
        'protected': False,
        'help': 'Photos of cheques collected by delivery men.',
        'fields': [
            ('account.payment', 'shahtaj_cheque_image'),
        ],
        'date_field': {
            'account.payment': 'date',
        },
        'retention_icp': ICP_CHEQUE_DAYS,
        'retention_default': DEFAULT_CHEQUE_DAYS,
    },
    'field_report_screenshots': {
        'label': 'App / field report screenshots',
        'protected': False,
        'help': 'Screenshots from field issue reports.',
        'fields': [
            ('shahtaj.field.report', 'screenshot'),
        ],
        'date_field': {
            'shahtaj.field.report': 'create_date',
        },
        'retention_icp': ICP_FIELD_REPORT_DAYS,
        'retention_default': DEFAULT_FIELD_REPORT_DAYS,
    },
}


def _human_bytes(num):
    try:
        num = float(num or 0)
    except (TypeError, ValueError):
        num = 0.0
    units = ('B', 'KB', 'MB', 'GB', 'TB')
    idx = 0
    while num >= 1024.0 and idx < len(units) - 1:
        num /= 1024.0
        idx += 1
    if idx == 0:
        return f'{int(num)} {units[idx]}'
    return f'{num:.1f} {units[idx]}'


class ShahtajStorageManager(models.AbstractModel):
    _name = 'shahtaj.storage.manager'
    _description = 'Shahtaj Storage & Retention Manager'

    def _ensure_admin(self):
        user = self.env.user
        if not user or user._is_public() or not user.has_group('base.group_system'):
            raise AccessError(_('Only administrators can manage storage.'))
        return user

    def _icp_int(self, key, default):
        raw = self.env['ir.config_parameter'].sudo().get_param(key, str(default))
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = default
        return max(0, value)

    def _icp_bool(self, key, default=False):
        raw = self.env['ir.config_parameter'].sudo().get_param(
            key, 'True' if default else 'False',
        )
        return str(raw).lower() in ('1', 'true', 'yes', 'on')

    @api.model
    def get_retention_rules(self):
        self._ensure_admin()
        return {
            'delivery_proof_days': self._icp_int(ICP_DELIVERY_DAYS, DEFAULT_DELIVERY_DAYS),
            'cheque_image_days': self._icp_int(ICP_CHEQUE_DAYS, DEFAULT_CHEQUE_DAYS),
            'field_report_days': self._icp_int(ICP_FIELD_REPORT_DAYS, DEFAULT_FIELD_REPORT_DAYS),
            'activity_log_days': self._icp_int(ICP_ACTIVITY_DAYS, DEFAULT_ACTIVITY_DAYS),
            'auto_purge_enabled': self._icp_bool(ICP_AUTO_PURGE, False),
            'shop_photos_policy': 'lifetime',
        }

    @api.model
    def set_retention_rules(self, values):
        self._ensure_admin()
        values = values or {}
        ICP = self.env['ir.config_parameter'].sudo()
        mapping = {
            'delivery_proof_days': (ICP_DELIVERY_DAYS, 1, 3650),
            'cheque_image_days': (ICP_CHEQUE_DAYS, 1, 3650),
            'field_report_days': (ICP_FIELD_REPORT_DAYS, 1, 3650),
            'activity_log_days': (ICP_ACTIVITY_DAYS, 1, 365),
        }
        saved = {}
        for key, (icp_key, lo, hi) in mapping.items():
            if key not in values:
                continue
            try:
                days = int(values[key])
            except (TypeError, ValueError) as err:
                raise UserError(_('Invalid number of days.')) from err
            if days < lo or days > hi:
                raise UserError(_('Days must be between %(lo)s and %(hi)s.', lo=lo, hi=hi))
            ICP.set_param(icp_key, str(days))
            saved[key] = days
        if 'auto_purge_enabled' in values:
            enabled = bool(values.get('auto_purge_enabled'))
            ICP.set_param(ICP_AUTO_PURGE, 'True' if enabled else 'False')
            saved['auto_purge_enabled'] = enabled
        try:
            self.env['shahtaj.activity.log'].sudo().log_business(
                operation='settings.storage_retention',
                name=_('Storage retention updated'),
                message=str(saved),
            )
        except Exception:
            pass
        return self.get_retention_rules()

    def _filestore_path(self):
        return self.env['ir.attachment']._filestore()

    def _database_report(self):
        """Postgres DB size + attachment split (files on disk vs bytes in DB)."""
        cr = self.env.cr
        db_name = cr.dbname
        db_bytes = 0
        try:
            cr.execute('SELECT pg_database_size(current_database())')
            db_bytes = int((cr.fetchone() or (0,))[0] or 0)
        except Exception:
            _logger.exception('Could not read pg_database_size')

        # Tracked attachment footprint (fast index scan — no filestore walk)
        filestore_att_bytes = 0
        filestore_att_count = 0
        db_att_bytes = 0
        db_att_count = 0
        try:
            cr.execute(
                """
                SELECT
                    COALESCE(SUM(file_size) FILTER (WHERE store_fname IS NOT NULL AND store_fname != ''), 0),
                    COUNT(*) FILTER (WHERE store_fname IS NOT NULL AND store_fname != ''),
                    COALESCE(SUM(file_size) FILTER (WHERE store_fname IS NULL OR store_fname = ''), 0),
                    COUNT(*) FILTER (WHERE store_fname IS NULL OR store_fname = '')
                  FROM ir_attachment
                """
            )
            row = cr.fetchone() or (0, 0, 0, 0)
            filestore_att_bytes = int(row[0] or 0)
            filestore_att_count = int(row[1] or 0)
            db_att_bytes = int(row[2] or 0)
            db_att_count = int(row[3] or 0)
        except Exception:
            # Older PG without FILTER — fallback
            cr.execute(
                """
                SELECT
                    COALESCE(SUM(CASE WHEN store_fname IS NOT NULL AND store_fname != ''
                                      THEN file_size ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN store_fname IS NOT NULL AND store_fname != ''
                                      THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN store_fname IS NULL OR store_fname = ''
                                      THEN file_size ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN store_fname IS NULL OR store_fname = ''
                                      THEN 1 ELSE 0 END), 0)
                  FROM ir_attachment
                """
            )
            row = cr.fetchone() or (0, 0, 0, 0)
            filestore_att_bytes = int(row[0] or 0)
            filestore_att_count = int(row[1] or 0)
            db_att_bytes = int(row[2] or 0)
            db_att_count = int(row[3] or 0)

        # Textual / structured data ≈ whole DB minus attachment blobs stored inside Postgres
        text_bytes = max(0, db_bytes - db_att_bytes)
        return {
            'db_name': db_name,
            'db_total_bytes': db_bytes,
            'db_total_human': _human_bytes(db_bytes),
            'db_text_bytes': text_bytes,
            'db_text_human': _human_bytes(text_bytes),
            'db_files_bytes': db_att_bytes,
            'db_files_human': _human_bytes(db_att_bytes),
            'db_files_count': db_att_count,
            'filestore_files_bytes': filestore_att_bytes,
            'filestore_files_human': _human_bytes(filestore_att_bytes),
            'filestore_files_count': filestore_att_count,
            'all_files_bytes': filestore_att_bytes + db_att_bytes,
            'all_files_human': _human_bytes(filestore_att_bytes + db_att_bytes),
            'all_files_count': filestore_att_count + db_att_count,
        }

    def _disk_report(self):
        """Server volume free space + filestore path (no slow folder walk)."""
        path = self._filestore_path()
        report = {
            'filestore_path': path or '—',
            'filestore_exists': bool(path and os.path.isdir(path)),
            'disk_total_bytes': 0,
            'disk_used_bytes': 0,
            'disk_free_bytes': 0,
            'disk_total_human': '—',
            'disk_used_human': '—',
            'disk_free_human': '—',
            'disk_used_pct': 0.0,
        }
        probe = path if report['filestore_exists'] else os.getcwd()
        try:
            usage = shutil.disk_usage(probe)
            report['disk_total_bytes'] = usage.total
            report['disk_used_bytes'] = usage.used
            report['disk_free_bytes'] = usage.free
            report['disk_total_human'] = _human_bytes(usage.total)
            report['disk_used_human'] = _human_bytes(usage.used)
            report['disk_free_human'] = _human_bytes(usage.free)
            report['disk_used_pct'] = round(
                (100.0 * usage.used / usage.total) if usage.total else 0.0, 1,
            )
        except OSError:
            pass
        return report

    def _attachment_stats_for_fields(self, field_specs):
        """Sum ir.attachment rows for (model, field) — exact field only."""
        total_count = 0
        total_bytes = 0
        per_field = []
        for model_name, field_name in field_specs:
            count, size = self._attachment_total_for_field(model_name, field_name)
            total_count += count
            total_bytes += size
            per_field.append({
                'model': model_name,
                'field': field_name,
                'count': count,
                'bytes': size,
                'human': _human_bytes(size),
            })
        return {
            'count': total_count,
            'bytes': total_bytes,
            'human': _human_bytes(total_bytes),
            'fields': per_field,
        }

    def _activity_log_stats(self):
        count = self.env['shahtaj.activity.log'].sudo().search_count([])
        return {'count': count, 'bytes': 0, 'human': f'{count:,} rows', 'fields': []}

    @api.model
    def get_storage_report(self):
        self._ensure_admin()
        retention = self.get_retention_rules()
        categories = []
        photo_bytes = 0
        photo_count = 0
        for key, meta in PHOTO_CATEGORIES.items():
            stats = self._attachment_stats_for_fields(meta['fields'])
            photo_bytes += stats['bytes']
            photo_count += stats['count']
            ret_days = None
            if meta.get('retention_icp'):
                ret_days = self._icp_int(meta['retention_icp'], meta['retention_default'])
            categories.append({
                'id': key,
                'label': meta['label'],
                'protected': meta['protected'],
                'help': meta['help'],
                'purgeable': key in PURGEABLE_CATEGORIES,
                'retention_days': ret_days,
                'count': stats['count'],
                'bytes': stats['bytes'],
                'human': stats['human'],
                'fields': stats['fields'],
            })
        activity = self._activity_log_stats()
        categories.append({
            'id': 'activity_logs',
            'label': 'Activity logs',
            'protected': False,
            'help': 'Short debug / audit text logs. Safe to clear when old.',
            'purgeable': True,
            'retention_days': retention['activity_log_days'],
            'count': activity['count'],
            'bytes': 0,
            'human': activity['human'],
            'fields': [],
        })
        disk = self._disk_report()
        database = self._database_report()
        # Prefer SQL filestore total (fast) over walking the folder
        disk['filestore_bytes'] = database['filestore_files_bytes']
        disk['filestore_human'] = database['filestore_files_human']
        return {
            'generated_at': fields.Datetime.to_string(fields.Datetime.now()),
            'disk': disk,
            'database': database,
            'totals': {
                'tracked_photo_count': photo_count,
                'tracked_photo_bytes': photo_bytes,
                'tracked_photo_human': _human_bytes(photo_bytes),
                'activity_log_rows': activity['count'],
            },
            'categories': categories,
            'retention': retention,
            'purgeable_categories': list(PURGEABLE_CATEGORIES),
            'password_attempts_max': MAX_PASSWORD_ATTEMPTS,
            'current_admin': {
                'id': self.env.user.id,
                'login': self.env.user.login,
                'name': self.env.user.name,
            },
        }

    def _cutoff(self, days):
        days = max(int(days or 0), 0)
        return fields.Datetime.now() - timedelta(days=days)

    def _date_field_for(self, model_name, category_id):
        meta = PHOTO_CATEGORIES.get(category_id) or {}
        date_field = (meta.get('date_field') or {}).get(model_name, 'write_date')
        Model = self.env[model_name]
        if date_field not in Model._fields:
            date_field = 'write_date' if 'write_date' in Model._fields else 'create_date'
        return date_field

    def _attachment_total_for_field(self, model_name, field_name):
        """All photos for field (exact res_field only — no resized variants)."""
        self.env.cr.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(file_size), 0)
              FROM ir_attachment
             WHERE res_model = %s
               AND res_field = %s
            """,
            [model_name, field_name],
        )
        row = self.env.cr.fetchone() or (0, 0)
        return int(row[0] or 0), int(row[1] or 0)

    def _fast_field_stats(self, model_name, field_name, cutoff):
        """Eligible photos by attachment age (when the photo was stored).

        Uses ir_attachment.create_date — more accurate than record write_date
        (which can move when unrelated fields are saved).
        """
        self.env.cr.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(file_size), 0)
              FROM ir_attachment
             WHERE res_model = %s
               AND res_field = %s
               AND create_date < %s
            """,
            [model_name, field_name, cutoff],
        )
        row = self.env.cr.fetchone() or (0, 0)
        return int(row[0] or 0), int(row[1] or 0)

    def _record_ids_for_photo_purge(self, model_name, field_name, cutoff):
        """Record ids whose photo attachment is older than cutoff."""
        self.env.cr.execute(
            """
            SELECT DISTINCT res_id
              FROM ir_attachment
             WHERE res_model = %s
               AND res_field = %s
               AND create_date < %s
               AND res_id IS NOT NULL
            """,
            [model_name, field_name, cutoff],
        )
        return [int(r[0]) for r in self.env.cr.fetchall() if r and r[0]]

    def _records_for_photo_purge(self, category_id, older_than_days):
        meta = PHOTO_CATEGORIES.get(category_id)
        if not meta or meta.get('protected'):
            raise UserError(_('This type cannot be deleted by cleanup.'))
        cutoff = self._cutoff(older_than_days)
        result = []
        for model_name, field_name in meta['fields']:
            if model_name not in self.env:
                continue
            ids = self._record_ids_for_photo_purge(model_name, field_name, cutoff)
            if not ids:
                continue
            recs = self.env[model_name].sudo().browse(ids).exists()
            if recs:
                result.append((model_name, field_name, recs))
        return result, cutoff

    @api.model
    def preview_purge_plan(self, category_id, older_than_days=None):
        """Return step list so the UI can show live progress."""
        self._ensure_admin()
        try:
            request.session[SESSION_FAIL_KEY] = 0
        except Exception:
            pass
        category_id = (category_id or '').strip()
        if category_id not in PURGEABLE_CATEGORIES:
            raise UserError(_('Unknown or protected type.'))

        if category_id == 'activity_logs':
            days = int(
                older_than_days
                if older_than_days is not None
                else self._icp_int(ICP_ACTIVITY_DAYS, DEFAULT_ACTIVITY_DAYS)
            )
            cutoff = self._cutoff(days)
            total_rows = self.env['shahtaj.activity.log'].sudo().search_count([])
            return {
                'category': category_id,
                'older_than_days': days,
                'cutoff': fields.Datetime.to_string(cutoff),
                'total_steps': 1,
                'total_in_category': total_rows,
                'steps': [{
                    'index': 0,
                    'key': 'activity_logs',
                    'label': 'Scanning activity logs',
                }],
            }

        meta = PHOTO_CATEGORIES[category_id]
        days = int(
            older_than_days
            if older_than_days is not None
            else self._icp_int(meta['retention_icp'], meta['retention_default'])
        )
        cutoff = self._cutoff(days)
        steps = []
        total_in_category = 0
        for idx, (model_name, field_name) in enumerate(meta['fields']):
            tot_c, _tot_b = self._attachment_total_for_field(model_name, field_name)
            total_in_category += tot_c
            short_model = model_name.split('.')[-1]
            steps.append({
                'index': idx,
                'key': f'{model_name}:{field_name}',
                'label': f'{short_model} / {field_name}',
                'model': model_name,
                'field': field_name,
                'total_in_field': tot_c,
            })
        return {
            'category': category_id,
            'older_than_days': days,
            'cutoff': fields.Datetime.to_string(cutoff),
            'total_steps': len(steps),
            'total_in_category': total_in_category,
            'steps': steps,
        }

    @api.model
    def preview_purge_step(self, category_id, older_than_days, step_index=0):
        """Run one preview step; UI calls this in a loop for live status."""
        self._ensure_admin()
        category_id = (category_id or '').strip()
        days = int(
            older_than_days
            if older_than_days is not None
            else 0
        )
        plan = self.preview_purge_plan(category_id, days)
        days = plan['older_than_days']
        total = plan['total_steps'] or 1
        step_index = int(step_index or 0)
        if step_index < 0 or step_index >= total:
            raise UserError(_('Invalid preview step.'))

        if category_id == 'activity_logs':
            cutoff = self._cutoff(days)
            count = self.env['shahtaj.activity.log'].sudo().search_count(
                [('event_at', '<', cutoff)],
            )
            total_rows = plan.get('total_in_category') or 0
            return {
                'step_index': 0,
                'total_steps': 1,
                'pct': 100,
                'label': 'Activity logs',
                'message': (
                    f'{count:,} of {total_rows:,} log rows are older than {days} days'
                ),
                'step_record_count': count,
                'step_bytes': 0,
                'step_total_in_field': total_rows,
                'done': True,
                'category': category_id,
                'older_than_days': days,
                'cutoff': fields.Datetime.to_string(cutoff),
                'record_count': count,
                'total_in_category': total_rows,
                'estimated_bytes': 0,
                'estimated_human': f'{count:,} log rows',
                'protected': False,
            }

        step = plan['steps'][step_index]
        model_name = step['model']
        field_name = step['field']
        cutoff = self._cutoff(days)
        count, size = self._fast_field_stats(model_name, field_name, cutoff)
        field_total = step.get('total_in_field') or 0
        pct = int(round(100.0 * (step_index + 1) / total))
        done = step_index >= total - 1
        return {
            'step_index': step_index,
            'total_steps': total,
            'pct': pct,
            'label': step['label'],
            'message': (
                f'{step["label"]}: {count:,} eligible of {field_total:,} · {_human_bytes(size)}'
            ),
            'step_record_count': count,
            'step_bytes': size,
            'step_total_in_field': field_total,
            'done': done,
            'category': category_id,
            'older_than_days': days,
            'cutoff': plan['cutoff'],
            'total_in_category': plan.get('total_in_category') or 0,
            'model': model_name,
            'field': field_name,
        }

    @api.model
    def preview_purge(self, category_id, older_than_days=None):
        """Full preview (also used by execute). Uses photo attachment age."""
        self._ensure_admin()
        try:
            request.session[SESSION_FAIL_KEY] = 0
        except Exception:
            pass
        category_id = (category_id or '').strip()
        if category_id not in PURGEABLE_CATEGORIES:
            raise UserError(_('Unknown or protected type.'))

        plan = self.preview_purge_plan(category_id, older_than_days)
        days = plan['older_than_days']
        if category_id == 'activity_logs':
            step = self.preview_purge_step(category_id, days, 0)
            return {
                'category': category_id,
                'older_than_days': days,
                'cutoff': step['cutoff'],
                'record_count': step['record_count'],
                'total_in_category': step.get('total_in_category') or 0,
                'estimated_bytes': 0,
                'estimated_human': step['estimated_human'],
                'protected': False,
                'summary': step['message'],
            }

        total_count = 0
        total_bytes = 0
        for step in plan['steps']:
            res = self.preview_purge_step(category_id, days, step['index'])
            total_count += res['step_record_count']
            total_bytes += res['step_bytes']
        total_all = plan.get('total_in_category') or 0
        summary = (
            f'{total_count:,} of {total_all:,} photos are older than {days} days'
            if total_all
            else f'{total_count:,} photos older than {days} days'
        )
        if total_all and not total_count:
            summary += ' — nothing to clean yet (photos are still within keep period)'
        return {
            'category': category_id,
            'older_than_days': days,
            'cutoff': plan['cutoff'],
            'record_count': total_count,
            'total_in_category': total_all,
            'estimated_bytes': total_bytes,
            'estimated_human': _human_bytes(total_bytes),
            'protected': False,
            'summary': summary,
        }

    def _record_display_name(self, model_name, rec):
        try:
            if model_name == 'res.partner':
                return rec.display_name or rec.name or f'Shop #{rec.id}'
            if model_name == 'account.payment':
                return rec.name or f'Payment #{rec.id}'
            if model_name == 'shahtaj.dm.delivery':
                shop = rec.shop_id.display_name if getattr(rec, 'shop_id', False) else ''
                return f'{rec.display_name or rec.name or rec.id}' + (f' · {shop}' if shop else '')
            if model_name == 'stock.picking':
                return rec.name or f'Picking #{rec.id}'
            if model_name == 'shahtaj.field.report':
                return rec.name or f'Report #{rec.id}'
            return rec.display_name or f'{model_name} #{rec.id}'
        except Exception:
            return f'{model_name} #{rec.id}'

    @api.model
    def explorer_folders(self):
        """Folder list for image explorer."""
        self._ensure_admin()
        folders = []
        for key, meta in PHOTO_CATEGORIES.items():
            stats = self._attachment_stats_for_fields(meta['fields'])
            folders.append({
                'id': key,
                'label': meta['label'],
                'protected': meta['protected'],
                'help': meta['help'],
                'count': stats['count'],
                'bytes': stats['bytes'],
                'human': stats['human'],
                'can_delete': True,  # select-delete allowed; shop warns in UI
            })
        return {'folders': folders}

    @api.model
    def explorer_list(self, category_id, offset=0, limit=36, q=''):
        """Paginated images in a folder (category)."""
        self._ensure_admin()
        category_id = (category_id or '').strip()
        meta = PHOTO_CATEGORIES.get(category_id)
        if not meta:
            raise UserError(_('Unknown folder.'))
        offset = max(int(offset or 0), 0)
        limit = min(max(int(limit or 36), 1), 80)
        q = (q or '').strip()

        # Collect lightweight rows across fields, then page in Python
        # (keeps folder UX simple across multi-model categories)
        rows = []
        for model_name, field_name in meta['fields']:
            if model_name not in self.env:
                continue
            Model = self.env[model_name].sudo()
            domain = [(field_name, '!=', False)]
            if q:
                name_field = 'name' if 'name' in Model._fields else 'display_name'
                if name_field in Model._fields:
                    domain = ['&'] + domain + [(name_field, 'ilike', q)]
            date_field = self._date_field_for(model_name, category_id)
            order = f'{date_field} desc, id desc'
            recs = Model.search(domain, limit=500, order=order)
            # sizes for these ids
            size_map = {}
            if recs:
                self.env.cr.execute(
                    """
                    SELECT res_id, COALESCE(SUM(file_size), 0)
                      FROM ir_attachment
                     WHERE res_model = %s
                       AND res_id = ANY(%s)
                       AND res_field = %s
                     GROUP BY res_id
                    """,
                    [model_name, list(recs.ids), field_name],
                )
                size_map = {int(r[0]): int(r[1] or 0) for r in self.env.cr.fetchall()}
            for rec in recs:
                date_val = rec[date_field] if date_field in rec._fields else False
                rows.append({
                    'model': model_name,
                    'res_id': rec.id,
                    'field': field_name,
                    'name': self._record_display_name(model_name, rec),
                    'date': fields.Datetime.to_string(date_val) if date_val else '',
                    'bytes': size_map.get(rec.id, 0),
                    'human': _human_bytes(size_map.get(rec.id, 0)),
                    'thumb_url': f'/web/image?model={model_name}&id={rec.id}&field={field_name}',
                    'key': f'{model_name}:{rec.id}:{field_name}',
                })

        rows.sort(key=lambda r: r.get('date') or '', reverse=True)
        total = len(rows)
        page = rows[offset:offset + limit]
        return {
            'category': category_id,
            'label': meta['label'],
            'protected': meta['protected'],
            'total': total,
            'offset': offset,
            'limit': limit,
            'items': page,
        }

    @api.model
    def explorer_delete_selected(self, items, admin_password='', confirm_text=''):
        """Delete selected images (clear image fields). Password required."""
        self._ensure_admin()
        if (confirm_text or '').strip().upper() != 'DELETE':
            raise UserError(_('Type DELETE to confirm.'))
        admin = self._verify_admin_password(admin_password)
        items = items or []
        if not items:
            raise UserError(_('No images selected.'))
        if len(items) > 200:
            raise UserError(_('Select at most 200 images at a time.'))

        allowed = set()
        for meta in PHOTO_CATEGORIES.values():
            for model_name, field_name in meta['fields']:
                allowed.add((model_name, field_name))

        cleared = 0
        for raw in items:
            model_name = (raw.get('model') or '').strip()
            field_name = (raw.get('field') or '').strip()
            res_id = int(raw.get('res_id') or 0)
            if not res_id or (model_name, field_name) not in allowed:
                continue
            if model_name not in self.env:
                continue
            rec = self.env[model_name].sudo().browse(res_id)
            if not rec.exists():
                continue
            if field_name not in rec._fields:
                continue
            if rec[field_name]:
                rec.write({field_name: False})
                cleared += 1

        self.env['shahtaj.storage.purge.log'].sudo().create({
            'category': 'explorer_selected',
            'older_than_days': 0,
            'records_cleared': cleared,
            'estimated_bytes': 0,
            'admin1_id': admin.id,
            'requested_by_id': self.env.user.id,
            'notes': f'selected delete ×{cleared}',
        })
        return {
            'ok': True,
            'records_cleared': cleared,
            'folders': self.explorer_folders().get('folders'),
        }

    def _password_attempts_state(self):
        try:
            fails = int(request.session.get(SESSION_FAIL_KEY) or 0)
        except Exception:
            fails = 0
        left = max(0, MAX_PASSWORD_ATTEMPTS - fails)
        return fails, left

    def _verify_admin_password(self, password):
        """Check signed-in admin password. Tracks up to 2 failed attempts."""
        fails, left = self._password_attempts_state()
        if left <= 0:
            raise UserError(_(
                'Too many wrong passwords. Click Check again, then try delete once more.'
            ))
        if not password:
            raise UserError(_('Enter your admin password.'))
        try:
            self.env['res.users'].sudo()._check_uid_passwd(self.env.uid, password)
        except AccessDenied:
            fails += 1
            try:
                request.session[SESSION_FAIL_KEY] = fails
            except Exception:
                pass
            left = max(0, MAX_PASSWORD_ATTEMPTS - fails)
            if left <= 0:
                raise UserError(_(
                    'Wrong password. No attempts left. Click Check again to retry.'
                ))
            raise UserError(_(
                'Wrong password. %(left)s attempt(s) left.',
                left=left,
            ))
        try:
            request.session[SESSION_FAIL_KEY] = 0
        except Exception:
            pass
        return self.env.user

    @api.model
    def execute_purge(self, category_id, older_than_days, admin_password='', confirm_text=''):
        """Password-confirmed purge (current admin; max 2 wrong attempts)."""
        self._ensure_admin()
        category_id = (category_id or '').strip()
        if category_id not in PURGEABLE_CATEGORIES:
            raise UserError(_('This type cannot be deleted by cleanup.'))
        if (confirm_text or '').strip().upper() != 'DELETE':
            raise UserError(_('Type DELETE to confirm.'))

        admin = self._verify_admin_password(admin_password)
        preview = self.preview_purge(category_id, older_than_days)
        cleared = 0

        if category_id == 'activity_logs':
            cutoff = self._cutoff(int(older_than_days))
            Log = self.env['shahtaj.activity.log'].sudo()
            while True:
                batch = Log.search(
                    [('event_at', '<', cutoff)],
                    limit=2000,
                    order='event_at asc, id asc',
                )
                if not batch:
                    break
                cleared += len(batch)
                batch.unlink()
        else:
            pairs, _cutoff = self._records_for_photo_purge(category_id, int(older_than_days))
            for _model_name, field_name, recs in pairs:
                for chunk_start in range(0, len(recs), 200):
                    chunk = recs[chunk_start:chunk_start + 200]
                    chunk.write({field_name: False})
                    cleared += len(chunk)

        self.env['shahtaj.storage.purge.log'].sudo().create({
            'category': category_id,
            'older_than_days': int(older_than_days),
            'records_cleared': cleared,
            'estimated_bytes': preview.get('estimated_bytes') or 0,
            'admin1_id': admin.id,
            'admin2_id': False,
            'requested_by_id': self.env.user.id,
            'notes': preview.get('estimated_human') or '',
        })
        try:
            self.env['shahtaj.activity.log'].sudo().log_business(
                operation='settings.storage_purge',
                name=_('Storage purge: %s', category_id),
                message=_(
                    'Cleared %(n)s · type=%(cat)s · older_than=%(d)s days · by %(a)s',
                    n=cleared,
                    cat=category_id,
                    d=older_than_days,
                    a=admin.login,
                ),
            )
        except Exception:
            pass
        _logger.warning(
            'Shahtaj storage purge category=%s cleared=%s by %s',
            category_id, cleared, admin.login,
        )
        return {
            'ok': True,
            'category': category_id,
            'records_cleared': cleared,
            'preview': preview,
            'report': self.get_storage_report(),
        }

    @api.model
    def _cron_auto_purge_media(self):
        if not self._icp_bool(ICP_AUTO_PURGE, False):
            return True
        for category_id in ('delivery_proof', 'cheque_photos', 'field_report_screenshots'):
            meta = PHOTO_CATEGORIES[category_id]
            days = self._icp_int(meta['retention_icp'], meta['retention_default'])
            try:
                pairs, _cutoff = self._records_for_photo_purge(category_id, days)
                cleared = 0
                for _m, field_name, recs in pairs:
                    for chunk_start in range(0, len(recs), 200):
                        chunk = recs[chunk_start:chunk_start + 200]
                        chunk.write({field_name: False})
                        cleared += len(chunk)
                if cleared:
                    _logger.info(
                        'Auto-purge %s cleared %s records older than %s days',
                        category_id, cleared, days,
                    )
                    self.env['shahtaj.storage.purge.log'].sudo().create({
                        'category': category_id,
                        'older_than_days': days,
                        'records_cleared': cleared,
                        'estimated_bytes': 0,
                        'notes': 'cron auto-purge',
                        'is_auto': True,
                    })
            except Exception:
                _logger.exception('Auto-purge failed for %s', category_id)
        return True


class ShahtajStoragePurgeLog(models.Model):
    _name = 'shahtaj.storage.purge.log'
    _description = 'Shahtaj Storage Purge Audit'
    _order = 'create_date desc, id desc'

    category = fields.Char(required=True, index=True)
    older_than_days = fields.Integer(required=True)
    records_cleared = fields.Integer(default=0)
    estimated_bytes = fields.Integer(default=0)
    admin1_id = fields.Many2one('res.users', string='Confirmed By', ondelete='set null')
    admin2_id = fields.Many2one('res.users', string='Admin 2', ondelete='set null')
    requested_by_id = fields.Many2one('res.users', string='Requested By', ondelete='set null')
    notes = fields.Char()
    is_auto = fields.Boolean(string='Auto Cron', default=False)

    @api.model
    def _cron_auto_purge_media(self):
        return self.env['shahtaj.storage.manager']._cron_auto_purge_media()

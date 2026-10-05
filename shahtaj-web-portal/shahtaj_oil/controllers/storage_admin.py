# -*- coding: utf-8 -*-
"""Admin-only Storage & Retention dashboard (HTML + JSON)."""
from odoo import _, http
from odoo.exceptions import AccessError, UserError
from odoo.http import request
from odoo.tools.misc import file_path


class ShahtajStorageController(http.Controller):

    def _ensure_admin(self):
        user = request.env.user
        if not user or user._is_public() or not user.has_group('base.group_system'):
            raise AccessError(_('Only administrators can open Storage.'))
        return user

    def _manager(self):
        return request.env['shahtaj.storage.manager']

    @http.route(
        '/shahtaj/storage',
        type='http',
        auth='user',
        methods=['GET'],
        csrf=False,
    )
    def storage_index(self, **kwargs):
        self._ensure_admin()
        try:
            path = file_path('shahtaj_oil/static/src/storage_admin/index.html')
        except (FileNotFoundError, ValueError):
            return request.make_response(
                'Storage page missing.',
                headers=[('Content-Type', 'text/plain')],
                status=404,
            )
        with open(path, 'r', encoding='utf-8') as handle:
            html = handle.read()
        return request.make_response(
            html,
            headers=[
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Cache-Control', 'no-store'),
            ],
        )

    @http.route(
        '/shahtaj/storage/report',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def storage_report(self, **kwargs):
        self._ensure_admin()
        return self._manager().get_storage_report()

    @http.route(
        '/shahtaj/storage/retention/set',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def retention_set(self, values=None, **kwargs):
        self._ensure_admin()
        return self._manager().set_retention_rules(values or kwargs.get('values') or {})

    @http.route(
        '/shahtaj/storage/purge/preview',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def purge_preview(self, category_id=None, older_than_days=None, **kwargs):
        self._ensure_admin()
        return self._manager().preview_purge(
            category_id or kwargs.get('category_id'),
            older_than_days if older_than_days is not None else kwargs.get('older_than_days'),
        )

    @http.route(
        '/shahtaj/storage/purge/preview_plan',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def purge_preview_plan(self, category_id=None, older_than_days=None, **kwargs):
        self._ensure_admin()
        return self._manager().preview_purge_plan(
            category_id or kwargs.get('category_id'),
            older_than_days if older_than_days is not None else kwargs.get('older_than_days'),
        )

    @http.route(
        '/shahtaj/storage/purge/preview_step',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def purge_preview_step(
        self, category_id=None, older_than_days=None, step_index=0, **kwargs,
    ):
        self._ensure_admin()
        return self._manager().preview_purge_step(
            category_id or kwargs.get('category_id'),
            older_than_days if older_than_days is not None else kwargs.get('older_than_days'),
            step_index if step_index is not None else kwargs.get('step_index', 0),
        )

    @http.route(
        '/shahtaj/storage/explorer/folders',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def explorer_folders(self, **kwargs):
        self._ensure_admin()
        return self._manager().explorer_folders()

    @http.route(
        '/shahtaj/storage/explorer/list',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def explorer_list(self, category_id=None, offset=0, limit=36, q='', **kwargs):
        self._ensure_admin()
        return self._manager().explorer_list(
            category_id or kwargs.get('category_id'),
            offset=offset if offset is not None else kwargs.get('offset', 0),
            limit=limit if limit is not None else kwargs.get('limit', 36),
            q=q if q is not None else kwargs.get('q', ''),
        )

    @http.route(
        '/shahtaj/storage/explorer/delete',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def explorer_delete(
        self,
        items=None,
        admin_password=None,
        confirm_text=None,
        **kwargs,
    ):
        self._ensure_admin()
        try:
            return self._manager().explorer_delete_selected(
                items=items or kwargs.get('items') or [],
                admin_password=admin_password or kwargs.get('admin_password') or '',
                confirm_text=confirm_text or kwargs.get('confirm_text') or '',
            )
        except UserError as err:
            return {'ok': False, 'error': str(err)}

    @http.route(
        '/shahtaj/storage/purge/execute',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def purge_execute(
        self,
        category_id=None,
        older_than_days=None,
        admin_password=None,
        confirm_text=None,
        **kwargs,
    ):
        self._ensure_admin()
        try:
            return self._manager().execute_purge(
                category_id=category_id or kwargs.get('category_id'),
                older_than_days=(
                    older_than_days if older_than_days is not None
                    else kwargs.get('older_than_days')
                ),
                admin_password=admin_password or kwargs.get('admin_password') or '',
                confirm_text=confirm_text or kwargs.get('confirm_text') or '',
            )
        except UserError as err:
            return {'ok': False, 'error': str(err)}

    @http.route(
        '/shahtaj/storage/purge/history',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def purge_history(self, limit=30, **kwargs):
        self._ensure_admin()
        limit = min(max(int(limit or 30), 1), 100)
        rows = request.env['shahtaj.storage.purge.log'].sudo().search_read(
            [],
            [
                'create_date', 'category', 'older_than_days', 'records_cleared',
                'estimated_bytes', 'admin1_id', 'requested_by_id', 'notes', 'is_auto',
            ],
            limit=limit,
            order='create_date desc, id desc',
        )
        return {
            'rows': [
                {
                    'id': r['id'],
                    'create_date': r['create_date'],
                    'category': r['category'],
                    'older_than_days': r['older_than_days'],
                    'records_cleared': r['records_cleared'],
                    'estimated_bytes': r['estimated_bytes'],
                    'confirmed_by': r['admin1_id'][1] if r.get('admin1_id') else '—',
                    'requested_by': r['requested_by_id'][1] if r.get('requested_by_id') else '—',
                    'notes': r.get('notes') or '',
                    'is_auto': bool(r.get('is_auto')),
                }
                for r in rows
            ],
        }

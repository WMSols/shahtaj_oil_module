# -*- coding: utf-8 -*-
"""Delivery Man API — day load, van, plan, deliver, free ops."""
from odoo import _, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.controllers.api.dm_base import (
    DM_API_ROUTE,
    api_success,
    dm_api_activity,
    dm_service,
    ensure_delivery_man,
)


class ShahtajDmApiOps(http.Controller):

    # ── Session (day: Left Office / Out on Route) ─────────────────────

    @http.route('/api/shahtaj/v1/dm/session/get', **DM_API_ROUTE)
    def session_get(self, **kwargs):
        ensure_delivery_man()
        session = request.env['shahtaj.dm.day.session'].get_or_create_today()
        return api_success({
            'id': session.id,
            'date': str(session.session_date),
            'state': session.state,
            'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
            'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
            'notes': session.notes or '',
        })

    @http.route('/api/shahtaj/v1/dm/session/depart', **DM_API_ROUTE)
    @dm_api_activity('dm.session.depart', 'DM left office')
    def session_depart(self, notes=None, **kwargs):
        """After office load — day status Left Office / Out on Route."""
        ensure_delivery_man()
        session = request.env['shahtaj.dm.day.session'].get_or_create_today()
        if notes:
            session.write({'notes': notes})
        session.action_depart()
        return api_success({
            'id': session.id,
            'date': str(session.session_date),
            'state': session.state,
            'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
        })

    @http.route('/api/shahtaj/v1/dm/session/end', **DM_API_ROUTE)
    @dm_api_activity('dm.session.end', 'DM ended day')
    def session_end(self, notes=None, **kwargs):
        ensure_delivery_man()
        session = request.env['shahtaj.dm.day.session'].get_or_create_today()
        if notes:
            session.write({'notes': notes})
        session.action_end_day()
        return api_success({
            'id': session.id,
            'date': str(session.session_date),
            'state': session.state,
            'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
        })

    # ── Office load ───────────────────────────────────────────────────

    @http.route('/api/shahtaj/v1/dm/load/today', **DM_API_ROUTE)
    def load_today(self, **kwargs):
        ensure_delivery_man()
        return api_success(dm_service().get_today_load())

    @http.route('/api/shahtaj/v1/dm/load/pick', **DM_API_ROUTE)
    @dm_api_activity('dm.load.pick', 'DM pick today load')
    def load_pick(self, lines=None, **kwargs):
        """Step 1 job load. lines: [{product_id, qty}, ...]."""
        ensure_delivery_man()
        qty_by_product = {}
        for row in lines or []:
            pid = int(row.get('product_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if pid and qty > 0:
                qty_by_product[pid] = qty
        return api_success(dm_service().pick_today_load(qty_by_product))

    @http.route('/api/shahtaj/v1/dm/job/pick', **DM_API_ROUTE)
    @dm_api_activity('dm.job.pick', 'DM pick one job')
    def job_pick(self, job_id=None, lines=None, **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        return api_success(dm_service().pick_job(job_id, lines or []))

    # ── Free van WH ↔ van ─────────────────────────────────────────────

    @http.route('/api/shahtaj/v1/dm/van/snapshot', **DM_API_ROUTE)
    def van_snapshot(self, **kwargs):
        ensure_delivery_man()
        return api_success(dm_service().van_snapshot())

    @http.route('/api/shahtaj/v1/dm/van/products', **DM_API_ROUTE)
    def van_products(self, **kwargs):
        """Products available to free-load (WH + van qtys)."""
        ensure_delivery_man()
        return api_success(dm_service().products_for_free_load())

    @http.route('/api/shahtaj/v1/dm/van/load', **DM_API_ROUTE)
    @dm_api_activity('dm.van.load', 'DM free load WH→van')
    def van_load(self, lines=None, **kwargs):
        """Optional free load. lines: [{product_id, qty}, ...]."""
        ensure_delivery_man()
        return api_success(dm_service().free_van_transfer('to_van', lines or []))

    @http.route('/api/shahtaj/v1/dm/van/return', **DM_API_ROUTE)
    @dm_api_activity('dm.van.return', 'DM free return van→WH')
    def van_return(self, lines=None, **kwargs):
        """Free return. lines: [{product_id, qty}, ...]."""
        ensure_delivery_man()
        return api_success(dm_service().free_van_transfer('to_wh', lines or []))

    # ── Plan (live assign list) ───────────────────────────────────────

    @http.route('/api/shahtaj/v1/dm/plan/today', **DM_API_ROUTE)
    def plan_today(self, **kwargs):
        ensure_delivery_man()
        return api_success(dm_service().get_plan())

    @http.route('/api/shahtaj/v1/dm/plan/job', **DM_API_ROUTE)
    def plan_job(self, job_id=None, **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        job = dm_service()._job_for_dm(job_id)
        job.sudo()._sync_with_sale_order(ensure_visit_task=False)
        return api_success({'job': dm_service().job_detail(job)})

    # ── Field stop + deliver ──────────────────────────────────────────

    @http.route('/api/shahtaj/v1/dm/job/notes', **DM_API_ROUTE)
    @dm_api_activity('dm.job.notes', 'DM update job notes')
    def job_notes(self, job_id=None, notes='', **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        return api_success(dm_service().set_job_notes(job_id, notes))

    @http.route('/api/shahtaj/v1/dm/job/shop-closed', **DM_API_ROUTE)
    @dm_api_activity('dm.job.shop_closed', 'DM shop closed')
    def job_shop_closed(self, job_id=None, notes=None, **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        if not (notes or '').strip():
            raise UserError(_('Notes are required when the shop is closed.'))
        return api_success(dm_service().mark_shop_closed(job_id, notes))

    @http.route('/api/shahtaj/v1/dm/job/failed', **DM_API_ROUTE)
    @dm_api_activity('dm.job.failed', 'DM could not deliver')
    def job_failed(self, job_id=None, notes=None, **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        if not (notes or '').strip():
            raise UserError(_('Notes are required when delivery fails.'))
        return api_success(dm_service().mark_failed(job_id, notes))

    @http.route('/api/shahtaj/v1/dm/job/deliver', **DM_API_ROUTE)
    @dm_api_activity('dm.job.deliver', 'DM GPS deliver job')
    def job_deliver(
        self,
        job_id=None,
        latitude=None,
        longitude=None,
        lines=None,
        notes=None,
        receiver_name=None,
        delivery_proof_image=None,
        **kwargs,
    ):
        """GPS deliver assigned job. lines: [{line_id, qty}, ...].

        Requires receiver_name + delivery_proof_image (base64 or data-URL).
        """
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        if latitude is None or longitude is None:
            raise UserError(_('latitude and longitude are required.'))
        return api_success(dm_service().deliver_job(
            job_id,
            latitude,
            longitude,
            lines or [],
            notes=notes,
            receiver_name=receiver_name,
            delivery_proof_image=delivery_proof_image,
        ))

    @http.route('/api/shahtaj/v1/dm/job/return-undelivered', **DM_API_ROUTE)
    @dm_api_activity('dm.job.return', 'DM return undelivered job stock')
    def job_return_undelivered(self, job_id=None, **kwargs):
        ensure_delivery_man()
        if not job_id:
            raise UserError(_('job_id is required.'))
        return api_success(dm_service().return_job_undelivered(job_id))

    # ── Walk-in delivery (SO + van stock + full DM wallet pay) ────────

    @http.route('/api/shahtaj/v1/dm/deliver/walk-in', **DM_API_ROUTE)
    @dm_api_activity('dm.walk_in_deliver', 'DM walk-in delivery')
    def deliver_walk_in(
        self,
        customer_name=None,
        phone=None,
        latitude=None,
        longitude=None,
        lines=None,
        notes='',
        receiver_name=None,
        delivery_proof_image=None,
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
        **kwargs,
    ):
        """Walk-in: create/reuse minimal customer, SO at company pricelist,
        deliver from van, invoice, full-pay into DM wallet.

        lines: [{product_id, qty}, ...].
        Requires GPS + receiver_name + delivery_proof_image.
        payment_method: cash (default) or cheque.
        """
        ensure_delivery_man()
        if not customer_name:
            raise UserError(_('customer_name is required.'))
        if latitude is None or longitude is None:
            raise UserError(_('latitude and longitude are required.'))
        return api_success(dm_service().walk_in_deliver(
            customer_name=customer_name,
            phone=phone,
            latitude=latitude,
            longitude=longitude,
            lines=lines or [],
            notes=notes or '',
            receiver_name=receiver_name,
            delivery_proof_image=delivery_proof_image,
            payment_method=payment_method or 'cash',
            cheque_number=cheque_number,
            cheque_image=cheque_image,
        ))
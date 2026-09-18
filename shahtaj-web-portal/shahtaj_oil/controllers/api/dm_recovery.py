# -*- coding: utf-8 -*-
"""Delivery Man API — recovery (shop cash → DM wallet) + wallet reads.

Independent of GPS check-in / delivery state. Settle-to-bank stays distributor web.
Shop is identified by shop_id only.
"""
from odoo import _, http
from odoo.exceptions import UserError

from odoo.addons.shahtaj_oil.controllers.api.dm_base import (
    DM_API_ROUTE,
    api_success,
    dm_api_activity,
    dm_service,
    ensure_delivery_man,
)


class ShahtajDmApiRecovery(http.Controller):

    @http.route('/api/shahtaj/v1/dm/recovery/shop', **DM_API_ROUTE)
    def recovery_shop(self, shop_id=None, **kwargs):
        """Open invoices + outstanding + last paid invoices for Recovery.

        Requires ``shop_id``. No check-in / job_id required.
        """
        ensure_delivery_man()
        if not shop_id:
            raise UserError(_('shop_id is required.'))
        return api_success(dm_service().recovery_shop(shop_id=shop_id))

    @http.route('/api/shahtaj/v1/dm/recovery/collect', **DM_API_ROUTE)
    @dm_api_activity('dm.recovery.collect', 'DM wallet collection')
    def recovery_collect(
        self,
        shop_id=None,
        allocations=None,
        notes='',
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
        **kwargs,
    ):
        """Post collection into DM wallet (DMCASH / 101410).

        ``allocations``: ``[{invoice_id, amount}, ...]``
        ``payment_method``: ``cash`` (default) or ``cheque``.
        Cheque requires ``cheque_number`` + ``cheque_image`` (base64).
        Requires ``shop_id``. Independent of check-in / deliver.
        """
        ensure_delivery_man()
        if not shop_id:
            raise UserError(_('shop_id is required.'))
        if not allocations:
            raise UserError(_('allocations is required.'))
        return api_success(dm_service().recovery_collect(
            shop_id=shop_id,
            allocations=allocations,
            notes=notes or '',
            payment_method=payment_method or 'cash',
            cheque_number=cheque_number,
            cheque_image=cheque_image,
        ))

    @http.route('/api/shahtaj/v1/dm/wallet/get', **DM_API_ROUTE)
    def wallet_get(self, **kwargs):
        """Current DM wallet balance + today / lifetime collection summary."""
        ensure_delivery_man()
        return api_success(dm_service().wallet_get())

    @http.route('/api/shahtaj/v1/dm/wallet/collections', **DM_API_ROUTE)
    def wallet_collections(
        self,
        date_from=None,
        date_to=None,
        limit=50,
        **kwargs,
    ):
        """List this DM's wallet collections (newest first)."""
        ensure_delivery_man()
        return api_success(dm_service().wallet_collections(
            date_from=date_from,
            date_to=date_to,
            limit=limit,
        ))

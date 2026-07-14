# -*- coding: utf-8 -*-
"""Order booker API — online presence / heartbeat."""
from odoo import http
from odoo.http import request

from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_success,
    ensure_order_booker,
)


class ShahtajApiPresence(http.Controller):

    @http.route('/api/shahtaj/v1/presence/heartbeat', **API_ROUTE)
    def heartbeat(self, **kwargs):
        """Mark the authenticated order booker as online (last seen = now).

        Flutter should call this on login, on app resume, and every 2–3 minutes
        while the app is in the foreground.
        """
        ensure_order_booker()
        user = request.env.user
        presence = user.action_shahtaj_touch_presence()
        return api_success(presence)

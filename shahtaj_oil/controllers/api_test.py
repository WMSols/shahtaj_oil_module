# -*- coding: utf-8 -*-
"""Serve the HTML API test client for order booker flows."""
from odoo import http
from odoo.http import request


class ShahtajApiTest(http.Controller):

    @http.route('/shahtaj/api/test', type='http', auth='public', sitemap=False)
    def api_test_page(self, **kwargs):
        return request.redirect('/shahtaj_oil/static/api_test/index.html')

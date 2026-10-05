# -*- coding: utf-8 -*-
"""One print record for every portal list: title, filters, and rows."""
import json

from odoo import fields, models


class ShahtajListPrint(models.TransientModel):
    _name = 'shahtaj.list.print'
    _description = 'List Print'

    title = fields.Char(required=True)
    filter_text = fields.Text(string='Filters')
    summary_text = fields.Text(string='Summary')
    printed_on = fields.Date(
        string='Printed On',
        default=lambda self: fields.Date.context_today(self),
    )
    columns_json = fields.Text(default='[]')
    rows_json = fields.Text(default='[]')

    def filter_lines(self):
        self.ensure_one()
        return [line for line in (self.filter_text or '').splitlines() if line.strip()]

    def summary_lines(self):
        self.ensure_one()
        return [line for line in (self.summary_text or '').splitlines() if line.strip()]

    def printed_on_label(self):
        self.ensure_one()
        if not self.printed_on:
            return ''
        return self.printed_on.strftime('%d %b %Y')

    def column_list(self):
        self.ensure_one()
        data = json.loads(self.columns_json or '[]')
        return data if isinstance(data, list) else []

    def row_list(self):
        self.ensure_one()
        data = json.loads(self.rows_json or '[]')
        return data if isinstance(data, list) else []

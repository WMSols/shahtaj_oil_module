# -*- coding: utf-8 -*-
"""Turn Odoo records into plain JSON for the order booker mobile API."""
from .image_utils import SHOP_PHOTO_FIELDS, shop_photo_data, shop_photo_flags


def _m2o(record):
    if not record:
        return None
    return {'id': record.id, 'name': record.display_name}


def user_brief(user):
    return {
        'id': user.id,
        'order_booker_id': user.id,
        'name': user.name,
        'login': user.login,
        'employee_code': user.shahtaj_employee_code or False,
    }


def task_dict(task):
    return {
        'id': task.id,
        'order_booker_id': task.order_booker_id.id,
        'scheduled_date': str(task.scheduled_date) if task.scheduled_date else False,
        'state': task.state,
        'route': _m2o(task.route_id),
        'zone': _m2o(task.zone_id),
        'shop': shop_brief(task.shop_id),
        'shop_id': task.shop_id.id,
        'visit_id': task.visit_id.id or False,
        'visit_duration_minutes': task.visit_duration_minutes,
        'notes': task.notes or '',
    }


def shop_brief(partner):
    if not partner:
        return None
    return {
        'id': partner.id,
        'shop_id': partner.id,
        'name': partner.name,
        'owner_name': partner.owner_name or '',
        'owner_phone': partner.owner_phone or '',
        'owner_cnic_number': partner.owner_cnic_number or '',
        'latitude': partner.partner_latitude,
        'longitude': partner.partner_longitude,
        'approval_state': partner.shop_approval_state,
        'shop_category': partner.shahtaj_shop_category,
        'photos': shop_photo_flags(partner),
    }


def shop_detail(partner, include_photos=False):
    data = shop_brief(partner)
    if include_photos:
        data['photo_data'] = shop_photo_data(partner)
    return data


def visit_line_dict(line):
    bookable = line.product_id._get_shahtaj_bookable_qty(
        exclude_visit_line_ids=line.visit_id.line_ids.ids,
    )
    return {
        'id': line.id,
        'product': product_brief(line.product_id, bookable_qty=bookable),
        'quantity': line.product_uom_qty,
        'price_unit': line.price_unit,
        'subtotal': line.subtotal,
    }


def product_brief(product, bookable_qty=None, visit_line_ids=None):
    if not product:
        return None
    if bookable_qty is None:
        bookable_qty = product._get_shahtaj_bookable_qty(
            exclude_visit_line_ids=visit_line_ids or [],
        )
    unlimited = bookable_qty is None
    tmpl = product.product_tmpl_id
    return {
        'id': product.id,
        'name': product.display_name,
        'list_price': product.lst_price,
        'uom': product.uom_id.name,
        'sale_uom': tmpl.shahtaj_sale_uom,
        'kg_per_unit': tmpl._shahtaj_get_kg_per_unit(),
        'is_storable': product.is_storable,
        'qty_bookable': bookable_qty if not unlimited else False,
        'qty_unlimited': unlimited,
        'taxes': [{
            'id': tax.id,
            'name': tax.name,
            'amount': tax.amount,
            'amount_type': tax.amount_type,
        } for tax in tmpl.taxes_id],
    }


def visit_dict(visit, include_lines=True):
    data = {
        'id': visit.id,
        'state': visit.state,
        'outcome': visit.outcome,
        'started_at': visit.started_at.isoformat() if visit.started_at else False,
        'ended_at': visit.ended_at.isoformat() if visit.ended_at else False,
        'duration_minutes': visit.duration_minutes,
        'check_in_distance_m': visit.check_in_distance_m,
        'notes': visit.notes or '',
        'task_id': visit.visit_task_id.id,
        'shop': shop_brief(visit.shop_id),
        'shop_id': visit.shop_id.id,
        'order_booker_id': visit.order_booker_id.id,
        'route': _m2o(visit.route_id),
        'sale_order_name': visit.sale_order_name or False,
        'order_amount': visit.order_amount,
    }
    if include_lines:
        data['lines'] = [visit_line_dict(line) for line in visit.line_ids]
    return data


def zone_brief(zone):
    if not zone:
        return None
    return {
        'id': zone.id,
        'name': zone.name,
        'route_count': zone.route_count,
    }


def route_brief(route):
    if not route:
        return None
    return {
        'id': route.id,
        'name': route.name,
        'zone_id': route.zone_id.id,
        'zone': _m2o(route.zone_id),
        'shop_count': route.shop_count,
    }


def schedule_dict(schedule):
    return {
        'id': schedule.id,
        'day_of_week': schedule.day_of_week,
        'day_label': dict(schedule._fields['day_of_week'].selection).get(
            schedule.day_of_week, ''
        ),
        'route': _m2o(schedule.route_id),
        'zone': _m2o(schedule.zone_id),
        'shop_count': schedule.shop_count,
        'week_occurrence_date': str(schedule.week_occurrence_date)
        if schedule.week_occurrence_date else False,
        'week_tasks_planned': schedule.week_tasks_planned,
        'week_tasks_completed': schedule.week_tasks_completed,
        'week_tasks_progress': schedule.week_tasks_progress,
    }


def target_dict(target):
    data = {
        'id': target.id,
        'name': target.name,
        'target_type': target.target_type,
        'date_start': str(target.date_start),
        'date_end': str(target.date_end),
        'target_value': target.target_value,
        'achieved_value': target.achieved_value,
        'remaining_value': target.remaining_value,
        'progress_percent': target.progress_percent,
        'product': _m2o(target.product_id) if target.product_id else None,
    }
    if target.target_type == 'product_weight':
        data['target_weight_uom'] = target.target_weight_uom
        data['weight_unit_label'] = dict(
            target._fields['target_weight_uom'].selection,
        ).get(target.target_weight_uom, '')
    return data

# -*- coding: utf-8 -*-
"""Turn Odoo records into plain JSON for the order booker mobile API."""
from .image_utils import SHOP_PHOTO_FIELDS, shop_photo_data, shop_photo_flags


def _m2o(record):
    if not record:
        return None
    return {'id': record.id, 'name': record.display_name}


def user_brief(user):
    last_seen = user.shahtaj_last_seen_at
    return {
        'id': user.id,
        'order_booker_id': user.id,
        'name': user.name,
        'login': user.login,
        'employee_code': user.shahtaj_employee_code or False,
        'online_status': user.shahtaj_online_status or False,
        'last_seen_at': last_seen.isoformat(sep=' ') if last_seen else False,
    }


def task_dict(task):
    operational = task._shahtaj_is_operational_for_booker()
    return {
        'id': task.id,
        'order_booker_id': task.order_booker_id.id,
        'scheduled_date': str(task.scheduled_date) if task.scheduled_date else False,
        'state': task.state,
        'is_operational': operational,
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
    # Always read shop fields via sudo: bookers may lack partner ACL in edge
    # cases (schedule removed, distributor-created shop) while still owning
    # the visit task. Callers must already authorize the shop/task context.
    shop = partner.sudo()
    category = shop.shahtaj_shop_category or 'credit'
    credit_limit = float(shop.credit_limit or 0.0)
    outstanding = float(shop.outstanding_balance or 0.0)
    if category == 'cash':
        credit_remaining = False
    else:
        credit_remaining = max(credit_limit - outstanding, 0.0)
    setup = shop._shahtaj_first_visit_setup_payload()
    routes = [_m2o(route) for route in shop.route_ids]
    return {
        'id': shop.id,
        'shop_id': shop.id,
        'name': shop.name,
        'owner_name': shop.owner_name or '',
        'owner_phone': shop.owner_phone or '',
        'owner_cnic_number': shop.owner_cnic_number or '',
        'shop_license_number': shop.shop_license_number or '',
        'license_number': shop.shop_license_number or '',
        'latitude': shop.partner_latitude,
        'longitude': shop.partner_longitude,
        'approval_state': shop.shop_approval_state,
        'is_operational': shop._shahtaj_is_operational_for_booker(),
        'is_active': shop.active,
        'shop_category': category,
        'credit_limit': credit_limit,
        'outstanding_balance': outstanding,
        'credit_remaining': credit_remaining,
        'photos': shop_photo_flags(shop),
        'field_verified': setup['field_verified'],
        'visit_tag': setup['visit_tag'],
        'needs_shop_setup': setup['needs_shop_setup'],
        'missing_fields': setup['missing_fields'],
        # Primary route kept for older clients; routes = full membership.
        'route': _m2o(shop.route_id),
        'routes': routes,
    }


def shop_detail(partner, include_photos=False):
    data = shop_brief(partner)
    if include_photos and partner:
        data['photo_data'] = shop_photo_data(partner.sudo())
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
    # Never expose archived catalog items to API clients.
    if not product.active or not product.product_tmpl_id.active:
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
        'place_order_distance_m': visit.place_order_distance_m,
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
        'is_active': zone.active,
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
        'is_active': route.active,
        'is_operational': route._shahtaj_is_operational_for_booker(),
    }


def schedule_dict(schedule):
    return {
        'id': schedule.id,
        'day_of_week': schedule.day_of_week,
        'day_label': dict(schedule._fields['day_of_week'].selection).get(
            schedule.day_of_week, ''
        ),
        'is_operational': schedule.route_id._shahtaj_is_operational_for_booker(),
        'route': _m2o(schedule.route_id),
        'zone': _m2o(schedule.zone_id),
        'shop_count': schedule.shop_count,
        'week_occurrence_date': str(schedule.week_occurrence_date)
        if schedule.week_occurrence_date else False,
        'week_tasks_planned': schedule.week_tasks_planned,
        'week_tasks_completed': schedule.week_tasks_completed,
        'week_tasks_progress': schedule.week_tasks_progress,
    }


def target_line_dict(line):
    parent_type = line.target_id.target_type if line.target_id else False
    data = {
        'id': line.id,
        'product': _m2o(line.product_id) if line.product_id else None,
        'achieved_value': line.achieved_value,
        'remaining_value': line.remaining_value,
        'progress_percent': line.progress_percent,
    }
    if parent_type == 'product_bundle':
        data['measure_type'] = line.measure_type
        data['target_value'] = line.target_value
        if line.measure_type == 'weight':
            data['target_weight_uom'] = line.target_weight_uom
            data['weight_unit_label'] = dict(
                line._fields['target_weight_uom'].selection,
            ).get(line.target_weight_uom, '')
    return data


def target_dict(target):
    type_labels = dict(target._fields['target_type'].selection or [])
    data = {
        'id': target.id,
        'name': target.name,
        'target_type': target.target_type,
        'target_type_label': type_labels.get(target.target_type, target.target_type or ''),
        'date_start': str(target.date_start),
        'date_end': str(target.date_end),
        'target_value': target.target_value,
        'achieved_value': target.achieved_value,
        'remaining_value': target.remaining_value,
        'progress_percent': target.progress_percent,
        'lines': [target_line_dict(line) for line in target.line_ids],
        'is_expandable': True,
        'headline_progress_percent': target.progress_percent,
    }
    if target.target_type == 'collective_weight':
        data['target_weight_uom'] = target.target_weight_uom
        data['weight_unit_label'] = dict(
            target._fields['target_weight_uom'].selection,
        ).get(target.target_weight_uom, '')
    if target.target_type == 'product_bundle':
        # Headline is average of line %; 100 = all lines complete on average.
        data['target_value'] = 100.0
        data['combined_progress_mode'] = 'average_line_percent'
    elif target.target_type in ('collective_qty', 'collective_weight'):
        data['combined_progress_mode'] = 'shared_goal_sum'
    return data

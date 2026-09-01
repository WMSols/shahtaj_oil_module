# -*- coding: utf-8 -*-
"""Turn Odoo records into plain JSON for the order booker mobile API."""
from .image_utils import SHOP_PHOTO_FIELDS, shop_photo_data, shop_photo_flags

ORDER_APPROVAL_LABELS = {
    'none': 'Standard',
    'to_approve': 'Pending Verification',
    'approved': 'Verified',
    'rejected': 'Rejected',
}


def _approval_reason_payload(
    requires_discount=False,
    requires_credit=False,
    approval_reasons=None,
):
    reasons = list(approval_reasons or [])
    if not reasons:
        if requires_discount:
            reasons.append('discount')
        if requires_credit:
            reasons.append('credit')
    return {
        'approval_reasons': reasons,
        'requires_discount_approval': bool(requires_discount or 'discount' in reasons),
        'requires_credit_approval': bool(requires_credit or 'credit' in reasons),
    }


def _order_approval_reason_payload_from_sale_order(so):
    reasons = so._shahtaj_get_approval_reasons_list()
    return _approval_reason_payload(
        requires_discount=so.shahtaj_approval_reason_discount,
        requires_credit=so.shahtaj_approval_reason_credit,
        approval_reasons=reasons,
    )


def _order_approval_reason_payload_from_visit_cart(visit):
    has_discount = any(visit.line_ids.mapped('has_discount'))
    cart_total = sum(visit.line_ids.mapped('subtotal'))
    req = visit.env['sale.order']._shahtaj_evaluate_field_order_approval(
        visit.shop_id,
        cart_total,
        has_discount,
    )
    return _approval_reason_payload(
        requires_discount=req['needs_discount'],
        requires_credit=req['needs_credit'],
        approval_reasons=req['approval_reasons'],
    )


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
    credit_info = shop._shahtaj_credit_snapshot_for_api()
    category = shop.shahtaj_shop_category or 'credit'
    credit_limit = credit_info['credit_limit']
    outstanding = credit_info['outstanding_balance']
    credit_remaining = credit_info['credit_remaining']
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
        'pending_order_exposure': credit_info['pending_order_exposure'],
        'confirmed_uninvoiced_exposure': credit_info['confirmed_uninvoiced_exposure'],
        'effective_outstanding': credit_info['effective_outstanding'],
        'credit_remaining': credit_remaining,
        'credit_would_exceed': credit_info['credit_would_exceed'],
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
    catalog_price = line.product_id.lst_price if line.product_id else 0.0
    price_unit = line.price_unit or 0.0
    unit_discount = max(0.0, catalog_price - price_unit) if (price_unit < catalog_price - 0.001) else 0.0
    total_discount = unit_discount * line.product_uom_qty
    discount_pct = round(((catalog_price - price_unit) / catalog_price * 100.0), 2) if (unit_discount > 0 and catalog_price > 0) else 0.0
    return {
        'id': line.id,
        'product': product_brief(line.product_id, bookable_qty=bookable),
        'quantity': line.product_uom_qty,
        'catalog_price': catalog_price,
        'price_unit': line.price_unit,
        'has_discount': unit_discount > 0,
        'unit_discount': unit_discount,
        'total_discount': total_discount,
        'discount_percent': discount_pct,
        'discount_reason': line.discount_reason or '',
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


def visit_order_summary_dict(visit):
    """Compact order + discount/credit verification payload for visit screens."""
    so = visit.sale_order_id
    if so:
        approval_state = so.shahtaj_approval_state or 'none'
        payload = {
            'id': so.id,
            'name': so.name,
            'state': so.state,
            'approval_state': approval_state,
            'approval_state_label': ORDER_APPROVAL_LABELS.get(approval_state, approval_state),
            'has_discount': bool(so.shahtaj_has_discount),
            'catalog_amount': so.shahtaj_catalog_amount_total or 0.0,
            'discount_amount': so.shahtaj_total_discount_amount or 0.0,
            'discount_reasons': so.shahtaj_discount_reasons or '',
            'rejection_reason': so.shahtaj_rejection_reason or '',
            'amount_total': so.amount_total or 0.0,
            'verified_at': so.shahtaj_verified_at.isoformat(sep=' ') if so.shahtaj_verified_at else False,
            'is_placed': True,
        }
        payload.update(_order_approval_reason_payload_from_sale_order(so))
        return payload

    lines = visit.line_ids
    if not lines:
        return None

    catalog_amount = sum((line.catalog_price or 0.0) * line.product_uom_qty for line in lines)
    discount_amount = sum(line.total_discount for line in lines)
    has_discount = discount_amount > 0.001
    reason_payload = _order_approval_reason_payload_from_visit_cart(visit)
    approval_state = 'to_approve' if reason_payload['approval_reasons'] else 'none'
    reasons = [line.discount_reason for line in lines if line.discount_reason]
    seen = set()
    unique_reasons = [reason for reason in reasons if not (reason in seen or seen.add(reason))]
    payload = {
        'id': False,
        'name': False,
        'state': 'draft',
        'approval_state': approval_state,
        'approval_state_label': ORDER_APPROVAL_LABELS.get(approval_state, approval_state),
        'has_discount': has_discount,
        'catalog_amount': catalog_amount,
        'discount_amount': discount_amount,
        'discount_reasons': ', '.join(unique_reasons),
        'rejection_reason': '',
        'amount_total': sum(line.subtotal for line in lines),
        'verified_at': False,
        'is_placed': False,
    }
    payload.update(reason_payload)
    return payload


def visit_dict(visit, include_lines=True):
    order = visit_order_summary_dict(visit)
    order_reasons = order.get('approval_reasons', []) if order else []
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
        'sale_order_id': order['id'] if order else False,
        'sale_order_name': visit.sale_order_name or (order['name'] if order else False),
        'order_amount': visit.order_amount if visit.sale_order_id else (order['amount_total'] if order else 0.0),
        'order': order,
        # Legacy flat keys kept for older mobile clients.
        'order_approval_state': order['approval_state'] if order else 'none',
        'order_approval_reasons': order_reasons,
        'order_requires_discount_approval': order.get('requires_discount_approval', False) if order else False,
        'order_requires_credit_approval': order.get('requires_credit_approval', False) if order else False,
        'has_discount': order['has_discount'] if order else False,
        'total_discount_amount': order['discount_amount'] if order else 0.0,
    }
    if include_lines:
        data['lines'] = [visit_line_dict(line) for line in visit.line_ids]
    return data


def visits_list_dict(visits):
    """Serialize visit history with one prefetch pass for linked sales orders."""
    visits = visits.sudo()
    if visits:
        visits.mapped('sale_order_id')
    return [visit_dict(visit, include_lines=False) for visit in visits]


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

# -*- coding: utf-8 -*-
"""Helpers for base64 image fields on API payloads."""
import re

SHOP_PHOTO_FIELDS = (
    'owner_cnic_front',
    'owner_cnic_back',
    'owner_photo',
    'shop_exterior_photo',
)


def normalize_image_b64(value):
    """Accept raw base64 or data:image/...;base64,... from mobile clients."""
    if not value or not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    match = re.match(r'^data:image/[\w+.-]+;base64,(.+)$', value, re.I | re.S)
    return match.group(1) if match else value


def shop_photo_vals_from_kwargs(kwargs):
    """Extract optional shop image fields from a JSON body."""
    vals = {}
    for field in SHOP_PHOTO_FIELDS:
        if field not in kwargs:
            continue
        normalized = normalize_image_b64(kwargs.get(field))
        if normalized:
            vals[field] = normalized
    return vals


def shop_photo_flags(partner):
    return {field: bool(partner[field]) for field in SHOP_PHOTO_FIELDS}


def shop_photo_data(partner):
    """Return base64 strings for photos that exist (for detail responses)."""
    data = {}
    for field in SHOP_PHOTO_FIELDS:
        if partner[field]:
            data[field] = partner[field]
    return data

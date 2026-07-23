# -*- coding: utf-8 -*-
"""GPS helpers: distance between booker and shop for check-in validation."""
import math

# Defaults when company settings are empty / new company.
DEFAULT_MIN_SHOP_DISTANCE_M = 0.0
DEFAULT_MAX_SHOP_DISTANCE_M = 100.0

# Backward-compatible alias (prefer company setting via get_shop_distance_limits).
MAX_SHOP_DISTANCE_M = DEFAULT_MAX_SHOP_DISTANCE_M


def shahtaj_distance_meters(lat1, lon1, lat2, lon2):
    """Haversine distance in metres between two WGS84 points."""
    radius = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


def get_shop_distance_limits(env):
    """Live company min/max metres for shop GPS checks."""
    return env['res.company'].shahtaj_get_shop_distance_limits()

"""Projection model and probability math.

The site's JavaScript (site/app.js) mirrors the probability functions here, so a
projection's {mean, sd, dist} in data.json means the same thing in both places.

Distributions:
  gmix    - yardage and volume stats (attempts, carries, targets, receptions). A mix of two
            gamma curves: a "normal game" curve plus a smaller "dud" curve for games where the
            player gets hurt, benched, or schemed out. Without the dud curve, one gamma has to
            stretch to cover those near-zero games, which also makes its upper tail far too long.
            Fields: mean (overall), sd (normal-game spread at that mean), w (dud share),
            r (dud average / normal average), k (dud spread / normal spread).
  gamma   - same idea with one curve (older data files).
  poisson - touchdowns and interceptions (small counts).
  normal  - game total points and point margin.

How each player's average and spread are set comes from scripts/model_params.json, fitted on
2022-2024 game logs by scripts/fit_model.py and checked on 2025-2026.
"""
import json
import math
import os

# Stats the site projects, by position. Each entry: (stat column, kind)
# kind: "volume" (opportunity counts), "yards", "td", "int", "catch"
POSITION_STATS = {
    "QB": [("attempts", "volume_pass"), ("completions", "volume_pass"),
           ("passing_yards", "yards_pass"), ("passing_tds", "td_pass"),
           ("passing_interceptions", "int"), ("carries", "volume_rush"),
           ("rushing_yards", "yards_rush"), ("rushing_tds", "td_rush")],
    "RB": [("carries", "volume_rush"), ("rushing_yards", "yards_rush"),
           ("rushing_tds", "td_rush"), ("targets", "volume_pass"),
           ("receptions", "volume_pass"), ("receiving_yards", "yards_rec")],
    "WR": [("targets", "volume_pass"), ("receptions", "volume_pass"),
           ("receiving_yards", "yards_rec"), ("receiving_tds", "td_rec")],
    "TE": [("targets", "volume_pass"), ("receptions", "volume_pass"),
           ("receiving_yards", "yards_rec"), ("receiving_tds", "td_rec")],
}

COUNT_KINDS = {"td_pass", "td_rush", "td_rec", "int"}

TOTAL_SD = 13.5   # NFL game totals land within about +/-13.5 points of the line 2/3 of the time
MARGIN_SD = 13.0  # same idea for the final score margin


def _load_params():
    try:
        with open(os.path.join(os.path.dirname(__file__), "model_params.json")) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


PARAMS = _load_params()


def ewma(values, half_life=4.0):
    """Recency-weighted average: a game `half_life` games ago counts half as much."""
    if not values:
        return 0.0
    n = len(values)
    w = [0.5 ** ((n - 1 - i) / half_life) for i in range(n)]
    return sum(v * wi for v, wi in zip(values, w)) / sum(w)


def shrink(raw, n, prior=1.0, k=4.0):
    """Pull a noisy ratio toward `prior`; after k games it is weighted half and half."""
    return prior + (raw - prior) * n / (n + k)


def clip(x, lo, hi):
    return max(lo, min(hi, x))


# ---------- probability functions (mirrored in app.js) ----------

def normal_cdf(x, mean, sd):
    return 0.5 * (1 + math.erf((x - mean) / (sd * math.sqrt(2))))


def poisson_cdf(k, lam):
    """P(X <= k) for integer k."""
    if k < 0:
        return 0.0
    term = math.exp(-lam)
    total = term
    for i in range(1, int(k) + 1):
        term *= lam / i
        total += term
    return min(1.0, total)


def _gammainc_lower(a, x):
    """Regularized lower incomplete gamma P(a, x)."""
    if x <= 0:
        return 0.0
    if x < a + 1:
        term = 1.0 / a
        total = term
        ap = a
        for _ in range(500):
            ap += 1
            term *= x / ap
            total += term
            if abs(term) < abs(total) * 1e-12:
                break
        return total * math.exp(-x + a * math.log(x) - math.lgamma(a))
    # continued fraction for the upper tail
    b = x + 1 - a
    c = 1e300
    d = 1 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return 1 - math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def gamma_cdf(x, mean, sd):
    if mean <= 0 or sd <= 0:
        return 1.0 if x >= mean else 0.0
    shape = (mean / sd) ** 2
    scale = sd ** 2 / mean
    return _gammainc_lower(shape, x / scale)


def gmix_parts(proj):
    """The two gamma curves of a gmix projection: [(weight, mean, sd), ...]."""
    m, s, w, r, k = proj["mean"], proj["sd"], proj["w"], proj["r"], proj["k"]
    mb = m / (1 - w + w * r)          # normal-game average, so the overall average is m
    sb = s * mb / m if m > 0 else s
    return [(1 - w, mb, sb), (w, mb * r, sb * k)]


def total_sd(proj):
    """Overall spread, including the dud games."""
    if proj["dist"] != "gmix":
        return proj["sd"]
    parts = gmix_parts(proj)
    second = sum(w * (s * s + mu * mu) for w, mu, s in parts)
    return math.sqrt(max(second - proj["mean"] ** 2, 0.0))


def cdf(x, proj):
    """P(stat <= x) for a projection dict {mean, sd, dist, ...}."""
    if proj["dist"] == "poisson":
        return poisson_cdf(math.floor(x), proj["mean"])
    if proj["dist"] == "normal":
        return normal_cdf(x, proj["mean"], proj["sd"])
    if proj["dist"] == "gmix":
        if proj["mean"] <= 0:
            return 1.0 if x >= 0 else 0.0
        return sum(w * gamma_cdf(x, mu, s) for w, mu, s in gmix_parts(proj))
    return gamma_cdf(x, proj["mean"], proj["sd"])


def quantile(p, proj):
    if proj["dist"] == "poisson":
        k = 0
        while poisson_cdf(k, proj["mean"]) < p and k < 50:
            k += 1
        return float(k)
    lo, hi = (-200.0, 300.0) if proj["dist"] == "normal" else (0.0, proj["mean"] + 12 * total_sd(proj) + 1)
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid, proj) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2

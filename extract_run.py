#!/usr/bin/env python3
"""
extract_run.py

Converts either:
  (a) a resampled .mat file (v7.3/HDF5, as produced by fcp-data-muncher), or
  (b) a Level 1 wide-format CSV (a 'Time' column + one column per channel,
      as fcp-data-muncher/MATLAB can export it)
into a single JSON file matching the schema expected by the FST Lisboa Run
Catalogue web interface (index.html -> "Add Run" panel). Format is chosen
automatically from the file extension.

Usage (.mat input):
    python3 extract_run.py path/to/run_resampled.mat -o run_export.json \
        --event "FSPT Testing Day" --session-type "Autocross" --driver "Driver A" \
        --aeropack --springs Medium --arb Stiff --class "Class 1 EV" --origin real \
        --protocol fst.json

Usage (.csv input -- computes Level 2 KPIs directly, no MATLAB needed):
    python3 extract_run.py path/to/run_level1.csv -o run_export.json \
        --event "FSPT Testing Day" --session-type "Autocross" --driver "Driver A" \
        --protocol fst.json

Requirements:
    pip install numpy pandas --break-system-packages   (for .csv input)
    pip install h5py --break-system-packages            (for .mat input)
"""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    import h5py
except ImportError:
    h5py = None


# ============================================================================
# LEVEL 2 KPI COMPUTATION -- direct Python port of LogFilter_Level2.m
# Mirrors the MATLAB script's methodology exactly: same candidate channel
# names, same wheel-speed formula, same GPS/RPM-fallback distance logic,
# same trapezoidal energy integration. This does NOT approximate -- it's the
# same algorithm, just run in Python directly on the Level 1 CSV instead of
# requiring a MATLAB pass first.
# ============================================================================

L2_PARAMS = {
    "wheel_radius_m": 0.20574,
    "gear_ratio": 12.65,
    "max_gps_segment_speed_mps": 120.0,
    "min_valid_gps_distance_m": 1.0,
}

RPM_NAMES = ["amk_actual_speed0", "amk_actual_speed1", "amk_actual_speed2", "amk_actual_speed3"]
ACCY_CANDIDATES = ["accY", "accy", "acc_y", "AccelerationY"]
LAT_CANDIDATES = ["lat", "latitude", "Latitude", "gps_lat", "gps_latitude",
                  "GPS_lat", "GPS_Lat", "GPS_latitude", "GPS_Latitude", "gpsLatitude", "GPSLatitude"]
LON_CANDIDATES = ["lon", "long", "longitude", "Longitude", "gps_lon", "gps_long",
                  "gps_longitude", "GPS_lon", "GPS_Lon", "GPS_longitude", "GPS_Longitude",
                  "gpsLongitude", "GPSLongitude"]
POWER_CANDIDATES = ["isa_power", "ISA_power", "isa_Power", "ISA_Power", "power_isa", "Power_ISA"]
VOLTAGE_CANDIDATES = ["isa_voltage", "ISA_voltage", "isa_Voltage", "ISA_Voltage", "voltage_isa", "Voltage_ISA"]
CURRENT_CANDIDATES = ["isa_current", "ISA_current", "isa_Current", "ISA_Current", "current_isa", "Current_ISA"]


def find_channel_flexible(columns, candidates):
    """Exact match first, then case-insensitive -- mirrors findChannelNameFlexible."""
    col_set = set(columns)
    for c in candidates:
        if c in col_set:
            return c
    lower_map = {c.lower(): c for c in columns}
    for c in candidates:
        if c.lower() in lower_map:
            return lower_map[c.lower()]
    return None


def cumtrapz(y, t):
    """Cumulative trapezoidal integration, prefixed with 0 -- mirrors MATLAB cumtrapz."""
    y = np.asarray(y, dtype=float)
    t = np.asarray(t, dtype=float)
    dt = np.diff(t)
    seg = dt * (y[:-1] + y[1:]) / 2.0
    return np.concatenate(([0.0], np.cumsum(seg)))


def make_kpi(value, unit, status, method="", required_channels=None, failure_reason=""):
    required_channels = required_channels or []
    if status == "ok" and (value is None or not np.isfinite(value)):
        status, failure_reason = "failed", "Non-finite KPI value."
    return {
        "value": None if value is None or not np.isfinite(value) else round(float(value), 6),
        "unit": unit, "status": status, "method": method,
        "required_channels": required_channels, "failure_reason": failure_reason,
    }


def distance_from_gps(lat, lon, t, max_speed_mps):
    n = min(len(lat), len(lon), len(t))
    lat, lon, t = lat[:n], lon[:n], t[:n]
    valid_point = np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90) & (np.abs(lon) <= 180)
    quality = {"n_samples": n, "n_finite_latlon": int(valid_point.sum()),
               "n_valid_segments": 0, "n_rejected_segments": 0, "max_segment_speed_mps": max_speed_mps}
    if valid_point.sum() < 3:
        return None, quality

    R = 6371000.0
    lat1, lat2 = np.radians(lat[:-1]), np.radians(lat[1:])
    lon1, lon2 = np.radians(lon[:-1]), np.radians(lon[1:])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    d = R * c
    dt = np.diff(t)
    with np.errstate(divide="ignore", invalid="ignore"):
        seg_speed = d / dt
    valid_seg = (valid_point[:-1] & valid_point[1:] & np.isfinite(d) & np.isfinite(dt)
                 & (dt > 0) & np.isfinite(seg_speed) & (seg_speed <= max_speed_mps))
    quality["n_valid_segments"] = int(valid_seg.sum())
    quality["n_rejected_segments"] = int(len(valid_seg) - valid_seg.sum())
    d = np.where(valid_seg, d, 0.0)
    return np.concatenate(([0.0], np.cumsum(d))), quality


def compute_level2(df, t):
    """Runs the full LogFilter_Level2.m algorithm on a Level 1 dataframe.

    Returns (derived_channels: dict[name -> {values, unit, description}],
             kpis: dict, sources: dict) exactly mirroring the MATLAB script's
             level2Info.kpis structure and derived-channel set.
    """
    params = L2_PARAMS
    n_ref = len(t)
    run_duration_s = float(t[-1] - t[0])
    derived = {}
    sources = {}

    # ---- wheel speed from AMK RPMs ----
    rpm_cols = [find_channel_flexible(df.columns, [n]) for n in RPM_NAMES]
    wheel_speed_status, wheel_speed_failure = "failed", ""
    speed_wheel_mps = np.full(n_ref, np.nan)

    if all(rpm_cols):
        accy_col = find_channel_flexible(df.columns, ACCY_CANDIDATES)
        omega = []
        for col in rpm_cols:
            rpm = df[col].to_numpy(dtype=float)
            omega.append((2 * np.pi * params["wheel_radius_m"] * rpm / 60.0) / params["gear_ratio"])
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=RuntimeWarning)
                speed_wheel_mps = np.nanmean(np.vstack(omega), axis=0)
        if np.any(np.isfinite(speed_wheel_mps)):
            wheel_speed_status = "ok"
            derived["speed_wheel_mps"] = {
                "values": speed_wheel_mps, "unit": "m/s",
                "description": (f"Wheel speed from mean AMK RPMs; gear_ratio {params['gear_ratio']:.5g}; "
                                 f"wheel_radius {params['wheel_radius_m']:.5g} m; "
                                 f"accY input: {accy_col or 'not_used'}"),
            }
        else:
            wheel_speed_failure = "Wheel RPM channels found, but resulting speed is invalid."
    else:
        missing = [n for n, c in zip(RPM_NAMES, rpm_cols) if c is None]
        wheel_speed_failure = f"Missing wheel RPM channels: {', '.join(missing)}"

    sources["wheel_speed_status"] = wheel_speed_status
    sources["wheel_speed_required_channels"] = [c for c in rpm_cols if c]

    # ---- KPI 1: distance ----
    distance_status, distance_failure, distance_method = "failed", "", ""
    distance_required_channels = []
    distance_km = None
    distance_cum_m = np.full(n_ref, np.nan)

    lat_col = find_channel_flexible(df.columns, LAT_CANDIDATES)
    lon_col = find_channel_flexible(df.columns, LON_CANDIDATES)
    gps_quality = {}
    if lat_col and lon_col:
        lat = df[lat_col].to_numpy(dtype=float)
        lon = df[lon_col].to_numpy(dtype=float)
        gps_dist, gps_quality = distance_from_gps(lat, lon, t, params["max_gps_segment_speed_mps"])
        if gps_dist is not None and np.isfinite(gps_dist[-1]) and gps_dist[-1] > params["min_valid_gps_distance_m"]:
            distance_cum_m = gps_dist
            distance_km = gps_dist[-1] / 1000.0
            distance_status = "ok"
            distance_method = (f"GPS haversine cumulative distance using {lat_col}/{lon_col}, "
                                f"filtered at {params['max_gps_segment_speed_mps']:.1f} m/s")
            distance_required_channels = [lat_col, lon_col]
        else:
            distance_failure = "GPS lat/lon found, but GPS distance was invalid or too small."

    if distance_status != "ok":
        if wheel_speed_status == "ok":
            v = np.abs(speed_wheel_mps)
            v = np.nan_to_num(v, nan=0.0)
            distance_cum_m = cumtrapz(v, t)
            distance_km = distance_cum_m[-1] / 1000.0
            if np.isfinite(distance_km) and distance_km > 0:
                distance_status = "ok"
                distance_method = "Fallback: cumtrapz(abs(speed_wheel_mps), time), speed from mean AMK wheel RPMs"
                distance_required_channels = [c for c in rpm_cols if c]
            else:
                distance_failure = "Wheel-speed fallback produced invalid distance."
        else:
            if lat_col and lon_col:
                distance_failure += f" Wheel-speed fallback also unavailable: {wheel_speed_failure}"
            else:
                distance_failure = f"No valid GPS lat/lon found and wheel-speed fallback unavailable: {wheel_speed_failure}"

    if distance_status == "ok":
        derived["distance_cum_km"] = {"values": distance_cum_m / 1000.0, "unit": "km", "description": distance_method}

    sources["distance_method"] = distance_method
    sources["distance_required_channels"] = distance_required_channels
    sources["gps_quality"] = gps_quality

    # ---- KPI 2: energy consumed / regen ----
    energy_status, energy_failure, energy_method = "failed", "", ""
    energy_required_channels = []
    total_energy_consumed_Wh, regen_energy_Wh = None, None
    power_W = None

    power_col = find_channel_flexible(df.columns, POWER_CANDIDATES)
    if power_col:
        power_W = df[power_col].to_numpy(dtype=float)
        energy_method = f"Power from {power_col}; consumed energy = trapz(max(power_W,0), time) / 3600"
        energy_required_channels = [power_col]
        energy_status = "ok"
    else:
        v_col = find_channel_flexible(df.columns, VOLTAGE_CANDIDATES)
        i_col = find_channel_flexible(df.columns, CURRENT_CANDIDATES)
        if v_col and i_col:
            power_W = df[v_col].to_numpy(dtype=float) * df[i_col].to_numpy(dtype=float)
            energy_method = (f"Power from {v_col} .* {i_col}; "
                             f"consumed energy = trapz(max(power_W,0), time) / 3600")
            energy_required_channels = [v_col, i_col]
            energy_status = "ok"
        else:
            missing = [n for n, c in (("isa_voltage", v_col), ("isa_current", i_col)) if c is None]
            energy_failure = f"Missing isa_power and fallback voltage/current channels: {', '.join(missing)}"

    if energy_status == "ok":
        if power_W.size != n_ref or np.sum(np.isfinite(power_W)) < 2:
            energy_status = "failed"
            energy_failure = "Power signal exists, but does not have enough finite samples."
        else:
            power_clean = np.nan_to_num(power_W, nan=0.0)
            power_consumed_W = np.maximum(power_clean, 0)
            power_regen_W = np.maximum(-power_clean, 0)
            energy_consumed_cum_Wh = cumtrapz(power_consumed_W, t) / 3600.0
            regen_energy_cum_Wh = cumtrapz(power_regen_W, t) / 3600.0
            total_energy_consumed_Wh = float(energy_consumed_cum_Wh[-1])
            regen_energy_Wh = float(regen_energy_cum_Wh[-1])

            derived["power_W"] = {"values": power_W, "unit": "W", "description": energy_method}
            derived["energy_consumed_cum_Wh"] = {"values": energy_consumed_cum_Wh, "unit": "Wh",
                                                  "description": "Cumulative consumed energy from positive power"}
            derived["regen_energy_cum_Wh"] = {"values": regen_energy_cum_Wh, "unit": "Wh",
                                               "description": "Cumulative regenerated energy from negative power, expressed as positive Wh"}

    sources["energy_method"] = energy_method
    sources["energy_required_channels"] = energy_required_channels

    # ---- KPI 3: energy per km ----
    energy_per_km_status, energy_per_km_failure, energy_per_km_Wh_km = "failed", "", None
    if distance_status == "ok" and energy_status == "ok":
        if distance_km and distance_km > 0 and total_energy_consumed_Wh is not None and np.isfinite(total_energy_consumed_Wh):
            energy_per_km_Wh_km = total_energy_consumed_Wh / distance_km
            energy_per_km_status = "ok"
        else:
            energy_per_km_failure = "Invalid distance or energy value."
    else:
        energy_per_km_failure = (f"Cannot compute Wh/km because distance status is {distance_status} "
                                 f"and energy status is {energy_status}.")

    # ---- KPI 4: duration ----
    duration_status = "ok" if np.isfinite(run_duration_s) and run_duration_s > 0 else "failed"
    duration_failure = "" if duration_status == "ok" else "Invalid time vector."

    kpis = {
        "distance_km": make_kpi(distance_km, "km", distance_status, distance_method,
                                 distance_required_channels, distance_failure),
        "total_energy_consumed_Wh": make_kpi(total_energy_consumed_Wh, "Wh", energy_status, energy_method,
                                              energy_required_channels, energy_failure),
        "energy_per_km_Wh_km": make_kpi(energy_per_km_Wh_km, "Wh/km", energy_per_km_status,
                                         "total_energy_consumed_Wh / distance_km",
                                         ["distance_km", "total_energy_consumed_Wh"], energy_per_km_failure),
        "run_duration_s": make_kpi(run_duration_s, "s", duration_status, "time(end) - time(1)",
                                    ["Time"], duration_failure),
        "regen_energy_Wh": make_kpi(regen_energy_Wh, "Wh", energy_status,
                                    "trapz(max(-power_W,0), time) / 3600",
                                    energy_required_channels, energy_failure),
    }

    return derived, kpis, sources


def estimate_signal_period(t, vals, fallback_dt):
    """Reverse-engineers a signal's arrival period by checking consecutive
    intervals where values change or reappear.
    """
    finite_mask = np.isfinite(vals)
    t_finite = t[finite_mask]
    vals_finite = vals[finite_mask]

    if len(t_finite) < 2:
        return fallback_dt

    # If forward-filled: trace when values actually change
    changes = np.diff(vals_finite) != 0
    update_indices = np.where(changes)[0] + 1
    update_indices = np.concatenate(([0], update_indices))

    if len(update_indices) > 1:
        t_updates = t_finite[update_indices]
        dt = np.median(np.diff(t_updates))
        return float(dt) if dt > 0 else fallback_dt

    # Otherwise fallback to distance between valid coordinates
    dt = np.median(np.diff(t_finite))
    return float(dt) if dt > 0 else fallback_dt


def extract_from_csv(csv_path, proto_lut):
    """CSV entry point: reads a Level 1 wide-format CSV (Time + all channel
    columns, as exported by fcp-data-muncher) and runs the full Level 2
    pipeline directly in Python -- no MATLAB step required.
    """
    if pd is None:
        sys.exit("Missing dependency: pip install pandas --break-system-packages")

    df = pd.read_csv(csv_path)
    time_col = find_channel_flexible(df.columns, ["Time", "time", "t", "t_ref"])
    if time_col is None:
        sys.exit("CSV has no recognizable time column (expected 'Time').")

    t = df[time_col].to_numpy(dtype=float)
    if len(t) < 2:
        sys.exit("CSV time column has fewer than 2 samples.")

    duration_s = float(t[-1] - t[0])
    dt_ref = float(np.median(np.diff(t)))
    sample_rate_hz = 1.0 / dt_ref if dt_ref > 0 else None

    derived, kpis, sources = compute_level2(df, t)

    channels = []
    errors = []
    unresolved_names = []

    data_cols = [c for c in df.columns if c != time_col]
    for name in data_cols:
        vals = df[name].to_numpy(dtype=float)
        n = vals.size
        finite = vals[np.isfinite(vals)]
        nan_pct = round(100 * (1 - finite.size / max(n, 1)), 2)
        vmin = round(float(np.min(finite)), 4) if finite.size else None
        vmax = round(float(np.max(finite)), 4) if finite.size else None
        vmean = round(float(np.mean(finite)), 4) if finite.size else None

        # Reverse engineer period via sample deltas
        signal_period = estimate_signal_period(t, vals, fallback_dt=dt_ref)

        resolved, matched_base = resolve_signal(name, proto_lut)
        if resolved is None:
            unresolved_names.append(name)

        channels.append({
            "key": name, "name": name, "type": "double",
            "device": resolved["device"] if resolved else "unresolved",
            "device_resolved": resolved is not None,
            "protocol_signal": matched_base,
            "unit": resolved["unit"] if resolved else "",
            "scale": resolved["scale"] if resolved else None,
            "protocol_min": resolved["min_value"] if resolved else None,
            "protocol_max": resolved["max_value"] if resolved else None,
            "can_message": resolved["message"] if resolved else None,
            "mat_tool_tag": "csv-import",
            "period_s": round(signal_period, 5),
            "n_samples": n, "nan_pct": nan_pct,
            "min": vmin, "max": vmax, "mean": vmean,
            "component": component_for(name, resolved),
        })

    # Derived Level 2 channels (speed_wheel_mps, power_W, distance_cum_km, ...)
    for name, d in derived.items():
        vals = d["values"]
        finite = vals[np.isfinite(vals)]
        channels.append({
            "key": name, "name": name, "type": "double",
            "device": "Level2 (derived)", "device_resolved": True,
            "protocol_signal": None, "unit": d["unit"], "scale": None,
            "protocol_min": None, "protocol_max": None, "can_message": None,
            "mat_tool_tag": "Level2",
            "period_s": round(dt_ref, 5),
            "n_samples": vals.size,
            "nan_pct": round(100 * (1 - finite.size / max(vals.size, 1)), 2),
            "min": round(float(np.min(finite)), 4) if finite.size else None,
            "max": round(float(np.max(finite)), 4) if finite.size else None,
            "mean": round(float(np.mean(finite)), 4) if finite.size else None,
            "component": "Level 2 Derived",
        })

    if unresolved_names:
        errors.append(
            f"{len(unresolved_names)} channel(s) could not be matched against the "
            f"protocol (fst.json) and were labeled 'Unresolved': "
            f"{', '.join(unresolved_names[:15])}"
            f"{'...' if len(unresolved_names) > 15 else ''}"
        )

    return {
        "channels": channels,
        "n_channels": len(channels),
        "n_unresolved": len(unresolved_names),
        "duration_s": round(duration_s, 3),
        "sample_rate_hz": round(sample_rate_hz, 3) if sample_rate_hz else None,
        "extraction_errors": errors,
        "level": "Level2",
        "kpis": kpis,
        "level2_sources": sources,
    }


# Device name -> human-readable component label, for catalogue grouping/search.
DEVICE_LABELS = {
    "iib": "Inverter Interface Board", "dash": "Dashboard", "se": "Sensors/Electronics",
    "te": "Throttle/Brake Plausibility", "master": "BMS Master", "telemetry": "Telemetry",
    "interface": "Driver Interface", "hw": "Hardware/Shutdown Circuit", "wc": "Cooling",
    "isabel": "Energy Meter (ISA)", "gss": "Ground Speed Sensor", "sw": "Steering Wheel",
    "as": "Autonomous System", "acu": "Accumulator (BMS)", "res": "Remote E-Stop",
    "xsens": "IMU", "pitot_tube": "Pitot Tube (Airspeed)", "etas": "ETAS",
    "ami": "Autonomous Mission Indicator", "suspot": "Suspension Travel", "pdu": "Power Distribution",
    "fdu": "Front Drive Unit", "netas": "ETAS (network)", "strain_gauges": "Strain Gauge",
}

FALLBACK_COMPONENT_RULES = [
    ("amk", "Inverters/Motors"), ("inv_", "Inverters/Motors"), ("ebs", "EBS / Autonomous Braking"),
    ("as_", "Autonomous System"), ("master_", "BMS Master"), ("cell_", "Battery Cells"),
    ("isa_", "Energy Meter (ISA)"), ("bp", "Brake Pressure"), ("iib_", "Inverter Interface Board"),
    ("pot_", "Suspension Travel"), ("steering", "Steering"), ("gyr", "IMU"), ("acc", "IMU"),
    ("mag", "IMU"), ("yaw", "IMU"), ("pitch", "IMU"), ("roll", "IMU"),
    ("fuse_", "Power Distribution"), ("wc_", "Cooling"), ("te_", "Throttle/Brake Plausibility"),
    ("dash", "Dashboard"), ("sg_", "Strain Gauge"), ("sta_", "Steering Actuator"),
    ("cmd_", "Motor Commands"), ("regen", "Regen Braking"), ("io_", "I/O"), ("port_sw", "I/O"),
    ("shutdown", "Shutdown Circuit"), ("car_", "Car State"), ("button", "Buttons"),
    ("radio", "Radio"), ("lidar", "Lidar"), ("pc_power", "Compute"),
]


def load_protocol(proto_path):
    if proto_path is None:
        print("WARNING: no --protocol given. Every channel will be labeled 'Unresolved'.", file=sys.stderr)
        return {}
    if not Path(proto_path).exists():
        print(f"WARNING: --protocol path does not exist: {proto_path}.", file=sys.stderr)
        return {}
    proto = json.loads(Path(proto_path).read_text())
    lut = {}
    for dev_key, dv in proto.get("devices", {}).items():
        dname = dv.get("name", dev_key)
        for msg_key, mv in dv.get("msgs", {}).items():
            freq = mv.get("frequency")
            for sig_key, sv in mv.get("signals", {}).items():
                lut[sig_key] = {
                    "device": dname,
                    "unit": sv.get("unit", "") or "",
                    "scale": sv.get("scale"),
                    "offset": sv.get("offset"),
                    "min_value": sv.get("min_value"),
                    "max_value": sv.get("max_value"),
                    "message": msg_key,
                    "frequency_ms": freq,
                }
    return lut


def resolve_signal(name, proto_lut):
    if name in proto_lut:
        return proto_lut[name], name
    stripped = re.sub(r'\d+$', '', name)
    if stripped != name and stripped in proto_lut:
        return proto_lut[stripped], stripped
    return None, None


def component_for(name, resolved_meta):
    if resolved_meta is not None:
        return DEVICE_LABELS.get(resolved_meta["device"], resolved_meta["device"])
    n = name.lower()
    for prefix, group in FALLBACK_COMPONENT_RULES:
        if prefix in n:
            return f"{group} (unverified — not in protocol)"
    return "Unresolved — not found in protocol"


def decode_uint16_str(ds) -> str:
    try:
        arr = np.array(ds[()]).flatten()
        return "".join(chr(int(c)) for c in arr if c != 0)
    except Exception:
        return ""


def read_cellstr(f, ds):
    out = []
    try:
        refs = np.array(ds[()]).flatten()
        for r in refs:
            if isinstance(r, h5py.Reference) and r:
                out.append(decode_uint16_str(f[r]))
    except Exception:
        pass
    return out


def read_scalar_num(ds):
    try:
        val = np.array(ds[()]).flatten()[0]
        return float(val)
    except Exception:
        return None


def extract_level2_kpis(f):
    if "level2Info" not in f:
        return None

    info = f["level2Info"]
    kpis = {}
    if "kpis" in info:
        kg = info["kpis"]
        for kpi_name in kg.keys():
            kd = kg[kpi_name]
            try:
                kpis[kpi_name] = {
                    "value": read_scalar_num(kd["value"]) if "value" in kd else None,
                    "unit": decode_uint16_str(kd["unit"]) if "unit" in kd else "",
                    "status": decode_uint16_str(kd["status"]) if "status" in kd else "unknown",
                    "method": decode_uint16_str(kd["method"]) if "method" in kd else "",
                    "required_channels": read_cellstr(f, kd["required_channels"]) if "required_channels" in kd else [],
                    "failure_reason": decode_uint16_str(kd["failure_reason"]) if "failure_reason" in kd else "",
                }
            except Exception as e:
                kpis[kpi_name] = {
                    "value": None, "unit": "", "status": "failed", "method": "",
                    "required_channels": [], "failure_reason": f"Could not parse KPI struct: {e}",
                }

    meta = {}
    try:
        meta["time_source"] = decode_uint16_str(info["timeSource"]) if "timeSource" in info else ""
        meta["created_at"] = decode_uint16_str(info["createdAt"]) if "createdAt" in info else ""
    except Exception:
        pass

    return {"kpis": kpis, "meta": meta}


def extract(mat_path: Path, proto_lut: dict) -> dict:
    f = h5py.File(mat_path, "r")

    skip = {"#refs#", "resampleInfo", "level2Info"}
    keys = sorted(k for k in f.keys() if k not in skip)

    channels = []
    errors = []
    unresolved_names = []

    for k in keys:
        g = f[k]
        try:
            name = decode_uint16_str(g["Channelname"]) or k
            ctype = decode_uint16_str(g["Channeltype"]) if "Channeltype" in g else ""
            mat_tool_tag = decode_uint16_str(g["device"]) if "device" in g else ""

            period = None
            if "period" in g:
                period = float(np.array(g["period"][()]).flatten()[0])

            n, nan_pct = 0, None
            vmin = vmax = vmean = None
            if "signals" in g and "values" in g["signals"]:
                vals = np.array(g["signals"]["values"][()]).flatten()
                n = int(vals.size)
                finite = vals[np.isfinite(vals)]
                nan_pct = round(100 * (1 - finite.size / max(n, 1)), 2)
                if finite.size:
                    vmin = round(float(np.min(finite)), 4)
                    vmax = round(float(np.max(finite)), 4)
                    vmean = round(float(np.mean(finite)), 4)

            resolved, matched_base = resolve_signal(name, proto_lut)

            is_level2_derived = (mat_tool_tag == "Level2")
            if is_level2_derived:
                own_unit = decode_uint16_str(g["unit"]) if "unit" in g else ""
                channels.append({
                    "key": k, "name": name, "type": ctype,
                    "device": "Level2 (derived)", "device_resolved": True,
                    "protocol_signal": None, "unit": own_unit, "scale": None,
                    "protocol_min": None, "protocol_max": None, "can_message": None,
                    "mat_tool_tag": mat_tool_tag,
                    "period_s": round(period, 5) if period else None,
                    "n_samples": n, "nan_pct": nan_pct,
                    "min": vmin, "max": vmax, "mean": vmean,
                    "component": "Level 2 Derived",
                })
                continue

            if resolved is None:
                unresolved_names.append(name)

            channels.append({
                "key": k, "name": name, "type": ctype,
                "device": resolved["device"] if resolved else "unresolved",
                "device_resolved": resolved is not None,
                "protocol_signal": matched_base,
                "unit": resolved["unit"] if resolved else "",
                "scale": resolved["scale"] if resolved else None,
                "protocol_min": resolved["min_value"] if resolved else None,
                "protocol_max": resolved["max_value"] if resolved else None,
                "can_message": resolved["message"] if resolved else None,
                "mat_tool_tag": mat_tool_tag,
                "period_s": round(period, 5) if period else None,
                "n_samples": n, "nan_pct": nan_pct,
                "min": vmin, "max": vmax, "mean": vmean,
                "component": component_for(name, resolved),
            })
        except Exception as e:
            errors.append(f"Channel '{k}' failed to extract: {e}")

    sample_rate_hz, duration_s = None, None
    if "resampleInfo" in f:
        ri = f["resampleInfo"]
        try:
            sample_rate_hz = float(np.array(ri["fs_ref"][()]).flatten()[0])
        except Exception:
            pass
        try:
            t_ref = np.array(ri["t_ref"][()]).flatten()
            duration_s = float(t_ref[-1] - t_ref[0])
        except Exception:
            pass

    if duration_s is None and channels:
        longest = max(channels, key=lambda c: c["n_samples"])
        if longest["period_s"] and longest["n_samples"]:
            duration_s = longest["period_s"] * longest["n_samples"]

    l2_data = extract_level2_kpis(f)

    return {
        "channels": channels,
        "n_channels": len(channels),
        "n_unresolved": len(unresolved_names),
        "duration_s": round(duration_s, 3) if duration_s else None,
        "sample_rate_hz": round(sample_rate_hz, 3) if sample_rate_hz else None,
        "extraction_errors": errors,
        "level": "Level2" if l2_data else "Level1",
        "kpis": l2_data["kpis"] if l2_data else {},
        "level2_meta": l2_data["meta"] if l2_data else {},
    }


def main():
    parser = argparse.ArgumentParser(description="Extract telemetry data to Run Catalogue JSON schema.")
    parser.add_argument("input_file", help="Path to a resampled .mat file or Level 1 CSV.")
    parser.add_argument("-o", "--output", help="Output path for the generated JSON.")
    parser.add_argument("--event", default="Unknown Event")
    parser.add_argument("--session-type", default="Testing")
    parser.add_argument("--driver", default="Unknown Driver")
    parser.add_argument("--class", dest="car_class", default="Class 1 EV")
    parser.add_argument("--origin", default="real")
    parser.add_argument("--protocol", help="Path to fst.json protocol file.")
    parser.add_argument("--aeropack", action="store_true")
    parser.add_argument("--springs", default="Medium")
    parser.add_argument("--arb", default="Medium")

    args = parser.parse_args()
    input_path = Path(args.input_file)

    if not input_path.exists():
        sys.exit(f"Input file not found: {input_path}")

    proto_lut = load_protocol(args.protocol)

    if input_path.suffix.lower() == ".csv":
        out_data = extract_from_csv(input_path, proto_lut)
    elif input_path.suffix.lower() == ".mat":
        if h5py is None:
            sys.exit("Missing dependency: pip install h5py --break-system-packages")
        out_data = extract(input_path, proto_lut)
    else:
        sys.exit("Unsupported file extension. Must be .csv or .mat")

    # Construct the metadata block for Run Catalogue interface
    payload = {
        "event": args.event,
        "session_type": args.session_type,
        "driver": args.driver,
        "car_class": args.car_class,
        "origin": args.origin,
        "aeropack": args.aeropack,
        "setup_springs": args.springs,
        "setup_arb": args.arb,
        "filename": input_path.name,
        **out_data
    }

    output_path = args.output or input_path.with_suffix(".json")
    Path(output_path).write_text(json.dumps(payload, indent=2))
    print(f"Successfully generated payload structure metadata at: {output_path}")


if __name__ == "__main__":
    main()
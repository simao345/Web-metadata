#!/usr/bin/env python3
"""
extract_run.py

Converts a resampled .mat file produced by fcp-data-muncher into a single
JSON file matching the schema expected by the FST Lisboa Run Catalogue
web interface (index.html -> "Add Run" panel).

Usage:
    python3 extract_run.py path/to/run_resampled.mat -o run_export.json \
        --event "FSPT Testing Day" --session-type "Autocross" --driver "Driver A" \
        --aeropack --springs Medium --arb Stiff --class "Class 1 EV" --origin real

Requirements:
    pip install h5py numpy --break-system-packages
    (older, non-v7.3 .mat files would need scipy.io.loadmat instead of h5py —
     this script assumes the v7.3/HDF5 format that fcp-data-muncher outputs)

What it does:
    - Reads every top-level channel group, pulling Channelname/Channeltype/device
    - Computes per-channel stats: n_samples, % missing (NaN), min/max/mean
    - Reads resampleInfo for sample rate / duration
    - Buckets each channel into a coarse "component" group for catalogue search
    - Writes one JSON file: {metadata fields..., channels: [...]}

This output is NOT raw (Level 0) and NOT yet KPI-derived (Level 2) — it is the
Level 1 channel catalogue + stats that the web interface indexes for search.
The full per-sample time series stays in the original .mat file; only summary
stats are exported here to keep the catalogue lightweight.
"""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

try:
    import h5py
except ImportError:
    sys.exit("Missing dependency: pip install h5py --break-system-packages")


# Device name -> human-readable component label, for catalogue grouping/search.
# Keys must match the "name" field of each device in the protocol JSON (fst.json).
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

# Fallback substring rules ONLY for channels that can't be resolved against the
# protocol (fst.json) at all -- e.g. debug/internal fields not in any device's
# signal list. These are last-resort guesses and are flagged as such.
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
    """Load fst.json (CAN protocol definition) and build a signal-name lookup.

    Returns a dict: signal_name -> {device, unit, scale, offset, min_value,
    max_value, message, frequency_ms}. Muxed signals (e.g. per-corner motor
    values) are stored once under their base name; the caller is responsible
    for stripping numeric suffixes added by fcp-data-muncher when it expands
    a muxed signal into N separate logged channels.
    """
    if proto_path is None or not Path(proto_path).exists():
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
    """Resolve a logged channel name against the protocol lookup.

    Tries an exact match first, then strips a trailing numeric suffix
    (handles muxed signals like amk_actual_speed0..3 expanded by the
    data-muncher from a single protocol-defined signal). Returns
    (meta_dict_or_None, matched_name_or_None).
    """
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


def extract(mat_path: Path, proto_lut: dict) -> dict:
    f = h5py.File(mat_path, "r")

    skip = {"#refs#", "resampleInfo"}
    keys = sorted(k for k in f.keys() if k not in skip)

    channels = []
    errors = []
    unresolved_names = []

    for k in keys:
        g = f[k]
        try:
            name = decode_uint16_str(g["Channelname"]) or k
            ctype = decode_uint16_str(g["Channeltype"]) if "Channeltype" in g else ""
            # NOTE: the 'device' group in the .mat file is the name of the
            # conversion tool (e.g. 'fcp-data-muncher'), NOT the CAN device
            # that produced the signal. The real device comes from resolving
            # the channel name against the protocol (fst.json) below.
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

    # Sample rate / duration from resampleInfo, fallback to first channel's period
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
            duration_s = round(longest["period_s"] * (longest["n_samples"] - 1), 3)
    if sample_rate_hz is None and duration_s and channels:
        longest = max(channels, key=lambda c: c["n_samples"])
        sample_rate_hz = round(longest["n_samples"] / duration_s, 3) if duration_s else None

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
        "duration_s": round(duration_s, 3) if duration_s else None,
        "sample_rate_hz": round(sample_rate_hz, 3) if sample_rate_hz else None,
        "extraction_errors": errors,  # surfaced by the web UI's error-flagging panel
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mat_file", type=Path, help="Path to the *_resampled.mat file")
    p.add_argument("-o", "--output", type=Path, default=None, help="Output JSON path (default: alongside input)")
    p.add_argument("--protocol", type=Path, default=None,
                    help="Path to fst.json (CAN protocol definition). Strongly recommended -- "
                         "without it, device/unit/component are guessed from channel name substrings only.")
    p.add_argument("--event", required=True, help="Event name, e.g. 'FSPT Testing Day'")
    p.add_argument("--session-type", required=True, help="Skidpad / Autocross / Endurance / Acceleration / Practice")
    p.add_argument("--driver", required=True)
    p.add_argument("--date", default=None, help="YYYY-MM-DD (default: parsed from filename if possible)")
    p.add_argument("--time", default=None, help="HH:MM (default: parsed from filename if possible)")
    p.add_argument("--aeropack", action="store_true", help="Flag if aeropack was fitted")
    p.add_argument("--springs", default="Unknown", help="Spring rate setup, e.g. Soft/Medium/Stiff")
    p.add_argument("--arb", default="Unknown", help="Anti-roll bar setup")
    p.add_argument("--class", dest="car_class", default="Class 1 EV")
    p.add_argument("--origin", choices=["real", "synthetic"], default="real")
    args = p.parse_args()

    if not args.mat_file.exists():
        sys.exit(f"File not found: {args.mat_file}")

    date, time = args.date, args.time
    stem = args.mat_file.stem
    if (date is None or time is None) and "_" in stem:
        parts = stem.split("_")
        if len(parts) >= 2:
            date = date or parts[0]
            time = time or parts[1].replace("-", ":")

    extracted = extract(args.mat_file, load_protocol(args.protocol))

    run = {
        "id": f"run-{stem}",
        "file": args.mat_file.name,
        "date": date or "unknown",
        "time": time or "unknown",
        "event": args.event,
        "session_type": args.session_type,
        "driver": args.driver,
        "origin": args.origin,
        "config": {
            "aeropack": bool(args.aeropack),
            "spring_rate": args.springs,
            "arb": args.arb,
            "class": args.car_class,
        },
        "duration_s": extracted["duration_s"],
        "sample_rate_hz": extracted["sample_rate_hz"],
        "n_channels": extracted["n_channels"],
        "n_unresolved": extracted["n_unresolved"],
        "channels": extracted["channels"],
        "extraction_errors": extracted["extraction_errors"],
    }

    out_path = args.output or args.mat_file.with_suffix(".catalogue.json")
    out_path.write_text(json.dumps(run))

    print(f"Wrote {out_path}  ({extracted['n_channels']} channels, "
          f"{len(extracted['extraction_errors'])} extraction errors)")
    if extracted["extraction_errors"]:
        print("Errors:")
        for e in extracted["extraction_errors"]:
            print(f"  - {e}")
    print("\nNext step: open the web catalogue -> 'Add Run' -> upload this JSON file.")


if __name__ == "__main__":
    main()

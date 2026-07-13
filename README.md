# FST Lisboa Telemetry Browser

This repository contains a lightweight telemetry browser for Formula Student runs.
It splits the workflow into two parts:

1. `extract_run.py` converts a raw Level 1/Level 2 telemetry file into:
   - `catalogue.json` for metadata and search
   - `telemetry/<run-id>.json` for the actual channel samples
2. `index.html` + `app.js` + `style.css` provide the browser UI for browsing runs, plotting channels, comparing runs, and viewing per-run metadata.

## Repository layout

- `index.html`: main web app entry point
- `app.js`: frontend logic
- `style.css`: UI styling
- `extract_run.py`: exporter that updates the catalogue and writes telemetry JSON
- `catalogue.json`: searchable run metadata used by the web app
- `telemetry/`: per-run telemetry files loaded on demand
- `fst.json`: CAN protocol definition used during extraction
- `fst_catalogue.html`: legacy single-file version kept for reference

## Requirements

- Python 3.10 or newer
- `numpy`
- `pandas` for CSV input
- `h5py` for MAT input

Install the Python dependencies with:

```bash
pip install numpy pandas h5py
```

If you are using a system Python on Linux, you may need:

```bash
pip install --break-system-packages numpy pandas h5py
```

## Running the browser

The app must be served over HTTP. Do not open `index.html` directly with `file://`.

From the repository root, start a simple web server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

If you are running this inside WSL, keep the server running there and open `http://localhost:8000` in your Windows browser.

## Exporting a run

Use `extract_run.py` to add a run to the catalogue and generate its telemetry file.

### From CSV

```bash
python3 extract_run.py path/to/run.csv \
  --protocol fst.json \
  --event "Testing Day" \
  --session-type "Autocross" \
  --driver "Driver A" \
  --date 2026-02-26 \
  --time 12:21:00 \
  --springs Medium \
  --arb Stiff \
  --class "Class 1 EV" \
  --origin real
```

### From MAT

```bash
python3 extract_run.py path/to/run.mat \
  --protocol fst.json \
  --event "Testing Day" \
  --session-type "Autocross" \
  --driver "Driver A"
```

### Output

The exporter updates:

- `catalogue.json`
- `telemetry/<run-id>.json`

The web app loads `catalogue.json` first and only fetches the telemetry file for the run you open.

## Common options

- `--catalogue`: path to the catalogue file to update, default `catalogue.json`
- `--telemetry-dir`: output directory for run telemetry JSON, default `telemetry`
- `--telemetry-rate`: display rate for exported telemetry, default `50`
- `--protocol`: CAN protocol file, usually `fst.json`
- `--event`: event name
- `--session-type`: run type such as `Skidpad`, `Autocross`, `Endurance`, `Acceleration`, or `Practice`
- `--driver`: driver name
- `--date` and `--time`: run timestamp metadata
- `--aeropack`: set if the aeropack was fitted
- `--springs`: spring setup label
- `--arb`: anti-roll bar setup label
- `--class`: vehicle class label
- `--origin`: `real` or `synthetic`

## What the browser shows

- Run catalogue with filtering by event, driver, session type, and search text
- Overview tab with metadata and KPI summary
- Channels tab with channel metadata and quality hints
- Graphs tab with Plotly plots
- Statistics tab with basic per-channel stats
- Notes tab with local browser notes
- Files tab with the source file and telemetry file references

## Notes

- Notes are stored locally in the browser on that machine. They are not written back to `catalogue.json`.
- The exporter expects the protocol file to describe the channels found in the source data.
- The repository still includes `fst_catalogue.html` as a legacy version, but `index.html` is the current entry point.

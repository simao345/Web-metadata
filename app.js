const state = { runs: [], active: null, selected: new Set(), tab: 'Overview', telemetry: new Map() };
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const duration = (seconds) => seconds == null ? '—' : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const unique = (values) => [...new Set(values.filter(Boolean))].sort();
const notesKey = (runId) => `fst-telemetry-note:${runId}`;
const number = (value) => Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 3) : '—';

async function init() {
  try {
    const response = await fetch('catalogue.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalogue = await response.json();
    state.runs = catalogue.runs || [];
    populateFilters(); renderList();
    $('#status').textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} indexed`;
  } catch (error) {
    $('#status').textContent = 'Catalogue unavailable';
    $('#runList').innerHTML = `<p class="error">Could not load catalogue.json: ${esc(error.message)}. Serve this folder with a web server rather than opening the file directly.</p>`;
  }
}

function populateFilters() {
  [['#eventFilter','event'],['#driverFilter','driver'],['#sessionFilter','session_type']].forEach(([selector,key]) => {
    const select = $(selector);
    unique(state.runs.map(run => run[key])).forEach(value => select.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(value)}</option>`));
    select.onchange = renderList;
  });
  $('#search').oninput = renderList;
  $('#clearFilters').onclick = () => { $('#search').value = ''; ['#eventFilter','#driverFilter','#sessionFilter'].forEach(s => $(s).value = ''); renderList(); };
  $('#compareButton').onclick = openComparison;
  $('#kpiButton').onclick = openKpiBuilder;
}

function matches(run) {
  const text = $('#search').value.trim().toLowerCase();
  if ($('#eventFilter').value && run.event !== $('#eventFilter').value) return false;
  if ($('#driverFilter').value && run.driver !== $('#driverFilter').value) return false;
  if ($('#sessionFilter').value && run.session_type !== $('#sessionFilter').value) return false;
  const channelIndex = (run.channels || []).map(channel => [channel.key, channel.name, channel.component, channel.device, channel.unit].join(' '));
  return !text || [run.event, run.driver, run.file, run.session_type, run.channel_names?.join(' '), channelIndex.join(' ')].join(' ').toLowerCase().includes(text);
}

function renderList() {
  const runs = state.runs.filter(matches);
  $('#resultCount').textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
  $('#summary').innerHTML = `<strong>${state.runs.length}</strong> indexed runs<br><strong>${state.runs.reduce((n, r) => n + (r.n_channels || 0), 0)}</strong> channel definitions`;
  $('#compareButton').textContent = `Compare selected (${state.selected.size})`;
  $('#compareButton').disabled = state.selected.size !== 2;
  $('#kpiButton').textContent = `KPI builder (${state.selected.size})`;
  $('#kpiButton').disabled = state.selected.size === 0;
  $('#runList').innerHTML = runs.length ? runs.map(run => `<button class="run ${state.active?.id === run.id ? 'active' : ''} ${state.selected.has(run.id) ? 'selected' : ''}" data-id="${esc(run.id)}"><div class="run-title"><span>${esc(run.event || 'Untitled run')}</span><input class="select-run" type="checkbox" aria-label="Select for comparison" ${state.selected.has(run.id) ? 'checked' : ''}></div><small>${esc(run.file || run.id)}</small><div class="run-meta"><span>${esc(run.driver || 'Unknown driver')}</span><span class="tag">${duration(run.duration_s)}</span><span class="tag">${run.n_channels || 0} ch</span></div></button>`).join('') : '<p class="notice">No runs match these filters.</p>';
  document.querySelectorAll('.run').forEach(button => {
    button.onclick = event => { if (event.target.classList.contains('select-run')) return; openRun(button.dataset.id); };
    button.querySelector('.select-run').onchange = event => { event.stopPropagation(); toggleSelection(button.dataset.id, event.target.checked); };
  });
}

function toggleSelection(id, checked) {
  // Comparison overlay (openComparison) stays a strict 2-run visual, but the
  // live KPI builder needs 3+ runs (per the extensibility/judging criterion),
  // so selection itself is no longer capped at 2. compareButton disables
  // itself above whenever selection.size !== 2.
  const MAX_SELECTED = 10;
  if (checked && state.selected.size >= MAX_SELECTED) { const [first] = state.selected; state.selected.delete(first); }
  checked ? state.selected.add(id) : state.selected.delete(id); renderList();
}

async function loadTelemetry(run) {
  if (!run.telemetry_file) return null;
  if (state.telemetry.has(run.id)) return state.telemetry.get(run.id);
  const response = await fetch(run.telemetry_file);
  if (!response.ok) throw new Error(`Could not load ${run.telemetry_file} (HTTP ${response.status})`);
  const telemetry = await response.json(); state.telemetry.set(run.id, telemetry); return telemetry;
}

async function openRun(id) {
  state.active = state.runs.find(run => run.id === id); state.tab = 'Overview'; renderList(); await renderWorkspace();
}

function kpiCards(run) {
  return Object.entries(run.kpis || {}).map(([name, kpi]) => `<div class="metric"><span>${esc(name.replaceAll('_', ' '))}</span><strong>${kpi.status === 'ok' ? `${Number(kpi.value).toFixed(2)} ${esc(kpi.unit || '')}` : '—'}</strong></div>`).join('');
}
function baseWorkspace(run) {
  return `<div class="run-header"><div><h2>${esc(run.event)} — ${esc(run.session_type)}</h2><p>${esc(run.driver)} · ${esc(run.date)} ${esc(run.time || '')} · ${esc(run.file)}</p></div><span class="tag">${run.telemetry_file ? 'Telemetry available' : 'Metadata only'}</span></div><nav class="tabs">${['Overview','Channels','Graphs','Statistics','Notes','Files'].map(tab => `<button class="tab ${state.tab === tab ? 'active' : ''}" data-tab="${tab}">${tab}</button>`).join('')}</nav><div id="tabContent"></div>`;
}
function logValue(value) { return value === null || value === undefined || value === '' ? '<span class="placeholder">Not recorded</span>' : esc(value); }
function logSection(title, fields) { return `<div class="log-section"><h3>${title}</h3>${fields.map(([label, value]) => `<div><span>${label}</span><strong>${logValue(value)}</strong></div>`).join('')}</div>`; }
function manualLogOverview(run) {
  const log = run.manual_log || {}, config = run.config || {};
  return `<div class="manual-log"><h3 class="manual-title">Manual test log</h3><p class="note-help">Context recorded alongside the telemetry; empty values identify fields still to be completed.</p><div class="log-grid">${
    logSection('Run identification', [['Event', run.event], ['Location', log.location], ['Run start', `${run.date || '—'} ${run.time || ''}`], ['Log reference', run.file]]) +
    logSection('Test objective', [['Objective', log.objective]]) +
    logSection('Driver & session', [['Driver', run.driver], ['Laps', log.laps], ['Best lap time', log.best_lap_time], ['Distance in log', run.kpis?.distance_km?.value ? `${run.kpis.distance_km.value} km` : null]]) +
    logSection('Mechanical setup', [['Tyres', log.tyres], ['Tyre pressures', log.tyre_pressures], ['Damper setup', log.damper_setup], ['Springs', config.spring_rate], ['ARB position', log.arb_position || config.arb], ['Aeropack', config.aeropack ? 'Fitted' : 'Not fitted']]) +
    logSection('Control setup', [['Torque vectoring map', log.torque_vectoring_map], ['Regen map', log.regen_map], ['Torque limits', log.torque_limits]]) +
    logSection('Energy system', [['Battery used', log.battery_used]]) +
    logSection('Data quality', [['Non-operational signals', log.non_operational_signals]]) +
    logSection('Reliability & issues', [['Issues', log.issues]]) +
    logSection('Driver feedback', [['Feedback', log.driver_feedback]]) +
    logSection('Environmental context', [['Weather', log.weather], ['Track conditions', log.track_conditions], ['Ambient temperature', log.ambient_temp], ['Grip', log.grip]])
  }</div></div>`;
}
async function renderWorkspace() {
  const run = state.active; if (!run) return;
  $('#workspace').innerHTML = baseWorkspace(run);
  document.querySelectorAll('.tab').forEach(tab => tab.onclick = async () => { state.tab = tab.dataset.tab; await renderWorkspace(); });
  const content = $('#tabContent');
  if (state.tab === 'Overview') content.innerHTML = `<div class="overview-grid"><div class="metric"><span>Driver</span><strong>${esc(run.driver)}</strong></div><div class="metric"><span>Duration</span><strong>${duration(run.duration_s)}</strong></div><div class="metric"><span>Sample rate</span><strong>${run.sample_rate_hz ? `${run.sample_rate_hz} Hz` : '—'}</strong></div><div class="metric"><span>Channels</span><strong>${run.n_channels || 0}</strong></div></div><div class="panel"><h3>Automatic KPIs</h3><div class="kpis">${kpiCards(run) || '<p class="notice">No KPI data has been exported.</p>'}</div></div>${manualLogOverview(run)}`;
  else if (state.tab === 'Channels') await renderChannels(run, content);
  else if (state.tab === 'Graphs') await renderGraphs(run, content);
  else if (state.tab === 'Statistics') await renderStatistics(run, content);
  else if (state.tab === 'Notes') renderNotes(run, content);
  else content.innerHTML = `<div class="notice">Raw source: ${esc(run.file)}<br>Telemetry: ${esc(run.telemetry_file || 'not exported yet')}</div>`;
}

async function getChannels(run) { const telemetry = await loadTelemetry(run); return telemetry?.channels || {}; }
async function renderChannels(run, content) {
  try { const channels = await getChannels(run); const names = Object.keys(channels); if (!names.length) throw new Error('This run has no telemetry file yet. Re-run extract_run.py to create it.'); const metadata = new Map((run.channels || []).map(channel => [channel.key, channel])); content.innerHTML = `<div class="channel-tools"><input id="channelFilter" placeholder="Filter ${names.length} channels, components, devices…"></div><div id="channelList" class="channel-list"></div>`; const display = () => { const q = $('#channelFilter').value.toLowerCase(); $('#channelList').innerHTML = names.filter(name => { const channel = metadata.get(name) || {}; return [name, channel.component, channel.device, channel.unit].join(' ').toLowerCase().includes(q); }).map(name => { const channel = metadata.get(name) || {}; const missing = channel.nan_pct > 5 ? '<span class="quality bad">high missing data</span>' : channel.nan_pct > .5 ? '<span class="quality warn">some missing data</span>' : ''; const unresolved = channel.device_resolved === false ? '<span class="quality warn">unresolved</span>' : ''; return `<div class="channel"><span><strong>${esc(name)}</strong><small>${esc(channel.component || 'Unclassified')} · ${esc(channel.device || 'Unknown device')} ${channel.unit ? `· ${esc(channel.unit)}` : ''} ${missing}${unresolved}</small></span><button data-channel="${esc(name)}">Plot</button></div>`; }).join(''); document.querySelectorAll('[data-channel]').forEach(button => button.onclick = async () => { state.tab = 'Graphs'; await renderWorkspace(); $('#channelSelect').value = button.dataset.channel; $('#channelSelect').dispatchEvent(new Event('change')); }); }; $('#channelFilter').oninput = display; display(); } catch (error) { content.innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}
async function renderGraphs(run, content) {
  try { const telemetry = await loadTelemetry(run); if (!telemetry?.channels || !Object.keys(telemetry.channels).length) throw new Error('No telemetry has been exported for this legacy catalogue entry.'); const names = Object.keys(telemetry.channels); content.innerHTML = `<div class="graph-controls"><select id="channelSelect">${names.map(name => `<option>${esc(name)}</option>`).join('')}</select><button id="addGraph">Add channel</button></div><div id="plot" class="plot"></div>`; const selected = new Set([names[0]]); const draw = () => { const rate = telemetry.sample_rate || telemetry.sample_rate_hz; const traces = [...selected].map((name, i) => ({x: telemetry.channels[name].map((_, index) => index / rate), y: telemetry.channels[name], type:'scattergl', mode:'lines', name, line:{width:1.5}})); Plotly.react('plot', traces, {paper_bgcolor:'#111827',plot_bgcolor:'#111827',font:{color:'#e8eefb'},margin:{l:55,r:15,t:25,b:45},xaxis:{title:'Time (s)',gridcolor:'#28354e',zerolinecolor:'#28354e'},yaxis:{gridcolor:'#28354e',zerolinecolor:'#28354e'},legend:{orientation:'h'}}, {responsive:true,displaylogo:false}); }; $('#channelSelect').onchange = () => { selected.clear(); selected.add($('#channelSelect').value); draw(); }; $('#addGraph').onclick = () => { selected.add($('#channelSelect').value); draw(); }; draw(); } catch (error) { content.innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}
async function renderStatistics(run, content) {
  try {
    const telemetry = await loadTelemetry(run);
    const channels = telemetry?.channels || {}, names = Object.keys(channels);
    if (!names.length) throw new Error('No telemetry has been exported for this run.');
    content.innerHTML = `<div class="channel-tools"><input id="statisticsFilter" placeholder="Filter ${names.length} channels"></div><div class="results-meta" id="statisticsMeta"></div><div class="scroll-table"><table><thead><tr><th>Channel</th><th>Samples</th><th>Missing</th><th>Min</th><th>Max</th><th>Mean</th><th>Std dev</th></tr></thead><tbody id="statisticsRows"></tbody></table></div>`;
    const stats = names.map(name => { const samples = channels[name]; let n=0,sum=0,sumSquares=0,min=Infinity,max=-Infinity; samples.forEach(value => { if(Number.isFinite(value)){n++;sum+=value;sumSquares+=value*value;min=Math.min(min,value);max=Math.max(max,value);} }); const mean=n?sum/n:NaN; return {name,total:samples.length,n,min,max,mean,std:n?Math.sqrt(Math.max(0,sumSquares/n-mean*mean)):NaN}; });
    const renderRows = () => { const query = $('#statisticsFilter').value.toLowerCase(), rows=stats.filter(stat => stat.name.toLowerCase().includes(query)); $('#statisticsMeta').textContent = `${rows.length} channel${rows.length === 1 ? '' : 's'} · calculated from loaded ${number(telemetry.sample_rate)} Hz telemetry`; $('#statisticsRows').innerHTML = rows.map(stat => `<tr><td>${esc(stat.name)}</td><td>${stat.n}/${stat.total}</td><td>${number(100*(1-stat.n/stat.total))}%</td><td>${number(stat.min)}</td><td>${number(stat.max)}</td><td>${number(stat.mean)}</td><td>${number(stat.std)}</td></tr>`).join(''); };
    $('#statisticsFilter').oninput = renderRows; renderRows();
  } catch (error) { content.innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}
function renderNotes(run, content) {
  const saved = localStorage.getItem(notesKey(run.id)) || '';
  content.innerHTML = `<div class="panel"><h3>Run notes</h3><p class="note-help">Notes are saved in this browser on this computer. They are not yet shared through catalogue.json.</p><textarea id="runNotes" placeholder="Driver feedback, setup changes, issues, observations…">${esc(saved)}</textarea><div class="notes-actions"><span id="noteStatus"></span><button id="saveNotes">Save notes</button></div></div>`;
  $('#saveNotes').onclick = () => { localStorage.setItem(notesKey(run.id), $('#runNotes').value); $('#noteStatus').textContent = 'Saved locally'; };
}
async function openComparison() {
  const runs = [...state.selected].map(id => state.runs.find(run => run.id === id)); state.active = null; renderList(); $('#workspace').innerHTML = `<div class="run-header"><div><h2>Run comparison</h2><p>Select the same channel in both telemetry files to overlay it.</p></div></div><div id="comparison" class="notice">Loading selected telemetry…</div>`;
  try { const data = await Promise.all(runs.map(loadTelemetry)); if (data.some(item => !item)) throw new Error('Both selected runs need exported telemetry files.'); const common = Object.keys(data[0].channels).filter(name => name in data[1].channels); if (!common.length) throw new Error('The selected runs have no channels in common.'); $('#comparison').outerHTML = `<div id="comparison"><div class="graph-controls"><select id="compareChannel">${common.map(name => `<option>${esc(name)}</option>`).join('')}</select></div><div id="comparePlot" class="plot"></div></div>`; const draw = () => { const channel = $('#compareChannel').value; Plotly.react('comparePlot', data.map((telemetry, index) => ({x: telemetry.channels[channel].map((_, i) => i / telemetry.sample_rate),y:telemetry.channels[channel],type:'scattergl',mode:'lines',name:`${runs[index].event} — ${runs[index].driver}`})), {paper_bgcolor:'#111827',plot_bgcolor:'#111827',font:{color:'#e8eefb'},margin:{l:55,r:15,t:25,b:45},xaxis:{title:'Time (s)',gridcolor:'#28354e'},yaxis:{gridcolor:'#28354e'},legend:{orientation:'h'}}, {responsive:true,displaylogo:false}); }; $('#compareChannel').onchange=draw; draw(); } catch (error) { $('#comparison').innerHTML = esc(error.message); }
}

// ============================================================================
// LIVE KPI BUILDER
// Lets a judge propose a brand-new KPI during the "Extensibility" challenge.
// Reuses whatever runs are already selected in the sidebar (no cap now),
// reads the telemetry channels already fetched via loadTelemetry(), and
// evaluates a small formula language directly in-browser -- no re-running
// extract_run.py against raw files is required. Each run gets its own
// try/catch so a missing channel on one run shows a per-row failure reason
// (the same fault-plan spirit as the Python KPI pipeline) instead of
// breaking the whole table.
// ============================================================================

function sliceWindow(channels, rate, startS, endS) {
  // Lazily slices each channel array to [startS, endS) seconds, in samples,
  // only when that channel is actually referenced by the formula (via the
  // Proxy `get`/`has` traps below) -- this avoids slicing every channel in
  // a run up front when a formula only touches one or two of them.
  const hasWindow = (Number.isFinite(startS) && startS > 0) || Number.isFinite(endS);
  if (!hasWindow) return channels;
  const startIdx = Number.isFinite(startS) && startS > 0 ? Math.floor(startS * rate) : 0;
  const endIdx = Number.isFinite(endS) ? Math.ceil(endS * rate) : undefined;
  const cache = new Map();
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string' || !(prop in channels)) return undefined;
      if (!cache.has(prop)) cache.set(prop, channels[prop].slice(startIdx, endIdx));
      return cache.get(prop);
    },
    has(_, prop) { return prop in channels; },
  });
}

function evaluateFormula(expr, channels, rate, startS, endS) {
  const windowed = sliceWindow(channels, rate, startS, endS);
  const finite = (arr) => (arr || []).filter(Number.isFinite);
  const helpers = {
    mean:  (arr) => { const f = finite(arr); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; },
    sum:   (arr) => finite(arr).reduce((a, b) => a + b, 0),
    min:   (arr) => { const f = finite(arr); return f.length ? Math.min(...f) : NaN; },
    max:   (arr) => { const f = finite(arr); return f.length ? Math.max(...f) : NaN; },
    first: (arr) => finite(arr)[0],
    last:  (arr) => { const f = finite(arr); return f[f.length - 1]; },
    count: (arr) => finite(arr).length,
    delta: (arr) => { const f = finite(arr); return f.length ? f[f.length - 1] - f[0] : NaN; },
    std:   (arr) => {
      const f = finite(arr);
      if (!f.length) return NaN;
      const m = f.reduce((a, b) => a + b, 0) / f.length;
      return Math.sqrt(f.reduce((a, c) => a + (c - m) ** 2, 0) / f.length);
    },
    // Trapezoidal integral over time, assuming uniform sample rate (Hz).
    integral: (arr) => {
      let s = 0;
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1], b = arr[i];
        if (Number.isFinite(a) && Number.isFinite(b)) s += (a + b) / 2 / rate;
      }
      return s;
    },
  };
  // `with` is deliberately used here so formulas can reference raw channel
  // names directly (e.g. `mean(acc_lateral)`) without a `ch.` prefix. This
  // file is an internal engineering tool evaluated by the team itself, not
  // a public-facing surface, so the usual "never eval untrusted input"
  // concern does not apply -- the person typing the formula is a teammate
  // at the judging table.
  const fn = new Function('ch', 'h', `with (h) { with (ch) { return (${expr}); } }`);
  return fn(windowed, helpers);
}

async function openKpiBuilder() {
  const runs = [...state.selected].map(id => state.runs.find(run => run.id === id));
  state.active = null; renderList();
  $('#workspace').innerHTML = `<div class="run-header"><div><h2>Live KPI Builder</h2><p>Define a formula once, apply it across every selected run instantly.</p></div></div><div id="kpiWorkspace"></div>`;
  await renderKpiBuilder(runs, $('#kpiWorkspace'));
}

async function renderKpiBuilder(runs, content) {
  let lastRows = [];
  content.innerHTML = `
    <div class="panel">
      <h3>Formula</h3>
      <p class="note-help">Use channel names as variables and helpers: mean(), sum(), min(), max(), first(), last(), count(), std(), delta(), integral(). Example: <code>sum(power_W) / 3600 / last(distance_cum_km)</code></p>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>KPI name<input id="kpiName" placeholder="e.g. avg_lateral_g"></label></div>
        <div><label>Unit<input id="kpiUnit" placeholder="e.g. g"></label></div>
      </div>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>Window start (s)<input id="kpiStart" type="number" step="any" placeholder="0"></label></div>
        <div><label>Window end (s)<input id="kpiEnd" type="number" step="any" placeholder="end of run"></label></div>
      </div>
      <p class="note-help">Leave both blank to use the full run. Times are seconds from the start of each run — e.g. to match Endurance's last 30 seconds, set start to (run duration − 30) per run, or just set end and leave start blank.</p>
      <label>Formula<textarea id="kpiFormula" placeholder="mean(acc_lateral)"></textarea></label>
      <div class="notes-actions">
        <span id="kpiStatus"></span>
        <button id="kpiSave" class="quiet">Save formula</button>
        <button id="kpiExport" class="quiet">Export results (CSV)</button>
        <button id="kpiRun">Run over ${runs.length} selected run${runs.length === 1 ? '' : 's'}</button>
      </div>
    </div>
    <div class="scroll-table" style="margin-top:14px;">
      <table><thead><tr><th>Run</th><th>Value</th><th>Status</th></tr></thead><tbody id="kpiRows"></tbody></table>
    </div>
    <div id="kpiSaved" class="panel" style="margin-top:14px;"></div>`;

  const renderSavedList = () => {
    const list = JSON.parse(localStorage.getItem('fst-custom-kpis') || '[]');
    $('#kpiSaved').innerHTML = `<h3>Saved formulas</h3>` + (list.length
      ? list.map((k, i) => `<div class="log-section"><span>${esc(k.name)} (${esc(k.unit || '—')})</span><strong>${esc(k.formula)}</strong> <button data-load="${i}" class="quiet">Load</button></div>`).join('')
      : '<p class="notice">None saved yet.</p>');
    document.querySelectorAll('[data-load]').forEach(button => button.onclick = () => {
      const k = list[button.dataset.load];
      $('#kpiName').value = k.name; $('#kpiUnit').value = k.unit; $('#kpiFormula').value = k.formula;
      $('#kpiStart').value = k.start || ''; $('#kpiEnd').value = k.end || '';
    });
  };
  renderSavedList();

  $('#kpiSave').onclick = () => {
    const list = JSON.parse(localStorage.getItem('fst-custom-kpis') || '[]');
    list.push({
      name: $('#kpiName').value.trim() || 'unnamed',
      unit: $('#kpiUnit').value.trim(),
      formula: $('#kpiFormula').value.trim(),
      start: $('#kpiStart').value,
      end: $('#kpiEnd').value,
    });
    localStorage.setItem('fst-custom-kpis', JSON.stringify(list));
    renderSavedList();
  };

  $('#kpiRun').onclick = async () => {
    const expr = $('#kpiFormula').value.trim();
    if (!expr) { $('#kpiStatus').textContent = 'Enter a formula first.'; return; }
    const startS = $('#kpiStart').value === '' ? NaN : parseFloat($('#kpiStart').value);
    const endS = $('#kpiEnd').value === '' ? NaN : parseFloat($('#kpiEnd').value);
    if (Number.isFinite(startS) && Number.isFinite(endS) && startS >= endS) {
      $('#kpiStatus').textContent = 'Window start must be before window end.';
      return;
    }
    $('#kpiStatus').textContent = 'Computing…';
    lastRows = [];
    for (const run of runs) {
      try {
        const telemetry = await loadTelemetry(run);
        if (!telemetry) throw new Error('No telemetry file for this run.');
        const rate = telemetry.sample_rate || telemetry.sample_rate_hz;
        if (Number.isFinite(startS) && startS >= (run.duration_s ?? Infinity)) {
          throw new Error(`Window start (${startS}s) is beyond this run's duration (${number(run.duration_s)}s).`);
        }
        const value = evaluateFormula(expr, telemetry.channels, rate, startS, endS);
        if (!Number.isFinite(value)) throw new Error('Non-finite result — a required channel is likely missing from this run, or the window is empty.');
        lastRows.push({ run, value, status: 'ok' });
      } catch (error) {
        lastRows.push({ run, value: null, status: error.message });
      }
    }
    const windowLabel = (Number.isFinite(startS) || Number.isFinite(endS))
      ? `${Number.isFinite(startS) ? startS : 0}s – ${Number.isFinite(endS) ? endS : 'end'}s`
      : 'full run';
    $('#kpiStatus').textContent = `Window: ${windowLabel}`;
    $('#kpiRows').innerHTML = lastRows.map(r => `<tr>
        <td>${esc(r.run.event)} — ${esc(r.run.driver)}<br><small>${esc(r.run.file)}</small></td>
        <td>${r.value != null ? number(r.value) : '—'}</td>
        <td>${r.status === 'ok' ? '<span class="quality" style="background:#16301f;color:#7be7a6;">ok</span>' : `<span class="quality bad">${esc(r.status)}</span>`}</td>
      </tr>`).join('');
  };

  $('#kpiExport').onclick = () => {
    if (!lastRows.length) return;
    const startS = $('#kpiStart').value || '0';
    const endS = $('#kpiEnd').value || 'end';
    const csv = `# window_start_s=${startS}, window_end_s=${endS}\n` +
      'run_id,event,driver,value,status\n' + lastRows.map(r =>
      `${esc(r.run.id)},${esc(r.run.event)},${esc(r.run.driver)},${r.value ?? ''},${esc(r.status)}`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kpi_results.csv'; a.click();
  };
}

init();
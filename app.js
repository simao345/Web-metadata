const state = { runs: [], active: null, selected: new Set(), tab: 'Overview', telemetry: new Map(), catalogue: null, fileHandle: null };
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const duration = (seconds) => seconds == null ? '—' : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const unique = (values) => [...new Set(values.filter(Boolean))].sort();
const notesKey = (runId) => `fst-telemetry-note:${runId}`;
const number = (value) => Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 3) : '—';

// ============================================================================
// CATALOGUE FILE I/O
// Edits now target catalogue.json itself, not a browser-only side store.
// Two ways in:
//  - fetch('catalogue.json') at load, read-only (works everywhere, including
//    when this is served over plain http from any static server).
//  - "Open catalogue.json for editing" -> window.showOpenFilePicker, which
//    hands back a real FileSystemFileHandle. Only Chrome/Edge (and other
//    Chromium browsers) support this API. Once you have a handle, Save
//    writes straight back to that file on disk via createWritable().
// If no handle exists (Firefox/Safari, or you never opened one), Save falls
// back to downloading an updated catalogue.json that you replace manually.
// ============================================================================
async function writeCatalogueToDisk() {
  if (!state.catalogue) return { ok: false, error: new Error('No catalogue loaded.') };
  const json = JSON.stringify(state.catalogue, null, 2);
  if (state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      return { ok: true, method: 'disk' };
    } catch (error) {
      return { ok: false, error };
    }
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'catalogue.json';
  a.click();
  URL.revokeObjectURL(a.href);
  return { ok: true, method: 'download' };
}

function injectFileControls() {
  const anchor = $('#clearFilters');
  const toolbar = anchor ? anchor.parentElement : document.body;
  const wrap = document.createElement('span');
  wrap.id = 'fileControls';
  wrap.style.marginLeft = '8px';
  const supportsFS = 'showOpenFilePicker' in window;
  wrap.innerHTML = supportsFS
    ? `<button id="openCatalogue" class="quiet">Open catalogue.json for editing</button> <span id="fileStatus" class="note-help"></span>`
    : `<span class="note-help">Your browser can't save files directly (that needs Chrome or Edge) — saving edits will download an updated catalogue.json for you to replace manually.</span>`;
  toolbar.appendChild(wrap);
  if (!supportsFS) return;
  $('#openCatalogue').onclick = async () => {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Catalogue JSON', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      state.catalogue = parsed;
      state.runs = parsed.runs || [];
      state.fileHandle = handle;
      state.telemetry.clear();
      state.active = null; state.selected.clear();
      refreshFilterOptions(); renderList();
      $('#fileStatus').textContent = `Editing ${file.name} — saves write directly to this file.`;
      $('#status').textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} indexed (editable)`;
    } catch (error) {
      if (error.name !== 'AbortError') $('#fileStatus').textContent = `Could not open file: ${error.message}`;
    }
  };
}

async function init() {
  try {
    const response = await fetch('catalogue.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalogue = await response.json();
    state.catalogue = catalogue;
    state.runs = catalogue.runs || [];
    populateFilters(); renderList();
    $('#status').textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} indexed`;
  } catch (error) {
    $('#status').textContent = 'Catalogue unavailable';
    $('#runList').innerHTML = `<p class="error">Could not load catalogue.json: ${esc(error.message)}. Serve this folder with a web server rather than opening the file directly.</p>`;
  }
  injectFileControls();
}

function populateFilters() {
  refreshFilterOptions();
  $('#search').oninput = renderList;
  $('#clearFilters').onclick = () => { $('#search').value = ''; ['#eventFilter','#driverFilter','#sessionFilter'].forEach(s => $(s).value = ''); renderList(); };
  $('#compareButton').onclick = openComparison;
  $('#kpiButton').onclick = openKpiBuilder;
}

// Rebuilds the option lists for the three filter selects from the current
// state.runs, preserving whatever is currently selected. Split out from
// populateFilters so an edit (or opening a new file) can refresh the
// dropdowns without re-binding every other listener.
function refreshFilterOptions() {
  [['#eventFilter','event'],['#driverFilter','driver'],['#sessionFilter','session_type']].forEach(([selector,key]) => {
    const select = $(selector);
    const previous = select.value;
    select.querySelectorAll('option[data-generated]').forEach(option => option.remove());
    unique(state.runs.map(run => run[key])).forEach(value => select.insertAdjacentHTML('beforeend', `<option data-generated value="${esc(value)}">${esc(value)}</option>`));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    select.onchange = renderList;
  });
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

// Structured editor for one run: the same fields the old read-only
// "Manual test log" panel displayed, now as inputs. Each field carries
// data-scope/data-field so applyRunEdits() can write it back onto the
// right place on the run object (top-level, run.manual_log, or
// run.config) without a big hand-written list of assignments. Channel
// data and computed KPIs are intentionally left out -- those come from
// extract_run.py, not from someone typing in the browser.
function editField(scope, field, label, value, opts = {}) {
  const { multiline = false, type = 'text' } = opts;
  if (type === 'boolean') {
    return `<div class="edit-field"><label><input type="checkbox" data-scope="${scope}" data-field="${field}" data-type="boolean" ${value ? 'checked' : ''}> ${esc(label)}</label></div>`;
  }
  const val = value == null ? '' : value;
  const control = multiline
    ? `<textarea data-scope="${scope}" data-field="${field}" placeholder="Not recorded">${esc(val)}</textarea>`
    : `<input data-scope="${scope}" data-field="${field}" value="${esc(val)}" placeholder="Not recorded">`;
  return `<div class="edit-field"><label>${esc(label)}${control}</label></div>`;
}
function runEditor(run) {
  const log = run.manual_log || {}, config = run.config || {};
  return `<div class="panel">
    <h3>Edit run — writes back to catalogue.json</h3>
    <p class="note-help">Saving rewrites the whole catalogue.json${state.fileHandle ? ' directly on disk' : ' as a download for you to replace manually'}. Channel data and automatic KPIs above are untouched — only these fields change.</p>
    <form id="runEditorForm">
      <h4>Run identification</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('top','event','Event',run.event)}
        ${editField('top','driver','Driver',run.driver)}
        ${editField('top','session_type','Session type',run.session_type)}
        ${editField('top','date','Date',run.date)}
        ${editField('top','time','Time',run.time)}
        ${editField('manual','location','Location',log.location)}
      </div>
      <h4>Test objective</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','objective','Objective',log.objective,{multiline:true})}
      </div>
      <h4>Driver & session</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','laps','Laps',log.laps)}
        ${editField('manual','best_lap_time','Best lap time',log.best_lap_time)}
      </div>
      <h4>Mechanical setup</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','tyres','Tyres',log.tyres)}
        ${editField('manual','tyre_pressures','Tyre pressures',log.tyre_pressures)}
        ${editField('manual','damper_setup','Damper setup',log.damper_setup)}
        ${editField('manual','arb_position','ARB position',log.arb_position)}
        ${editField('config','spring_rate','Springs (config)',config.spring_rate)}
        ${editField('config','arb','ARB (config)',config.arb)}
        ${editField('config','aeropack','Aeropack fitted',config.aeropack,{type:'boolean'})}
      </div>
      <h4>Control setup</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','torque_vectoring_map','Torque vectoring map',log.torque_vectoring_map)}
        ${editField('manual','regen_map','Regen map',log.regen_map)}
        ${editField('manual','torque_limits','Torque limits',log.torque_limits)}
      </div>
      <h4>Energy system</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','battery_used','Battery used',log.battery_used)}
      </div>
      <h4>Data quality</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','non_operational_signals','Non-operational signals',log.non_operational_signals,{multiline:true})}
      </div>
      <h4>Reliability & issues</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','issues','Issues',log.issues,{multiline:true})}
      </div>
      <h4>Driver feedback</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','driver_feedback','Feedback',log.driver_feedback,{multiline:true})}
      </div>
      <h4>Environmental context</h4>
      <div class="log-grid" style="grid-template-columns:1fr 1fr;">
        ${editField('manual','weather','Weather',log.weather)}
        ${editField('manual','track_conditions','Track conditions',log.track_conditions)}
        ${editField('manual','ambient_temp','Ambient temperature',log.ambient_temp)}
        ${editField('manual','grip','Grip',log.grip)}
      </div>
    </form>
    <div class="notes-actions"><span id="editorStatus"></span><button id="saveCatalogue">Save to catalogue.json</button></div>
  </div>`;
}
function applyRunEdits(run, form) {
  form.querySelectorAll('[data-field]').forEach(el => {
    const { scope, field, type } = el.dataset;
    const raw = type === 'boolean' ? el.checked : el.value.trim();
    const value = (type !== 'boolean' && raw === '') ? null : raw;
    if (scope === 'top') run[field] = value;
    else if (scope === 'manual') { run.manual_log = run.manual_log || {}; run.manual_log[field] = value; }
    else if (scope === 'config') { run.config = run.config || {}; run.config[field] = value; }
  });
}
function wireRunEditor(run) {
  const form = $('#runEditorForm');
  $('#saveCatalogue').onclick = async () => {
    applyRunEdits(run, form);
    refreshFilterOptions();
    $('#editorStatus').textContent = 'Saving…';
    const result = await writeCatalogueToDisk();
    $('#editorStatus').textContent = result.ok
      ? (result.method === 'disk' ? 'Saved to catalogue.json.' : 'Downloaded updated catalogue.json — replace the file in your project.')
      : `Could not save: ${result.error.message}`;
    renderList();
    await renderWorkspace();
  };
}

async function renderWorkspace() {
  const run = state.active; if (!run) return;
  $('#workspace').innerHTML = baseWorkspace(run);
  document.querySelectorAll('.tab').forEach(tab => tab.onclick = async () => { state.tab = tab.dataset.tab; await renderWorkspace(); });
  const content = $('#tabContent');
  if (state.tab === 'Overview') {
    content.innerHTML = `<div class="overview-grid"><div class="metric"><span>Driver</span><strong>${esc(run.driver)}</strong></div><div class="metric"><span>Duration</span><strong>${duration(run.duration_s)}</strong></div><div class="metric"><span>Sample rate</span><strong>${run.sample_rate_hz ? `${run.sample_rate_hz} Hz` : '—'}</strong></div><div class="metric"><span>Channels</span><strong>${run.n_channels || 0}</strong></div></div><div class="panel"><h3>Automatic KPIs</h3><div class="kpis">${kpiCards(run) || '<p class="notice">No KPI data has been exported.</p>'}</div></div>${runEditor(run)}`;
    wireRunEditor(run);
  }
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
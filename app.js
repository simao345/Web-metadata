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
  $('#runList').innerHTML = runs.length ? runs.map(run => `<button class="run ${state.active?.id === run.id ? 'active' : ''} ${state.selected.has(run.id) ? 'selected' : ''}" data-id="${esc(run.id)}"><div class="run-title"><span>${esc(run.event || 'Untitled run')}</span><input class="select-run" type="checkbox" aria-label="Select for comparison" ${state.selected.has(run.id) ? 'checked' : ''}></div><small>${esc(run.file || run.id)}</small><div class="run-meta"><span>${esc(run.driver || 'Unknown driver')}</span><span class="tag">${duration(run.duration_s)}</span><span class="tag">${run.n_channels || 0} ch</span></div></button>`).join('') : '<p class="notice">No runs match these filters.</p>';
  document.querySelectorAll('.run').forEach(button => {
    button.onclick = event => { if (event.target.classList.contains('select-run')) return; openRun(button.dataset.id); };
    button.querySelector('.select-run').onchange = event => { event.stopPropagation(); toggleSelection(button.dataset.id, event.target.checked); };
  });
}

function toggleSelection(id, checked) {
  if (checked && state.selected.size === 2) { const [first] = state.selected; state.selected.delete(first); }
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
init();

const API = 'http://localhost:5000/api';
const state = { page: 1, pages: 1, search: '', risk: '', records: [], summary: null };
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body;
}
function notify(message, error = false) {
  const box = $('notice'); box.textContent = message; box.classList.toggle('error', error); box.classList.remove('hidden');
  clearTimeout(notify.timer); notify.timer = setTimeout(() => box.classList.add('hidden'), 6500);
}
function setService(online, modelName = '') {
  $('service-dot').classList.toggle('online', online); $('service-status').textContent = online ? 'Services connected' : 'Service unavailable';
  const badge = $('model-status'); badge.classList.toggle('offline', !online);
  badge.innerHTML = `<i></i>${online ? `Model Loaded (${escapeHtml(modelName || 'ready')})` : 'Model unavailable'}`;
}
function showPage(name) {
  const allowed = ['overview', 'predict', 'batch', 'history', 'model', 'about'];
  const page = allowed.includes(name) ? name : 'overview';
  document.querySelectorAll('.app-page').forEach((section) => section.classList.toggle('hidden', section.dataset.page !== page));
  document.querySelectorAll('.nav-item').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${page}`));
  const title = { overview: 'Dashboard', predict: 'Predict Transaction', batch: 'Batch Analysis', history: 'Transaction History', model: 'Model Details', about: 'About' }[page];
  $('crumb-title').textContent = title;
  if (page === 'predict') $('single-predict-form-copy')?.querySelector('[name="amount"]')?.focus({ preventScroll: true });
  if (page === 'history') loadHistory().catch((error) => notify(error.message, true));
  if (page === 'model') loadModelDetails().catch((error) => notify(error.message, true));
}
function queryString(values) { const params = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value !== '' && value != null) params.set(key, value); }); return params.toString(); }
function drawDistribution(summary) {
  const totals = summary.totals || {}, low = Number(summary.risk_distribution?.find((x) => x.level === 'LOW')?.count) || 0;
  const flagged = Number(totals.suspicious_transactions) || 0, analyzed = Number(totals.analyzed_transactions) || 0;
  const lowPct = analyzed ? low / analyzed * 100 : 0;
  $('distribution-donut').style.background = `conic-gradient(#347dec 0 ${lowPct}%, #f06467 ${lowPct}% 100%)`;
  $('distribution-total').textContent = analyzed.toLocaleString(); $('donut-rate').textContent = `${analyzed ? (100 - lowPct).toFixed(1) : '0.0'}% flagged`;
  $('distribution-legend').innerHTML = `<div class="legend-row"><i style="background:#347dec"></i><span>Lower risk</span><b>${low.toLocaleString()}</b></div><div class="legend-row"><i style="background:#f06467"></i><span>Flagged for review</span><b>${flagged.toLocaleString()}</b></div>`;
}
function quantile(values, q) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]; }
function drawAmountBoxplot(records) {
  const host = $('amount-boxplot');
  const groups = [
    { name: 'Lower risk', cls: 'lower', values: records.filter((r) => r.risk_level === 'LOW').map((r) => Number(r.amount) || 0) },
    { name: 'Flagged', cls: 'flagged', values: records.filter((r) => r.is_suspicious).map((r) => Number(r.amount) || 0) },
  ];
  const values = groups.flatMap((group) => group.values);
  if (!values.length) { host.innerHTML = '<div class="empty-chart">Analyze transactions to view amount ranges.</div>'; return; }
  const max = Math.max(1, quantile(values, .98));
  const row = (group, index) => {
    if (!group.values.length) return '';
    const min = quantile(group.values, .05), q1 = quantile(group.values, .25), med = quantile(group.values, .5), q3 = quantile(group.values, .75), high = quantile(group.values, .95);
    const pct = (n) => Math.min(100, Math.max(0, n / max * 100));
    const top = index ? '70%' : '30%';
    return `<i class="boxplot-whisker ${group.cls}" style="left:${pct(min)}%;width:${Math.max(0.5, pct(high) - pct(min))}%;top:${top}"></i><i class="boxplot-item ${group.cls}" style="left:${pct(q1)}%;width:${Math.max(1, pct(q3) - pct(q1))}%;top:${top}" title="${escapeHtml(group.name)} Q1 ${money(q1)}, median ${money(med)}, Q3 ${money(q3)}"></i><i class="boxplot-median" style="left:${pct(med)}%;top:calc(${top} - 11px)"></i>`;
  };
  host.innerHTML = `<div class="boxplot-chart"><div class="boxplot-axis"><span>${money(max)}</span><span>${money(max / 2)}</span><span>₹0</span></div>${row(groups[0], 0)}${row(groups[1], 1)}</div><div class="boxplot-labels"><span>Lower risk · ${groups[0].values.length}</span><span>Flagged · ${groups[1].values.length}</span></div>`;
}
function riskChip(level) { const cls = String(level || '').toLowerCase(); return `<span class="risk-chip ${['low', 'medium', 'high'].includes(cls) ? cls : ''}">${escapeHtml(level || 'Unscored')}</span>`; }
function recentRows(records) {
  $('recent-rows').innerHTML = records.slice(0, 6).map((record) => `<tr><td>${escapeHtml(record.transaction_id)}</td><td>${money(record.amount)}</td><td>${escapeHtml(record.transaction_type)}</td><td>${riskChip(record.risk_level)}</td><td>${record.risk_score == null ? '—' : Number(record.risk_score).toFixed(0)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-chart">No transactions yet.</td></tr>';
}
async function loadDashboard() {
  try {
    const [summary, result, model] = await Promise.all([
      api('/analytics/summary'), api('/transactions?limit=500&sort=timestamp&order=desc'), api('/detection/model'),
    ]);
    state.summary = summary; state.records = result.data || [];
    const totals = summary.totals || {};
    $('total-count').textContent = Number(totals.total_transactions || 0).toLocaleString();
    $('legitimate-count').textContent = Number(totals.normal_transactions || 0).toLocaleString();
    $('flagged-count').textContent = Number(totals.suspicious_transactions || 0).toLocaleString();
    $('flagged-rate').textContent = `${Number(totals.suspicious_percentage || 0).toFixed(2)}%`;
    drawDistribution(summary); drawAmountBoxplot(state.records); recentRows(state.records);
    setService(model.health?.status === 'ok', model.info?.model);
  } catch (error) { setService(false); notify(error.message, true); }
}
function renderPrediction(result, suffix = '') {
  const placeholder = $(`prediction-placeholder${suffix}`), panel = $(`prediction-result${suffix}`);
  placeholder?.classList.add('hidden'); panel.classList.remove('hidden');
  const level = result.risk_level || 'LOW', flagged = Boolean(result.is_suspicious);
  panel.classList.toggle('flagged', level === 'HIGH'); panel.classList.toggle('medium', level === 'MEDIUM');
  const symbol = $(`prediction-symbol${suffix}`); if (symbol) symbol.textContent = flagged ? '!' : '✓';
  const title = $(`prediction-title${suffix}`); if (title) title.textContent = flagged ? 'Flagged for review' : 'Lower-risk pattern';
  const score = $(`prediction-score${suffix}`); if (score) score.textContent = `Risk score ${Math.round(Number(result.risk_score) || 0)} / 100 · ${level}`;
  const transactionId = $(`prediction-id${suffix}`); if (transactionId) transactionId.textContent = `Transaction ID: ${result.transaction_id || 'Unavailable'}`;
  const detail = $(`prediction-detail${suffix}`); if (detail) detail.textContent = result.recommended_action || 'Use this score as a review signal alongside transaction context.';
  const reasons = $(`prediction-reasons${suffix}`); if (reasons) reasons.innerHTML = (result.reasons || []).slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
}
async function submitPrediction(form) {
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Scoring…';
  try {
    const fields = Object.fromEntries(new FormData(form));
    const now = new Date(); now.setHours(Number(fields.hour), 0, 0, 0);
    const transaction = {
      user_id: 'DEMO-USER', amount: Number(fields.amount),
      transaction_type: fields.transaction_type, timestamp: now.toISOString(), location: fields.location,
      merchant_category: fields.merchant_category, account_age_days: Number(fields.account_age_days),
      transaction_frequency: Number(fields.transaction_frequency),
    };
    const result = await api('/detection/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(transaction) });
    const suffix = form.id.endsWith('-copy') ? '-copy' : '';
    renderPrediction(result, suffix); notify('Prediction complete. This transaction was not saved to the dataset.');
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; button.textContent = '⌕  Predict Risk'; }
}
async function loadHistory() {
  const query = queryString({ page: state.page, limit: 25, q: state.search, risk_level: state.risk, sort: 'timestamp', order: 'desc' });
  const result = await api(`/transactions?${query}`); state.pages = result.pagination.pages || 1;
  $('history-rows').innerHTML = (result.data || []).map((r) => `<tr><td>${escapeHtml(r.transaction_id)}</td><td>${escapeHtml(r.user_id)}</td><td>${escapeHtml(String(r.timestamp || '').replace('T', ' ').slice(0, 16))}</td><td>${money(r.amount)}</td><td>${escapeHtml(r.transaction_type)}</td><td>${r.risk_score == null ? '—' : Number(r.risk_score).toFixed(0)} / 100</td><td>${riskChip(r.risk_level)}</td><td>${escapeHtml((r.review_status || 'pending').replace('_', ' '))}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-chart">No matching transactions.</td></tr>';
  $('history-count').textContent = `${result.pagination.total} transactions`; $('history-page').textContent = `Page ${state.page} of ${state.pages}`;
  $('history-prev').disabled = state.page <= 1; $('history-next').disabled = state.page >= state.pages;
}
async function loadModelDetails() {
  const report = await api('/detection/model'), model = report.info || {};
  $('active-model').textContent = `${model.model || 'Unknown'} · ${model.model_type || 'unknown type'} · trained on ${model.trained_on || 'unknown dataset'}`;
  $('model-disclaimer').textContent = model.disclaimer || '';
  const metrics = [['Training rows', model.training_rows ?? '—'], ['Labels', model.labels_from || 'None'], ['Selection metric', model.selection_metric || 'Unsupervised'], ['Selection score', model.selection_score == null ? '—' : Number(model.selection_score).toFixed(3)]];
  $('model-meta-grid').innerHTML = metrics.map(([label, value]) => `<div class="model-meta"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
}
function renderEvaluation(report) {
  $('model-evaluation-results').innerHTML = report.results.map((model) => `<article class="model-result"><div class="model-result-head"><h3>${escapeHtml(model.name)}</h3><span>${escapeHtml(model.type)}</span></div><div class="model-metrics">${[['Accuracy', model.accuracy], ['Precision', model.precision], ['Recall', model.recall], ['F1-score', model.f1], ['ROC AUC', model.roc_auc]].map(([name, value]) => `<div><span>${name}</span><b>${(Number(value) * 100).toFixed(1)}%</b></div>`).join('')}</div><div class="model-confusion"><span>Confusion matrix</span><small>TN ${model.confusion.true_negative} · FP ${model.confusion.false_positive} · FN ${model.confusion.false_negative} · TP ${model.confusion.true_positive}</small></div></article>`).join('');
  const selected = report.selected_model; notify(selected ? `Best supervised holdout model: ${selected.name} · F1 ${(selected.score * 100).toFixed(1)}% (synthetic data).` : report.notice || 'Evaluation complete.');
}
function renderHistoryRow(record) { return `<tr><td>${escapeHtml(record.transaction_id)}</td><td>${escapeHtml(record.user_id)}</td><td>${escapeHtml(record.timestamp)}</td><td>${money(record.amount)}</td><td>${escapeHtml(record.transaction_type)}</td><td>${record.risk_score}</td><td>${riskChip(record.risk_level)}</td><td>${escapeHtml(record.review_status)}</td></tr>`; }

document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => showPage(link.hash.slice(1))));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
document.querySelectorAll('#single-predict-form,#single-predict-form-copy').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault(); submitPrediction(form); }));
$('refresh').addEventListener('click', () => loadDashboard());
$('load-sample').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { const result = await api('/transactions/load-sample?analyze=true', { method: 'POST' }); notify(`Imported ${result.accepted} sample transactions.`); await loadDashboard(); } catch (error) { notify(error.message, true); } finally { button.disabled = false; } });
$('batch-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; $('batch-status').textContent = `Importing ${file.name}…`; const form = new FormData(); form.append('file', file); try { const result = await api('/transactions/upload?analyze=true', { method: 'POST', body: form }); $('batch-status').textContent = `${result.accepted} transactions imported and analyzed from ${file.name}.`; notify(`Imported ${result.accepted} transactions.`); await loadDashboard(); } catch (error) { $('batch-status').textContent = error.message; notify(error.message, true); } finally { event.target.value = ''; } });
$('history-search').addEventListener('input', (event) => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { state.search = event.target.value.trim(); state.page = 1; loadHistory().catch((error) => notify(error.message, true)); }, 250); });
$('history-risk').addEventListener('change', (event) => { state.risk = event.target.value; state.page = 1; loadHistory().catch((error) => notify(error.message, true)); });
$('history-refresh').addEventListener('click', () => loadHistory().catch((error) => notify(error.message, true)));
$('history-prev').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); loadHistory().catch((error) => notify(error.message, true)); });
$('history-next').addEventListener('click', () => { state.page = Math.min(state.pages, state.page + 1); loadHistory().catch((error) => notify(error.message, true)); });
$('history-export').addEventListener('click', () => { window.location.href = `${API}/transactions/export`; });
$('run-model-evaluation').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.textContent = 'Comparing…'; try { renderEvaluation(await api('/detection/model-evaluation')); } catch (error) { notify(error.message, true); } finally { button.disabled = false; button.textContent = 'Compare Models'; } });
showPage(location.hash.slice(1) || 'overview'); $('today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date()); loadDashboard();

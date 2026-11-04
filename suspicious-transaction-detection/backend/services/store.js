// CSV-backed transaction store (in-memory Map, persisted to data/transactions.csv).
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const TX_FILE = path.join(DATA_DIR, 'transactions.csv');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const COLUMNS = ['transaction_id', 'user_id', 'amount', 'transaction_type', 'timestamp', 'location',
  'merchant_category', 'account_age_days', 'transaction_frequency', 'batch_id', 'uploaded_at',
  'risk_score', 'risk_level', 'is_suspicious', 'reasons', 'anomalous_features', 'recommended_action',
  'anomaly_score', 'analyzed_at', 'review_status', 'review_note', 'reviewed_at'];

const DEFAULT_SETTINGS = { medium_threshold: 45, high_threshold: 65 };
const records = new Map();
let timer = null;

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

function hydrate(r) {
  return {
    ...r,
    amount: num(r.amount), account_age_days: num(r.account_age_days),
    transaction_frequency: num(r.transaction_frequency),
    risk_score: num(r.risk_score), anomaly_score: num(r.anomaly_score),
    is_suspicious: r.is_suspicious === '' ? null : r.is_suspicious === 'true',
    reasons: json(r.reasons, []), anomalous_features: json(r.anomalous_features, []),
    risk_level: r.risk_level || null, review_status: r.review_status || 'pending',
  };
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TX_FILE)) return;
  const rows = parse(fs.readFileSync(TX_FILE), { columns: true, skip_empty_lines: true, bom: true });
  rows.forEach((r) => records.set(r.transaction_id, hydrate(r)));
  console.log(`[store] loaded ${records.size} transactions`);
}

function persistNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const rows = [...records.values()].map((r) => ({
    ...r,
    reasons: JSON.stringify(r.reasons || []),
    anomalous_features: JSON.stringify(r.anomalous_features || []),
    is_suspicious: r.is_suspicious == null ? '' : String(r.is_suspicious),
  }));
  const tmp = TX_FILE + '.tmp';
  fs.writeFileSync(tmp, stringify(rows, { header: true, columns: COLUMNS }));
  fs.renameSync(tmp, TX_FILE);
}
function persist() {            // debounced
  clearTimeout(timer);
  timer = setTimeout(() => { try { persistNow(); } catch (e) { console.error('[store] persist failed', e.message); } }, 300);
}

const getSettings = () => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
};
const saveSettings = (s) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
};

module.exports = {
  COLUMNS, load, persist, persistNow, getSettings, saveSettings,
  all: () => [...records.values()],
  get: (id) => records.get(id),
  has: (id) => records.has(id),
  add: (r) => records.set(r.transaction_id, r),
  clear: () => records.clear(),
  size: () => records.size,
};

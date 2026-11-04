const { ApiError } = require('../middleware/errors');

const REQUIRED_COLUMNS = ['transaction_id', 'user_id', 'amount', 'transaction_type', 'timestamp',
  'location', 'merchant_category', 'account_age_days', 'transaction_frequency'];
const REVIEW_STATUSES = ['pending', 'reviewed', 'confirmed', 'false_positive'];
const MAX_ROWS = 50000;

// Normalise to "YYYY-MM-DD HH:mm:ss" without timezone shifting; null when unparseable.
function normalizeTimestamp(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +sec > 59) return null;
    return `${y}-${mo}-${d} ${h}:${mi}:${sec}`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

const toNum = (v) => {
  if (v == null || String(v).trim() === '') return { value: null };
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? { value: n } : { error: true };
};

// Validate/clean a single parsed CSV row -> { record } or { error }
function validateRow(raw, rowNumber) {
  const id = String(raw.transaction_id ?? '').trim();
  const user = String(raw.user_id ?? '').trim();
  if (!id) return { error: `Row ${rowNumber}: transaction_id is empty` };
  if (!user) return { error: `Row ${rowNumber} (${id}): user_id is empty` };
  const ts = normalizeTimestamp(raw.timestamp);
  if (!ts) return { error: `Row ${rowNumber} (${id}): invalid or missing timestamp` };

  const rec = { transaction_id: id, user_id: user, timestamp: ts };
  for (const [f, min] of [['amount', 0], ['account_age_days', 0], ['transaction_frequency', 0]]) {
    const { value, error } = toNum(raw[f]);
    if (error) return { error: `Row ${rowNumber} (${id}): ${f} is not a number` };
    if (value != null && value < min) return { error: `Row ${rowNumber} (${id}): ${f} cannot be negative` };
    rec[f] = value;     // null = missing; the ML service imputes it
  }
  for (const f of ['transaction_type', 'location', 'merchant_category']) {
    const v = String(raw[f] ?? '').trim();
    rec[f] = v ? v.slice(0, 80) : '';
  }
  return { record: rec };
}

function parsePagination(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 25));
  return { page, limit };
}

function validateThresholds(t) {
  const m = Number(t?.medium_threshold), h = Number(t?.high_threshold);
  if (!Number.isFinite(m) || !Number.isFinite(h)) throw new ApiError(400, 'medium_threshold and high_threshold must be numbers.');
  if (!(m >= 0 && m < h && h <= 100)) throw new ApiError(400, 'Thresholds must satisfy 0 <= medium < high <= 100.');
  return { medium_threshold: m, high_threshold: h };
}

module.exports = { REQUIRED_COLUMNS, REVIEW_STATUSES, MAX_ROWS, normalizeTimestamp, validateRow,
  parsePagination, validateThresholds };

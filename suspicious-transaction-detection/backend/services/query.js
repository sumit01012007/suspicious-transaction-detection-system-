const { ApiError } = require('../middleware/errors');

const numParam = (v, name) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `${name} must be a number.`);
  return n;
};
const dateParam = (v, name) => {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, `${name} must be YYYY-MM-DD.`);
  return v;
};

// Filters: q, risk_level, status, suspicious, date_from, date_to, min_amount, max_amount, batch_id
function filterRecords(records, q = {}) {
  const level = q.risk_level ? String(q.risk_level).toUpperCase() : null;
  if (level && !['LOW', 'MEDIUM', 'HIGH', 'UNANALYZED'].includes(level)) throw new ApiError(400, 'risk_level must be LOW, MEDIUM, HIGH or UNANALYZED.');
  const from = dateParam(q.date_from, 'date_from'), to = dateParam(q.date_to, 'date_to');
  const min = numParam(q.min_amount, 'min_amount'), max = numParam(q.max_amount, 'max_amount');
  const needle = q.q ? String(q.q).trim().toLowerCase() : null;

  return records.filter((r) => {
    if (needle && !(r.transaction_id.toLowerCase().includes(needle) || r.user_id.toLowerCase().includes(needle))) return false;
    if (level === 'UNANALYZED' ? r.risk_level : level && r.risk_level !== level) return false;
    if (q.status && r.review_status !== q.status) return false;
    if (q.suspicious === 'true' && r.is_suspicious !== true) return false;
    if (q.suspicious === 'false' && r.is_suspicious !== false) return false;
    if (q.batch_id && r.batch_id !== q.batch_id) return false;
    const day = r.timestamp.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (min != null && (r.amount ?? 0) < min) return false;
    if (max != null && (r.amount ?? 0) > max) return false;
    return true;
  });
}

const SORTABLE = { risk_score: 'risk_score', amount: 'amount', timestamp: 'timestamp', transaction_id: 'transaction_id' };
function sortRecords(records, sort = 'timestamp', order = 'desc') {
  const key = SORTABLE[sort];
  if (!key) throw new ApiError(400, `sort must be one of: ${Object.keys(SORTABLE).join(', ')}`);
  const dir = String(order).toLowerCase() === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // nulls always last
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

const paginate = (arr, page, limit) => ({
  data: arr.slice((page - 1) * limit, page * limit),
  pagination: { page, limit, total: arr.length, pages: Math.max(1, Math.ceil(arr.length / limit)) },
});

module.exports = { filterRecords, sortRecords, paginate };

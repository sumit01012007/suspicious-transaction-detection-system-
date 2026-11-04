const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const store = require('../services/store');
const detection = require('../services/detection');
const { ApiError } = require('../middleware/errors');
const { filterRecords, sortRecords, paginate } = require('../services/query');
const V = require('../services/validation');
const { visibleRecords, canAccessRecord } = require('../services/authorization');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// GET /api/transactions
exports.list = (req, res) => {
  const { page, limit } = V.parsePagination(req.query);
  const rows = sortRecords(filterRecords(visibleRecords(req, store.all()), req.query), req.query.sort, req.query.order);
  res.json(paginate(rows, page, limit));
};

// GET /api/transactions/:id
exports.getOne = (req, res) => {
  const rec = store.get(req.params.id);
  if (!canAccessRecord(req, rec)) throw new ApiError(404, `Transaction ${req.params.id} not found.`);
  res.json(rec);
};

// Shared by upload + load-sample: parse, validate, store. Returns an import report.
function importCsv(buffer, filename) {
  let rows;
  try {
    rows = parse(buffer, { columns: (h) => h.map((c) => String(c).trim().toLowerCase()), bom: true,
      skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (e) {
    throw new ApiError(422, `Could not parse CSV: ${e.message}`);
  }
  if (!rows.length) throw new ApiError(422, 'The CSV file contains no data rows.');
  const missing = V.REQUIRED_COLUMNS.filter((c) => !(c in rows[0]));
  if (missing.length) throw new ApiError(422, `Missing required columns: ${missing.join(', ')}`,
    { required: V.REQUIRED_COLUMNS, found: Object.keys(rows[0]) });
  if (rows.length > V.MAX_ROWS) throw new ApiError(413, `Too many rows (${rows.length}); maximum is ${V.MAX_ROWS}.`);

  const batchId = `B${Date.now().toString(36).toUpperCase()}`;
  const uploadedAt = new Date().toISOString();
  const errors = []; const accepted = []; let duplicates = 0; const seen = new Set();
  rows.forEach((raw, i) => {
    const { record, error } = V.validateRow(raw, i + 2);   // +2: header is row 1
    if (error) return errors.push(error);
    if (store.has(record.transaction_id) || seen.has(record.transaction_id)) { duplicates += 1; return; }
    seen.add(record.transaction_id);
    accepted.push({ ...record, batch_id: batchId, uploaded_at: uploadedAt, risk_score: null, risk_level: null,
      is_suspicious: null, reasons: [], anomalous_features: [], recommended_action: '', anomaly_score: null,
      analyzed_at: '', review_status: 'pending', review_note: '', reviewed_at: '' });
  });
  if (!accepted.length) throw new ApiError(422, 'No valid new transactions found in file.',
    { rejected: errors.length, duplicates, errors: errors.slice(0, 20) });

  accepted.forEach((r) => store.add(r));
  store.persist();
  try { fs.writeFileSync(path.join(UPLOAD_DIR, `${batchId}.csv`), buffer); } catch { /* audit copy is best-effort */ }
  return { batch_id: batchId, filename, total_rows: rows.length, accepted: accepted.length,
    duplicates, rejected: errors.length, errors: errors.slice(0, 20), preview: accepted.slice(0, 10), _records: accepted };
}

// POST /api/transactions/upload   (multipart field "file"; ?analyze=true to also run detection)
exports.upload = async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded. Send a CSV in the "file" field.');
  const report = importCsv(req.file.buffer, req.file.originalname);
  const records = report._records; delete report._records;
  if (String(req.query.analyze) === 'true') report.detection = await detection.analyze(records, store.getSettings());
  res.status(201).json(report);
};

// POST /api/transactions/load-sample
exports.loadSample = async (req, res) => {
  const p = path.resolve(process.env.SAMPLE_DATASET || path.join(__dirname, '..', '..', 'ml-service', 'dataset', 'sample_transactions.csv'));
  if (!fs.existsSync(p)) throw new ApiError(404, 'Sample dataset not found. Run python dataset/generate_dataset.py in ml-service.');
  const report = importCsv(fs.readFileSync(p), path.basename(p));
  const records = report._records; delete report._records;
  if (String(req.query.analyze) === 'true') report.detection = await detection.analyze(records, store.getSettings());
  res.status(201).json(report);
};

// PATCH /api/transactions/:id/review   body: { status, note? }
exports.review = (req, res) => {
  const rec = store.get(req.params.id);
  if (!canAccessRecord(req, rec)) throw new ApiError(404, `Transaction ${req.params.id} not found.`);
  const { status, note } = req.body || {};
  if (!V.REVIEW_STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${V.REVIEW_STATUSES.join(', ')}`);
  if (note != null && (typeof note !== 'string' || note.length > 500)) throw new ApiError(400, 'note must be a string up to 500 characters.');
  if (!rec.risk_level) throw new ApiError(409, 'Transaction has not been analyzed yet.');
  if (!rec.is_suspicious) throw new ApiError(409, 'Only transactions flagged as suspicious can be reviewed.');
  rec.review_status = status;
  rec.review_note = note ?? rec.review_note ?? '';
  rec.reviewed_at = status === 'pending' ? '' : new Date().toISOString();
  store.persist();
  res.json(rec);
};

// DELETE /api/transactions  (reset demo data)
exports.reset = (req, res) => {
  const n = store.size(); store.clear(); store.persistNow();
  res.json({ deleted: n });
};

// GET /api/transactions/export  (CSV of the current filter, incl. predictions)
exports.exportCsv = (req, res) => {
  const rows = sortRecords(filterRecords(visibleRecords(req, store.all()), req.query), req.query.sort, req.query.order);
  const out = rows.map((r) => ({ ...r, reasons: (r.reasons || []).join('; '),
    anomalous_features: undefined }));
  const cols = ['transaction_id', 'user_id', 'amount', 'transaction_type', 'timestamp', 'location', 'merchant_category',
    'account_age_days', 'transaction_frequency', 'risk_score', 'risk_level', 'is_suspicious', 'reasons',
    'recommended_action', 'review_status', 'review_note'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="analyzed_transactions.csv"');
  res.send(stringify(out, { header: true, columns: cols }));
};

const crypto = require('crypto');
const store = require('../services/store');
const ml = require('../services/mlClient');
const detection = require('../services/detection');
const { ApiError } = require('../middleware/errors');
const { filterRecords, sortRecords, paginate } = require('../services/query');
const V = require('../services/validation');
const { visibleRecords } = require('../services/authorization');

// POST /api/detection/analyze
// body: { transaction_ids?: string[], batch_id?: string, reanalyze?: boolean, thresholds?: {...} }
exports.analyze = async (req, res) => {
  const { transaction_ids, batch_id, reanalyze = false, thresholds } = req.body || {};
  if (transaction_ids != null && !Array.isArray(transaction_ids)) throw new ApiError(400, 'transaction_ids must be an array.');
  const t = thresholds ? V.validateThresholds(thresholds) : store.getSettings();

  let target = store.all();
  if (transaction_ids) target = transaction_ids.map((id) => store.get(id)).filter(Boolean);
  if (batch_id) target = target.filter((r) => r.batch_id === batch_id);
  if (!reanalyze && !transaction_ids) target = target.filter((r) => !r.risk_level);
  if (!target.length) {
    return res.json({ analyzed: 0, message: store.size() ? 'Nothing to analyze: all matching transactions already have results. Pass reanalyze=true to rerun.' : 'No transactions loaded. Upload a CSV first.' });
  }
  const summary = await detection.analyze(target, { medium_threshold: t.medium_threshold, high_threshold: t.high_threshold });
  res.json(summary);
};

// GET /api/detection/results  -> analyzed + flagged transactions (default sorted by risk_score desc)
exports.results = (req, res) => {
  const { page, limit } = V.parsePagination(req.query);
  const q = { suspicious: 'true', ...req.query };
  const rows = sortRecords(filterRecords(visibleRecords(req, store.all()).filter((r) => r.risk_level), q), req.query.sort || 'risk_score', req.query.order || 'desc');
  res.json(paginate(rows, page, limit));
};

// GET /api/detection/model
exports.model = async (req, res) => {
  const [health, info] = await Promise.all([ml.health(), ml.modelInfo().catch(() => null)]);
  res.json({ health, info, thresholds: store.getSettings() });
};

// POST /api/detection/predict - score one transaction without saving it.
exports.predictOne = async (req, res) => {
  const transaction = { ...req.body, transaction_id: req.body?.transaction_id || `MAN-${crypto.randomUUID()}`,
    user_id: req.body?.user_id || 'DEMO-USER' };
  const { record, error } = V.validateRow(transaction, 1);
  if (error) throw new ApiError(400, error);
  const prediction = await ml.predictBatch([record], store.getSettings());
  const result = prediction.results[0];
  res.json({ ...record, ...result, disclaimer: prediction.disclaimer });
};

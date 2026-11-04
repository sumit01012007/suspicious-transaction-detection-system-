const { stringify } = require('csv-stringify/sync');
const store = require('../services/store');
const A = require('../services/analytics');
const { ApiError } = require('../middleware/errors');
const { filterRecords, sortRecords } = require('../services/query');
const { visibleRecords } = require('../services/authorization');

const send = (res, name, rows, columns) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(stringify(rows, { header: true, columns }));
};

// GET /api/reports/:type   type = suspicious | daily-trends | monthly-volume | categories | summary
exports.download = (req, res) => {
  const recs = filterRecords(visibleRecords(req, store.all()), { date_from: req.query.date_from, date_to: req.query.date_to });
  const stamp = new Date().toISOString().slice(0, 10);
  switch (req.params.type) {
    case 'suspicious': {
      const rows = sortRecords(recs.filter((r) => r.is_suspicious), 'risk_score', 'desc')
        .map((r) => ({ ...r, reasons: r.reasons.join('; ') }));
      return send(res, `suspicious_transactions_${stamp}`, rows, ['transaction_id', 'user_id', 'amount', 'timestamp',
        'location', 'merchant_category', 'risk_score', 'risk_level', 'reasons', 'recommended_action', 'review_status', 'review_note']);
    }
    case 'daily-trends':
      return send(res, `daily_trends_${stamp}`, A.trends(recs).daily, ['date', 'total', 'suspicious', 'amount']);
    case 'monthly-volume':
      return send(res, `monthly_volume_${stamp}`, A.trends(recs).monthly, ['month', 'total', 'suspicious', 'amount', 'average_amount']);
    case 'categories':
      return send(res, `merchant_categories_${stamp}`, A.trends(recs).categories, ['category', 'total', 'suspicious', 'suspicious_rate', 'suspicious_amount']);
    case 'summary': {
      const s = A.summary(recs);
      const rows = [...Object.entries(s.totals), ...Object.entries(s.detection_stats)].map(([metric, value]) => ({ metric, value }));
      return send(res, `detection_summary_${stamp}`, rows, ['metric', 'value']);
    }
    default:
      throw new ApiError(404, 'Unknown report. Use: suspicious, daily-trends, monthly-volume, categories, summary.');
  }
};

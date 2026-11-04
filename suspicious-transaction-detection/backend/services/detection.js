const store = require('./store');
const ml = require('./mlClient');
const CHUNK = 20000;
const FIELDS = ['transaction_id', 'user_id', 'amount', 'transaction_type', 'timestamp', 'location',
  'merchant_category', 'account_age_days', 'transaction_frequency'];

// Send records to the ML service and merge predictions back into the store.
async function analyze(records, thresholds) {
  const ordered = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let cleaning = { rows: 0, imputed: {} };
  let disclaimer = null;
  for (let i = 0; i < ordered.length; i += CHUNK) {
    const chunk = ordered.slice(i, i + CHUNK);
    const out = await ml.predictBatch(chunk.map((r) => Object.fromEntries(FIELDS.map((f) => [f, r[f] === '' ? null : r[f]]))), thresholds);
    disclaimer = out.disclaimer;
    cleaning.rows += out.cleaning.rows;
    for (const [k, v] of Object.entries(out.cleaning.imputed)) cleaning.imputed[k] = (cleaning.imputed[k] || 0) + v;
    const now = new Date().toISOString();
    for (const p of out.results) {
      const rec = store.get(p.transaction_id);
      if (!rec) continue;
      Object.assign(rec, {
        risk_score: p.risk_score, risk_level: p.risk_level, is_suspicious: p.is_suspicious,
        reasons: p.reasons, anomalous_features: p.anomalous_features,
        recommended_action: p.recommended_action, anomaly_score: p.anomaly_score, analyzed_at: now,
      });
      if (!p.is_suspicious) rec.review_status = 'pending';   // reviews only apply to flagged rows
    }
  }
  store.persist();
  const done = ordered.map((r) => store.get(r.transaction_id));
  return {
    analyzed: done.length,
    suspicious: done.filter((r) => r.is_suspicious).length,
    high: done.filter((r) => r.risk_level === 'HIGH').length,
    medium: done.filter((r) => r.risk_level === 'MEDIUM').length,
    low: done.filter((r) => r.risk_level === 'LOW').length,
    thresholds, cleaning, disclaimer,
  };
}
module.exports = { analyze };

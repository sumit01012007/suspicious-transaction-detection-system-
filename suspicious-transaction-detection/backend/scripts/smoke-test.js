// End-to-end smoke test. Requires backend (:5000) and ML service (:8000) running.
// Usage: node scripts/smoke-test.js [baseUrl]
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:5000/api';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`); };
const j = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b, r }; };
const csvForm = (name, content, type = 'text/csv') => { const f = new FormData(); f.append('file', new Blob([content], { type }), name); return { method: 'POST', body: f }; };

(async () => {
  let r = await j('/health'); check('health + ML reachable', r.s === 200 && r.b.ml_service === 'ok', JSON.stringify(r.b));
  await j('/transactions', { method: 'DELETE' });

  r = await j('/transactions/upload', csvForm('a.txt', 'x', 'text/plain')); check('rejects non-CSV (415)', r.s === 415, r.s);
  r = await j('/transactions/upload', csvForm('a.csv', 'a,b\n1,2\n')); check('rejects missing columns (422)', r.s === 422 && /Missing required columns/.test(r.b.error), JSON.stringify(r.b));
  r = await j('/transactions/upload', { method: 'POST' }); check('rejects no file (400)', r.s === 400, r.s);

  const sample = fs.readFileSync(path.join(__dirname, '..', '..', 'ml-service', 'dataset', 'sample_transactions.csv'));
  const bad = 'transaction_id,user_id,amount,transaction_type,timestamp,location,merchant_category,account_age_days,transaction_frequency\n,U1,5,PURCHASE,2026-01-01,Delhi,Fuel,10,2\nX1,U1,abc,PURCHASE,2026-01-01,Delhi,Fuel,10,2\nX2,U1,50,PURCHASE,not-a-date,Delhi,Fuel,10,2\nX3,U1,50,PURCHASE,2026-01-01 10:00:00,,Fuel,,2\n';
  r = await j('/transactions/upload', csvForm('bad.csv', bad)); check('partial import: 1 accepted, 3 rejected', r.s === 201 && r.b.accepted === 1 && r.b.rejected === 3, JSON.stringify(r.b));
  r = await j('/transactions/upload', csvForm('bad.csv', bad)); check('all-duplicate re-upload rejected (422)', r.s === 422, r.s);
  await j('/transactions', { method: 'DELETE' });

  r = await j('/transactions/upload', csvForm('sample.csv', sample)); check('upload 1,200-row sample (201)', r.s === 201 && r.b.accepted === 1200, JSON.stringify(r.b).slice(0, 200));
  const batch = r.b.batch_id;
  r = await j('/transactions?limit=5'); check('list before analysis', r.b.pagination.total === 1200 && r.b.data[0].risk_level === null);
  r = await j('/detection/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: batch }) });
  check('analyze via ML service', r.s === 200 && r.b.analyzed === 1200 && r.b.suspicious > 0, JSON.stringify(r.b).slice(0, 200));
  const flagged = r.b.suspicious;
  r = await j('/detection/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); check('re-analyze is a no-op without reanalyze', r.b.analyzed === 0);

  r = await j('/detection/results?limit=3'); const top = r.b.data[0];
  check('results sorted by risk desc w/ reasons', r.b.pagination.total === flagged && top.risk_score >= r.b.data[2].risk_score && top.reasons.length > 0 && top.recommended_action);
  r = await j('/transactions?risk_level=HIGH&sort=risk_score&order=desc&limit=500'); check('filter HIGH', r.b.data.every((x) => x.risk_level === 'HIGH') && r.b.data.length > 0);
  r = await j(`/transactions?q=${top.transaction_id.toLowerCase()}`); check('search by id (case-insens.)', r.b.data.length === 1);
  r = await j('/transactions?date_from=2026-07-05&date_to=2026-07-06&limit=500'); check('date filter', r.b.data.length > 0 && r.b.data.every((x) => x.timestamp >= '2026-07-05' && x.timestamp < '2026-07-07'));
  r = await j('/transactions?min_amount=10000&max_amount=100000&limit=500'); check('amount filter', r.b.data.every((x) => x.amount >= 10000 && x.amount <= 100000));
  r = await j('/transactions?risk_level=BOGUS'); check('invalid filter -> 400', r.s === 400);
  r = await j('/transactions?sort=nope'); check('invalid sort -> 400', r.s === 400);
  r = await j('/transactions/NOPE'); check('unknown id -> 404', r.s === 404);

  r = await j(`/transactions/${top.transaction_id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed', note: 'verified by phone' }) });
  check('mark confirmed', r.s === 200 && r.b.review_status === 'confirmed' && r.b.reviewed_at);
  const low = (await j('/transactions?risk_level=LOW&limit=1')).b.data[0];
  r = await j(`/transactions/${low.transaction_id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }) }); check('cannot review non-suspicious (409)', r.s === 409);
  r = await j(`/transactions/${top.transaction_id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'bad' }) }); check('invalid review status (400)', r.s === 400);

  r = await j('/analytics/summary'); const t = r.b.totals;
  check('summary matches data', t.total_transactions === 1200 && t.suspicious_transactions === flagged && t.normal_transactions === 1200 - flagged && r.b.detection_stats.confirmed_suspicious === 1, JSON.stringify(t));
  check('risk distribution sums', r.b.risk_distribution.reduce((s, x) => s + x.count, 0) === 1200);
  r = await j('/analytics/trends'); check('trends daily/monthly/categories', r.b.daily.length > 30 && r.b.monthly.length >= 2 && r.b.categories.length > 5);
  r = await j('/reports/suspicious'); check('CSV report download', r.s === 200 && /transaction_id,user_id/.test(r.b) && r.b.split('\n').length > flagged);
  r = await j('/reports/nope'); check('unknown report -> 404', r.s === 404);
  r = await j('/transactions/export?risk_level=HIGH'); check('export filtered CSV', r.s === 200 && /risk_score/.test(r.b));

  r = await j('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medium_threshold: 80, high_threshold: 60 }) }); check('invalid thresholds (400)', r.s === 400);
  r = await j('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medium_threshold: 60, high_threshold: 80 }) });
  r = await j('/detection/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reanalyze: true }) });
  check('stricter thresholds flag fewer', r.s === 200 && r.b.suspicious < flagged, `${r.b.suspicious} vs ${flagged}`);
  await j('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medium_threshold: 45, high_threshold: 65 }) });
  r = await j('/detection/model'); check('model info proxy', r.s === 200 && r.b.info?.model === 'IsolationForest');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

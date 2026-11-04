const day = (r) => r.timestamp.slice(0, 10);
const month = (r) => r.timestamp.slice(0, 7);
const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);

function summary(records) {
  const analyzed = records.filter((r) => r.risk_level);
  const susp = analyzed.filter((r) => r.is_suspicious);
  const dist = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  analyzed.forEach((r) => { dist[r.risk_level] += 1; });
  const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: 0 }));
  analyzed.forEach((r) => { buckets[Math.min(9, Math.floor(r.risk_score / 10))].count += 1; });
  const rv = (s) => records.filter((r) => r.is_suspicious && r.review_status === s).length;
  const confirmed = rv('confirmed'), fp = rv('false_positive');

  return {
    totals: {
      total_transactions: records.length,
      analyzed_transactions: analyzed.length,
      unanalyzed_transactions: records.length - analyzed.length,
      suspicious_transactions: susp.length,
      normal_transactions: analyzed.length - susp.length,
      suspicious_percentage: analyzed.length ? round((susp.length / analyzed.length) * 100) : 0,
      total_amount: round(sum(records, (r) => r.amount)),
      suspicious_amount: round(sum(susp, (r) => r.amount)),
      high_risk_transactions: dist.HIGH,
      average_amount: records.length ? round(sum(records, (r) => r.amount) / records.length) : 0,
      average_suspicious_amount: susp.length ? round(sum(susp, (r) => r.amount) / susp.length) : 0,
    },
    risk_distribution: [
      { level: 'LOW', count: dist.LOW }, { level: 'MEDIUM', count: dist.MEDIUM }, { level: 'HIGH', count: dist.HIGH },
    ],
    score_histogram: buckets,
    detection_stats: {
      average_risk_score: analyzed.length ? round(sum(analyzed, (r) => r.risk_score) / analyzed.length) : null,
      average_suspicious_risk_score: susp.length ? round(sum(susp, (r) => r.risk_score) / susp.length) : null,
      pending_review: rv('pending'), reviewed: rv('reviewed'), confirmed_suspicious: confirmed, false_positives: fp,
      // Share of analyst-labelled alerts that were confirmed; null until analysts label something.
      review_precision: confirmed + fp ? round((confirmed / (confirmed + fp)) * 100) : null,
    },
  };
}

function trends(records) {
  const byDay = new Map(), byMonth = new Map(), byCat = new Map();
  for (const r of records) {
    const d = byDay.get(day(r)) || { date: day(r), total: 0, suspicious: 0, amount: 0 };
    d.total += 1; d.amount += r.amount || 0; if (r.is_suspicious) d.suspicious += 1;
    byDay.set(d.date, d);
    const m = byMonth.get(month(r)) || { month: month(r), total: 0, suspicious: 0, amount: 0 };
    m.total += 1; m.amount += r.amount || 0; if (r.is_suspicious) m.suspicious += 1;
    byMonth.set(m.month, m);
    const k = r.merchant_category || 'UNKNOWN';
    const c = byCat.get(k) || { category: k, total: 0, suspicious: 0, amount: 0 };
    c.total += 1; if (r.risk_level) c.analyzed = (c.analyzed || 0) + 1;
    if (r.is_suspicious) { c.suspicious += 1; c.amount += r.amount || 0; }
    byCat.set(k, c);
  }
  const cats = [...byCat.values()].map((c) => ({
    category: c.category, total: c.total, suspicious: c.suspicious,
    suspicious_rate: c.analyzed ? round((c.suspicious / c.analyzed) * 100) : 0,
    suspicious_amount: round(c.amount),
  }));
  return {
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, amount: round(d.amount) })),
    monthly: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, amount: round(m.amount), average_amount: round(m.amount / m.total) })),
    categories: cats.sort((a, b) => b.suspicious - a.suspicious || b.suspicious_rate - a.suspicious_rate),
  };
}
module.exports = { summary, trends };

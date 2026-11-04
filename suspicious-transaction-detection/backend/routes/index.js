const router = require('express').Router();
const { asyncHandler: h } = require('../middleware/errors');
const upload = require('../middleware/upload');
const T = require('../controllers/transactions');
const D = require('../controllers/detection');
const A = require('../controllers/analytics');
const R = require('../controllers/reports');
const S = require('../controllers/settings');
const ml = require('../services/mlClient');

router.get('/health', h(async (req, res) => {
  const mlHealth = await ml.health().catch(() => ({ status: 'unreachable' }));
  res.json({ status: 'ok', ml_service: mlHealth.status });
}));
// static paths before /:id
router.get('/transactions', T.list);
router.get('/transactions/export', T.exportCsv);
router.post('/transactions/upload', upload, h(T.upload));
router.post('/transactions/load-sample', h(T.loadSample));
router.delete('/transactions', T.reset);
router.get('/transactions/:id', T.getOne);
router.patch('/transactions/:id/review', T.review);

router.post('/detection/analyze', h(D.analyze));
router.post('/detection/predict', h(D.predictOne));
router.get('/detection/results', D.results);
router.get('/detection/model', h(D.model));
router.get('/detection/model-evaluation', h(async (req, res) => {
  res.json(await ml.modelEvaluation());
}));

router.get('/analytics/summary', A.summary);
router.get('/analytics/trends', A.trends);
router.get('/reports/:type', R.download);

router.get('/settings', S.get);
router.put('/settings', S.update);
module.exports = router;

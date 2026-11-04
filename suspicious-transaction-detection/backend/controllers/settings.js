const store = require('../services/store');
const { validateThresholds } = require('../services/validation');
exports.get = (req, res) => res.json(store.getSettings());
exports.update = (req, res) => {
  const t = validateThresholds(req.body);
  store.saveSettings(t);
  res.json({ ...t, note: 'Re-run detection with reanalyze=true to apply new thresholds to existing transactions.' });
};

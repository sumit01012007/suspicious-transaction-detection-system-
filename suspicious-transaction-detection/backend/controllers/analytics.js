const store = require('../services/store');
const A = require('../services/analytics');
const { filterRecords } = require('../services/query');
const { visibleRecords } = require('../services/authorization');

const scoped = (req) => filterRecords(visibleRecords(req, store.all()), { date_from: req.query.date_from, date_to: req.query.date_to });
exports.summary = (req, res) => res.json(A.summary(scoped(req)));
exports.trends = (req, res) => res.json(A.trends(scoped(req)));

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const store = require('./services/store');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();
const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim());
app.use(cors({
  origin: (origin, cb) => (!origin || origins.includes(origin) ? cb(null, true) : cb(new Error('Origin not allowed by CORS'))),
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

store.load();
const PORT = process.env.PORT || 5000;
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`FraudShield backend on :${PORT} (ML: ${process.env.ML_SERVICE_URL || 'http://localhost:8000'})`));
  const stop = () => { store.persistNow(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = app;

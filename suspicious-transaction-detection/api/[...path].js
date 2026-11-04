// Vercel catch-all function: serve the existing Express API under /api/*.
// Serverless instances have temporary storage, so keep writes outside the repo.
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/fraudshield-data';

module.exports = require('../backend/server');

const { ApiError } = require('../middleware/errors');
const BASE = () => (process.env.ML_SERVICE_URL || (process.env.VERCEL && process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/ml`
  : 'http://localhost:8000')).replace(/\/$/, '');

async function call(path, options = {}, timeoutMs = 120000) {
  let res;
  try {
    res = await fetch(BASE() + path, { ...options, signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch (e) {
    throw new ApiError(503, `ML service unreachable at ${BASE()}. Start it with: uvicorn main:app --port 8000`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof body.detail === 'string' ? body.detail : 'ML service rejected the request.';
    throw new ApiError(res.status === 422 ? 422 : 502, msg);
  }
  return body;
}

const health = () => call('/health', {}, 5000);
const modelInfo = () => call('/model/info', {}, 10000);
const modelEvaluation = () => call('/model/evaluation', {}, 120000);
const predictBatch = (transactions, thresholds) =>
  call('/predict/batch', { method: 'POST', body: JSON.stringify({ transactions, thresholds }) });

module.exports = { health, modelInfo, modelEvaluation, predictBatch };

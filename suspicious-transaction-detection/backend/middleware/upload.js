const multer = require('multer');
const { ApiError } = require('./errors');

const csvOnly = (req, file, cb) => {
  const okName = /\.csv$/i.test(file.originalname || '');
  const okMime = /csv|excel|plain|octet-stream/i.test(file.mimetype || '');
  if (!okName || !okMime) return cb(new ApiError(415, 'Only .csv files are accepted.'));
  cb(null, true);
};
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: csvOnly,
}).single('file');

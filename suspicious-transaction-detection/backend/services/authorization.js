function visibleRecords(req, records) {
  return records;
}

function canAccessRecord(req, record) {
  return Boolean(record);
}

module.exports = { visibleRecords, canAccessRecord };

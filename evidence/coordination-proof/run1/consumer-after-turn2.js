'use strict';
// Consumer of quiz_progress. Key fields come from lib/schema.js — the
// schema's `key` array is the single source of truth for the lookup.
const { quiz_progress } = require('./lib/schema');

/**
 * Find one quiz_progress record by its key.
 * @param {Array<object>} records
 * @param {object} keyValues - must supply every field in quiz_progress.key
 * @returns {object|null}
 */
function findQuizProgress(records, keyValues) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  for (const field of quiz_progress.key) {
    if (keyValues == null || keyValues[field] === undefined) {
      throw new TypeError(`missing key field: ${field}`);
    }
  }
  return (
    records.find((r) => quiz_progress.key.every((f) => r[f] === keyValues[f])) ||
    null
  );
}

module.exports = { findQuizProgress, keyFields: quiz_progress.key };

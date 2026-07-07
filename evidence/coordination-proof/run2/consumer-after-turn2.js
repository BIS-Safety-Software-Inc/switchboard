'use strict';
// Consumer of quiz_progress. Looks up one record by the key field(s)
// declared in lib/schema.js — the schema is the single source of truth.
const { quiz_progress } = require('./lib/schema');

const keyFields = [...quiz_progress.key];

/**
 * Find one quiz_progress record matching every schema key field.
 * @param {Array<object>} records
 * @param {object} key - must contain every field in keyFields
 * @returns {object|null} the matching record, or null if none
 */
function findQuizProgress(records, key) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array');
  }
  if (key === null || typeof key !== 'object') {
    throw new TypeError('key must be an object');
  }
  for (const field of keyFields) {
    if (key[field] === undefined) {
      throw new Error(`missing key field: ${field}`);
    }
  }
  return records.find((r) => keyFields.every((f) => r[f] === key[f])) ?? null;
}

module.exports = { findQuizProgress, keyFields };

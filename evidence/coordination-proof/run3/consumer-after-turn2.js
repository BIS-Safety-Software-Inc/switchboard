'use strict';
// Consumer of quiz_progress. Key fields are read from lib/schema.js so this
// stays correct if the schema's key contract changes.
const { quiz_progress } = require('./lib/schema');

const keyFields = [...quiz_progress.key];

/**
 * Find one quiz_progress record by its key.
 * @param {Array<object>} records
 * @param {object} key - must contain every field in keyFields
 * @returns {object|null}
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
  return records.find((r) => keyFields.every((f) => r[f] === key[f])) || null;
}

module.exports = { findQuizProgress, keyFields };

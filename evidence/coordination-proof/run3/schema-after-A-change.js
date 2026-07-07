'use strict';
/**
 * Data-shape contracts for the quiz service.
 * quiz_progress: tracks how far a user has gotten.
 *
 * CONTRACT (v2): COMPOSITE key — a user can have progress per quiz per attempt.
 */
const quiz_progress = {
  key: ['user_id', 'quiz_id', 'attempt_no'],
  fields: {
    user_id: 'string',
    quiz_id: 'string',
    attempt_no: 'number',
    percent_complete: 'number',
  },
};

module.exports = { quiz_progress };

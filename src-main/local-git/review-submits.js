const {randomBytes} = require('node:crypto');
const {GitServiceError} = require('./github-auth');

/**
 * The review submit records of one Desktop Git session, kept in the main process memory. They follow the records of
 * the Cloudflare `GitSession` (hierarchidb packages/backend/bff/src/GitSession.ts): one `Review-Submit-Id` is one
 * review submission, each step is checked against the record and marked in flight without an `await` in between, and
 * the outcome is applied only while the step's attempt nonce is current. The records are dropped with the session.
 */

const MAX_REVIEW_RECORDS = 256;
const REVIEW_STEP_TIMEOUT = 60_000;
const nodeIdPattern = /^[A-Za-z0-9_=-]{1,200}$/u;
const inFlight = ['starting', 'threading', 'submitting', 'deleting'];

const attempt = () => randomBytes(32).toString('base64url');
const finished = state => state === 'submitted' || state === 'closed';

function createReviewRecords () {
  return {reviewIds: new Set(), submits: new Map()};
}

function clearReviewRecords (records) {
  records.reviewIds.clear();
  records.submits.clear();
}

const size = records => records.reviewIds.size + records.submits.size;

/** Applies the outcome of the current step to a record, or returns null when it does not apply to the state. */
function transition (record, outcome, ids, now) {
  const next = patch => ({...record, ...patch, since: now, attempt: attempt()});
  switch (record.state) {
    case 'starting':
      if (outcome === 'ok') {
        if (!ids.pullRequestNodeId || !ids.reviewNodeId) return null;
        return next({state: 'pending', threads: 0, pullRequestNodeId: ids.pullRequestNodeId, reviewNodeId: ids.reviewNodeId});
      }
      if (outcome === 'failed') return next({state: 'closed'});
      if (outcome === 'unknown') return next({state: 'start-unknown'});
      return null;
    case 'threading':
      if (outcome === 'ok') return next({state: 'pending', threads: record.threads + 1, threadIndex: null});
      if (outcome === 'failed' || outcome === 'unknown') return next({state: 'broken'});
      if (outcome === 'gone') return next({state: 'closed'});
      return null;
    case 'submitting':
      if (outcome === 'ok') return next({state: 'submitted'});
      if (outcome === 'failed') return next({state: 'pending'});
      if (outcome === 'unknown') return next({state: 'submit-unknown'});
      if (outcome === 'gone') return next({state: 'closed'});
      return null;
    case 'deleting':
      if (!record.resume) return null;
      if (outcome === 'ok' || outcome === 'gone') return next({state: 'closed', resume: null});
      if (outcome === 'failed' || outcome === 'unknown') return next({state: record.resume, resume: null});
      return null;
    case 'start-unknown':
      if (outcome === 'pending') {
        if (!ids.pullRequestNodeId || !ids.reviewNodeId) return null;
        return next({state: 'pending', threads: 0, pullRequestNodeId: ids.pullRequestNodeId, reviewNodeId: ids.reviewNodeId});
      }
      if (outcome === 'closed') return next({state: 'closed'});
      return null;
    case 'submit-unknown':
      if (outcome === 'pending' || outcome === 'submitted' || outcome === 'closed') return next({state: outcome});
      return null;
    default:
      return null;
  }
}

/** Reads an in-flight step older than the step timeout as an unknown outcome, so it does not block the submission. */
function settle (record, now) {
  if (!inFlight.includes(record.state) || now - record.since < REVIEW_STEP_TIMEOUT) return record;
  const settled = transition(record, 'unknown', {}, now);
  if (!settled) throw new Error('An in-flight review submit record cannot settle');
  return settled;
}

/** Reserves the ID of a review-body POST. */
function reserveReview (records, reviewId) {
  if (records.reviewIds.has(reviewId) || records.submits.has(reviewId)) throw new GitServiceError(409, 'REVIEW_DUPLICATE');
  if (size(records) >= MAX_REVIEW_RECORDS) throw new GitServiceError(429, 'RATE_LIMITED');
  records.reviewIds.add(reviewId);
}

/**
 * Checks a GraphQL review step against the records and marks it in flight. `submit` is `{id, step, number}` plus
 * `commitOid` (start), `threadIndex` (thread) or `threadCount` (submit). Returns the record the step continues with.
 */
function reserveStep (records, submit, repositoryId, now) {
  const {submits} = records;
  const existing = submits.get(submit.id);
  if (submit.step === 'start') {
    if (existing || records.reviewIds.has(submit.id)) throw new GitServiceError(409, 'REVIEW_DUPLICATE');
    for (const [id, value] of submits) {
      const record = settle(value, now);
      submits.set(id, record);
      if (record.repositoryId === repositoryId && record.number === submit.number && !finished(record.state)) {
        throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
      }
    }
    if (size(records) >= MAX_REVIEW_RECORDS) throw new GitServiceError(429, 'RATE_LIMITED');
    const record = {
      repositoryId, number: submit.number, commitOid: submit.commitOid, pullRequestNodeId: null, reviewNodeId: null,
      threads: 0, state: 'starting', resume: null, threadIndex: null, since: now, attempt: attempt()
    };
    submits.set(submit.id, record);
    return record;
  }
  if (!existing || existing.repositoryId !== repositoryId || existing.number !== submit.number) {
    throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  }
  const record = settle(existing, now);
  submits.set(submit.id, record);
  const begin = patch => {
    const value = {...record, ...patch, since: now, attempt: attempt()};
    submits.set(submit.id, value);
    return value;
  };
  switch (submit.step) {
    case 'context':
      return record;
    case 'thread': {
      const index = submit.threadIndex;
      if (record.state === 'pending' && index === record.threads) return begin({state: 'threading', threadIndex: index});
      if (index < record.threads || ((record.state === 'threading' || record.state === 'broken') && index === record.threadIndex)) {
        throw new GitServiceError(409, 'REVIEW_DUPLICATE');
      }
      throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  }
  case 'submit':
    if (record.state === 'pending' && submit.threadCount === record.threads) return begin({state: 'submitting'});
    if (['submitting', 'submit-unknown', 'submitted'].includes(record.state)) throw new GitServiceError(409, 'REVIEW_DUPLICATE');
    throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  case 'delete':
    if (record.state === 'pending' || record.state === 'broken') return begin({state: 'deleting', resume: record.state});
    if (record.state === 'deleting' || record.state === 'closed') throw new GitServiceError(409, 'REVIEW_DUPLICATE');
    throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  default:
    throw new GitServiceError(400, 'BAD_REQUEST');
  }
}

/** Records the upstream outcome of a reserved step while its attempt is current, and returns the next state. */
function applyResult (records, submitId, currentAttempt, outcome, ids, now) {
  if ((ids.pullRequestNodeId !== undefined && !nodeIdPattern.test(ids.pullRequestNodeId)) ||
      (ids.reviewNodeId !== undefined && !nodeIdPattern.test(ids.reviewNodeId))) {
    throw new GitServiceError(400, 'BAD_REQUEST');
  }
  const record = records.submits.get(submitId);
  if (!record || record.attempt !== currentAttempt) throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  const updated = transition(record, outcome, ids, now);
  if (!updated) throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
  records.submits.set(submitId, updated);
  return {state: updated.state, threads: updated.threads};
}

module.exports = {
  MAX_REVIEW_RECORDS, REVIEW_STEP_TIMEOUT, applyResult, clearReviewRecords, createReviewRecords, reserveReview, reserveStep
};

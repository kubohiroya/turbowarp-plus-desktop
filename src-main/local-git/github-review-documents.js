/**
 * The only GraphQL documents the loopback proxy sends to GitHub. They are the documents of the Cloudflare Git Worker
 * (hierarchidb packages/backend/cors-proxy/src/githubReviewDocuments.ts), so both proxies behave the same. The Editor
 * names an operation and sends variables; it never sends a document, a pull request node ID or a review node ID.
 */
const githubReviewDocuments = Object.freeze({
  pullRequestReviewContext: `query PullRequestReviewContext($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name, followRenames: false) {
    databaseId
    pullRequest(number: $number) {
      id
      headRefOid
      pending: reviews(states: [PENDING], first: 5) {
        nodes { id viewerDidAuthor createdAt body commit { oid } comments(first: 1) { totalCount } }
      }
      recent: reviews(last: 30) {
        nodes { id viewerDidAuthor state submittedAt commit { oid } }
      }
    }
  }
}`,
  addPullRequestReview: `mutation AddPullRequestReview($pullRequestId: ID!, $commitOid: GitObjectID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOid}) {
    pullRequestReview { id state commit { oid } pullRequest { id } }
  }
}`,
  addPullRequestReviewThread: `mutation AddPullRequestReviewThread($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $reviewId, path: $path, subjectType: FILE, body: $body}) {
    thread { id path subjectType }
  }
}`,
  submitPullRequestReview: `mutation SubmitPullRequestReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: $event, body: $body}) {
    pullRequestReview { id state submittedAt url commit { oid } }
  }
}`,
  deletePullRequestReview: `mutation DeletePullRequestReview($reviewId: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $reviewId}) {
    pullRequestReview { id }
  }
}`,
});

const isGitHubReviewOperation = value => Object.hasOwn(githubReviewDocuments, value);

module.exports = {githubReviewDocuments, isGitHubReviewOperation};

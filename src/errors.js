// An error whose message is safe to show to the student. The Unity app displays `error` as-is.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };

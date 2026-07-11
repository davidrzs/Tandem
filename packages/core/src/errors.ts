/**
 * Domain errors. Services stay transport-agnostic; the API layer maps these to
 * HTTP/tRPC codes instead of collapsing every service failure into a 500.
 */
export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class InvalidInputError extends Error {
  constructor(message = "invalid input") {
    super(message);
    this.name = "InvalidInputError";
  }
}

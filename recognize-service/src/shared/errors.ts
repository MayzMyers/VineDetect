export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class UpstreamServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 502 | 503 = 502,
    public readonly transport: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "UpstreamServiceError";
  }
}

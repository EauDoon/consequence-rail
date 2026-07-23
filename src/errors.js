export class RailError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RailError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.details,
    };
  }
}

export class UnknownExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnknownExecutionError";
    this.details = details;
  }
}

export class UnknownRemedyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnknownRemedyError";
    this.details = details;
  }
}

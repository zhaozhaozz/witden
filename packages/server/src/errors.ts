export class WitdenError extends Error {
  status = 400;
  code = "bad_request";
  detail: Record<string, unknown>;

  constructor(message: string, opts: { code?: string; detail?: Record<string, unknown> } = {}) {
    super(message);
    if (opts.code) this.code = opts.code;
    this.detail = opts.detail ?? {};
  }
}

export class BadRequest extends WitdenError {}

export class NotFound extends WitdenError {
  override status = 404;
  override code = "not_found";
}

export class Conflict extends WitdenError {
  override status = 409;
  override code = "conflict";
}

export class Unauthorized extends WitdenError {
  override status = 401;
  override code = "unauthorized";
}

export class Forbidden extends WitdenError {
  override status = 403;
  override code = "permission_denied";
}

export class Unavailable extends WitdenError {
  override status = 503;
  override code = "unavailable";
}

/** The computer a task is bound to cannot be used right now. Work waits or fails; it never runs elsewhere. */
export class InstanceUnavailable extends Unavailable {
  override code = "instance_unavailable";
}

/** The desktop is being operated by someone else, or a person has taken over. */
export class InstanceBusy extends Conflict {
  override code = "instance_busy";
}

export class ModelError extends Unavailable {
  override code = "model_error";
}

export function constructorFor(err: WitdenError): string {
  return err.constructor.name;
}

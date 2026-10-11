/** Error codes carried in `ManagerErrorBody.error.code`, with the HTTP status the server maps them to. */
export const ERROR_STATUS = {
  invalid: 400,
  unauthorized: 401,
  not_managed: 403,
  not_found: 404,
  conflict: 409,
  not_running: 409,
  internal: 500,
  docker_error: 502,
  unavailable: 503,
} as const;

export type ManagerErrorCode = keyof typeof ERROR_STATUS;

export function isManagerErrorCode(code: unknown): code is ManagerErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_STATUS, code);
}

/** Thrown by `DockerManager` and `ManagerClient`; the same class on both sides of the HTTP API. */
export class ManagerError extends Error {
  readonly code: ManagerErrorCode;

  constructor(code: ManagerErrorCode, message: string) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

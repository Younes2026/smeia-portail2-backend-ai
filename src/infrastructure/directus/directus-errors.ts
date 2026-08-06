export type DirectusErrorCode =
  | "DIRECTUS_UNAUTHORIZED"
  | "DIRECTUS_FORBIDDEN"
  | "DIRECTUS_NOT_FOUND"
  | "DIRECTUS_VEHICLE_NOT_ACCESSIBLE"
  | "DIRECTUS_INVALID_VEHICLE_ID"
  | "DIRECTUS_TIMEOUT"
  | "DIRECTUS_UNAVAILABLE"
  | "DIRECTUS_INVALID_RESPONSE"
  | "DIRECTUS_ERROR";

const safeErrorMessages: Record<DirectusErrorCode, string> = {
  DIRECTUS_UNAUTHORIZED: "Directus authentication is required.",
  DIRECTUS_FORBIDDEN: "Directus access is forbidden.",
  DIRECTUS_NOT_FOUND: "The requested Directus resource was not found.",
  DIRECTUS_VEHICLE_NOT_ACCESSIBLE: "The vehicle is not accessible.",
  DIRECTUS_INVALID_VEHICLE_ID: "The vehicle identifier is invalid.",
  DIRECTUS_TIMEOUT: "Directus did not respond in time.",
  DIRECTUS_UNAVAILABLE: "Directus is temporarily unavailable.",
  DIRECTUS_INVALID_RESPONSE: "Directus returned an invalid response.",
  DIRECTUS_ERROR: "Directus returned an unexpected error.",
};

export class DirectusError extends Error {
  readonly code: DirectusErrorCode;

  constructor(code: DirectusErrorCode) {
    super(safeErrorMessages[code]);
    this.name = "DirectusError";
    this.code = code;
  }
}

export const mapDirectusHttpStatus = (status: number): DirectusError => {
  if (status === 401) {
    return new DirectusError("DIRECTUS_UNAUTHORIZED");
  }

  if (status === 403) {
    return new DirectusError("DIRECTUS_FORBIDDEN");
  }

  if (status === 404) {
    return new DirectusError("DIRECTUS_NOT_FOUND");
  }

  return new DirectusError("DIRECTUS_ERROR");
};

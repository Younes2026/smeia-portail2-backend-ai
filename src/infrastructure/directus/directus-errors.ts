export type DirectusErrorCode =
  | "DIRECTUS_UNAUTHORIZED"
  | "DIRECTUS_FORBIDDEN"
  | "DIRECTUS_NOT_FOUND"
  | "DIRECTUS_CONFLICT"
  | "DIRECTUS_VEHICLE_NOT_ACCESSIBLE"
  | "DIRECTUS_INVALID_VEHICLE_ID"
  | "DIRECTUS_TIMEOUT"
  | "DIRECTUS_UNAVAILABLE"
  | "DIRECTUS_INVALID_RESPONSE"
  | "DIRECTUS_ERROR";

export type DirectusResponseDiagnostic = {
  directus_http_status: number;
  response_kind: "empty" | "json" | "non_json";
  data_kind: "missing" | "object" | "array";
  data_length?: number;
  field_names?: string[];
};

const getFieldNames = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value).sort().slice(0, 32)
    : undefined;

export const describeDirectusJsonResponse = (
  payload: unknown,
  httpStatus = 200,
): DirectusResponseDiagnostic => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      directus_http_status: httpStatus,
      response_kind: "json",
      data_kind: "missing",
    };
  }

  if (!("data" in payload)) {
    const fieldNames = getFieldNames(payload);
    return {
      directus_http_status: httpStatus,
      response_kind: "json",
      data_kind: "missing",
      ...(fieldNames === undefined ? {} : { field_names: fieldNames }),
    };
  }

  const data = Reflect.get(payload, "data");
  if (Array.isArray(data)) {
    const fieldNames = data.length === 1 ? getFieldNames(data[0]) : undefined;
    return {
      directus_http_status: httpStatus,
      response_kind: "json",
      data_kind: "array",
      data_length: data.length,
      ...(fieldNames === undefined ? {} : { field_names: fieldNames }),
    };
  }

  if (typeof data === "object" && data !== null) {
    const fieldNames = getFieldNames(data);
    return {
      directus_http_status: httpStatus,
      response_kind: "json",
      data_kind: "object",
      ...(fieldNames === undefined ? {} : { field_names: fieldNames }),
    };
  }

  return {
    directus_http_status: httpStatus,
    response_kind: "json",
    data_kind: "missing",
  };
};

const safeErrorMessages: Record<DirectusErrorCode, string> = {
  DIRECTUS_UNAUTHORIZED: "Directus authentication is required.",
  DIRECTUS_FORBIDDEN: "Directus access is forbidden.",
  DIRECTUS_NOT_FOUND: "The requested Directus resource was not found.",
  DIRECTUS_CONFLICT: "The Directus resource conflicts with existing data.",
  DIRECTUS_VEHICLE_NOT_ACCESSIBLE: "The vehicle is not accessible.",
  DIRECTUS_INVALID_VEHICLE_ID: "The vehicle identifier is invalid.",
  DIRECTUS_TIMEOUT: "Directus did not respond in time.",
  DIRECTUS_UNAVAILABLE: "Directus is temporarily unavailable.",
  DIRECTUS_INVALID_RESPONSE: "Directus returned an invalid response.",
  DIRECTUS_ERROR: "Directus returned an unexpected error.",
};

export class DirectusError extends Error {
  readonly code: DirectusErrorCode;
  readonly httpStatus: number | undefined;
  readonly responseDiagnostic: DirectusResponseDiagnostic | undefined;

  constructor(
    code: DirectusErrorCode,
    httpStatus?: number,
    responseDiagnostic?: DirectusResponseDiagnostic,
  ) {
    super(safeErrorMessages[code]);
    this.name = "DirectusError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.responseDiagnostic = responseDiagnostic;
  }
}

export const mapDirectusHttpStatus = (status: number): DirectusError => {
  if (status === 401) {
    return new DirectusError("DIRECTUS_UNAUTHORIZED", status);
  }

  if (status === 403) {
    return new DirectusError("DIRECTUS_FORBIDDEN", status);
  }

  if (status === 404) {
    return new DirectusError("DIRECTUS_NOT_FOUND", status);
  }

  if (status === 409) {
    return new DirectusError("DIRECTUS_CONFLICT", status);
  }

  return new DirectusError("DIRECTUS_ERROR", status);
};

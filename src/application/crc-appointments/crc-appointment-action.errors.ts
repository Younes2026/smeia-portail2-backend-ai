export type CrcAppointmentActionErrorCode =
  | "CRC_APPOINTMENT_NOT_FOUND"
  | "CRC_APPOINTMENT_NOT_TREATABLE"
  | "CRC_APPOINTMENT_CONFLICT"
  | "CRC_IDEMPOTENCY_CONFLICT"
  | "CRC_HISTORY_WRITE_FAILED"
  | "CRC_WRITE_CONFIGURATION_UNAVAILABLE";

const messages: Record<CrcAppointmentActionErrorCode, string> = {
  CRC_APPOINTMENT_NOT_FOUND: "The CRC appointment was not found.",
  CRC_APPOINTMENT_NOT_TREATABLE:
    "The CRC appointment cannot be changed from its current status.",
  CRC_APPOINTMENT_CONFLICT:
    "The CRC appointment was changed by another request.",
  CRC_IDEMPOTENCY_CONFLICT:
    "The idempotency key was already used for another request.",
  CRC_HISTORY_WRITE_FAILED:
    "The appointment status changed, but its CRC history could not be recorded.",
  CRC_WRITE_CONFIGURATION_UNAVAILABLE:
    "CRC appointment writes are not configured.",
};

export class CrcAppointmentActionError extends Error {
  readonly code: CrcAppointmentActionErrorCode;

  constructor(code: CrcAppointmentActionErrorCode) {
    super(messages[code]);
    this.name = "CrcAppointmentActionError";
    this.code = code;
  }
}

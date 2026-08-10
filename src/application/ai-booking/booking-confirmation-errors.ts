export type BookingConfirmationErrorCode =
  | "INVALID_SLOT_TOKEN"
  | "SLOT_OFFER_EXPIRED"
  | "SLOT_NO_LONGER_AVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "BOOKING_CONTEXT_INVALID"
  | "APPOINTMENT_CREATION_FAILED"
  | "BOOKING_CONFIGURATION_UNAVAILABLE";

const safeMessages: Record<BookingConfirmationErrorCode, string> = {
  INVALID_SLOT_TOKEN: "The appointment slot token is invalid.",
  SLOT_OFFER_EXPIRED:
    "The appointment offer has expired. Search for availability again.",
  SLOT_NO_LONGER_AVAILABLE:
    "The appointment slot is no longer available.",
  IDEMPOTENCY_CONFLICT:
    "The idempotency key was already used with another request.",
  BOOKING_CONTEXT_INVALID:
    "The appointment booking context is no longer valid.",
  APPOINTMENT_CREATION_FAILED:
    "The appointment could not be created.",
  BOOKING_CONFIGURATION_UNAVAILABLE:
    "Appointment confirmation is not configured.",
};

export class BookingConfirmationError extends Error {
  readonly code: BookingConfirmationErrorCode;

  constructor(code: BookingConfirmationErrorCode) {
    super(safeMessages[code]);
    this.name = "BookingConfirmationError";
    this.code = code;
  }
}

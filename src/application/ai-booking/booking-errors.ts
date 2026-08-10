export type BookingAvailabilityErrorCode =
  | "BOOKING_AVAILABILITY_NOT_FOUND"
  | "BOOKING_CONFIGURATION_ERROR"
  | "BOOKING_SLOT_TOKEN_EXPIRED"
  | "BOOKING_SLOT_TOKEN_INVALID"
  | "BOOKING_UPSTREAM_ERROR";

const safeMessages: Record<BookingAvailabilityErrorCode, string> = {
  BOOKING_AVAILABILITY_NOT_FOUND:
    "No compatible appointment availability was found.",
  BOOKING_CONFIGURATION_ERROR:
    "Appointment booking is not configured.",
  BOOKING_SLOT_TOKEN_EXPIRED:
    "The appointment slot token has expired.",
  BOOKING_SLOT_TOKEN_INVALID:
    "The appointment slot token is invalid.",
  BOOKING_UPSTREAM_ERROR:
    "Appointment availability is temporarily unavailable.",
};

export class BookingAvailabilityError extends Error {
  readonly code: BookingAvailabilityErrorCode;

  constructor(code: BookingAvailabilityErrorCode) {
    super(safeMessages[code]);
    this.name = "BookingAvailabilityError";
    this.code = code;
  }
}

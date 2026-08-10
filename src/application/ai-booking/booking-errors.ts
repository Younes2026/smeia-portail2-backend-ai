export type BookingAvailabilityErrorCode =
  | "BOOKING_AVAILABILITY_NOT_FOUND"
  | "BOOKING_UPSTREAM_ERROR";

const safeMessages: Record<BookingAvailabilityErrorCode, string> = {
  BOOKING_AVAILABILITY_NOT_FOUND:
    "No compatible appointment availability was found.",
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

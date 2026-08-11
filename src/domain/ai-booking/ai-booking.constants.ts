export const BOOKING_TIME_ZONE = "Africa/Casablanca" as const;

export const BOOKING_SEARCH_WINDOW_DAYS = 30;

export const MAX_BOOKING_OPTIONS = 3;

export const MAX_DAY_SLOT_OPTIONS = 40;

export const OCCUPYING_APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
] as const;

export const BOOKING_PERIODS = ["any", "morning", "afternoon"] as const;

export const BOOKING_RESULT_MODES = ["suggestions", "day_slots"] as const;

export const BOOKING_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

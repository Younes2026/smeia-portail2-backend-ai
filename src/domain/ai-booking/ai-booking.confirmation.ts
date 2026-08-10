import {
  OCCUPYING_APPOINTMENT_STATUSES,
  type BOOKING_WEEKDAYS,
} from "./ai-booking.constants.js";
import type {
  BookingWorkshop,
  DirectusBookingAvailabilitySnapshot,
} from "./ai-booking.availability.js";

type BookingWeekday = (typeof BOOKING_WEEKDAYS)[number];

export type BookingSlotSelection = {
  workshop_id: 1 | 2 | 3 | 4;
  requested_date: string;
  requested_time: string;
  slot_interval_minutes: number;
};

export type BookingSlotCheckResult =
  | { status: "available"; workshop: BookingWorkshop }
  | { status: "invalid_context" }
  | { status: "unavailable" };

const weekdayByIsoNumber: readonly BookingWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const timeToSeconds = (time: string) => {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return hours * 3_600 + minutes * 60 + seconds;
};

const getWeekday = (date: string): BookingWeekday => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekdayByIsoNumber[day] ?? "sunday";
};

const isOccupyingStatus = (status: string) =>
  (OCCUPYING_APPOINTMENT_STATUSES as readonly string[]).includes(
    status.trim().toLowerCase(),
  );

export const checkBookingSlotAvailability = (
  selection: BookingSlotSelection,
  snapshot: DirectusBookingAvailabilitySnapshot,
  notBefore: { date: string; time: string },
): BookingSlotCheckResult => {
  const workshop = snapshot.workshops.find(
    (candidate) => candidate.id === selection.workshop_id,
  );
  if (
    workshop === undefined ||
    !workshop.active ||
    !workshop.client_bookable ||
    workshop.slot_interval_minutes !== selection.slot_interval_minutes
  ) {
    return { status: "invalid_context" };
  }

  if (
    selection.requested_date < notBefore.date ||
    (selection.requested_date === notBefore.date &&
      selection.requested_time < notBefore.time) ||
    !workshop.working_days.includes(getWeekday(selection.requested_date))
  ) {
    return { status: "unavailable" };
  }

  const openingSeconds = timeToSeconds(workshop.opening_time);
  const closingSeconds = timeToSeconds(workshop.closing_time);
  const requestedSeconds = timeToSeconds(selection.requested_time);
  const intervalSeconds = selection.slot_interval_minutes * 60;
  if (
    requestedSeconds < openingSeconds ||
    requestedSeconds + intervalSeconds > closingSeconds ||
    (requestedSeconds - openingSeconds) % intervalSeconds !== 0
  ) {
    return { status: "unavailable" };
  }

  const schedule = snapshot.schedules.find(
    (candidate) =>
      candidate.workshop_id === selection.workshop_id &&
      candidate.date === selection.requested_date,
  );
  if (
    schedule === undefined ||
    schedule.remaining_capacity_hours + Number.EPSILON <
      selection.slot_interval_minutes / 60
  ) {
    return { status: "unavailable" };
  }

  const activeResourceCount = snapshot.resources.filter(
    (resource) =>
      resource.workshop_id === selection.workshop_id && resource.active,
  ).length;
  if (activeResourceCount === 0) {
    return { status: "unavailable" };
  }

  const occupiedPlaces = snapshot.appointments.filter(
    (appointment) =>
      appointment.workshop_id === selection.workshop_id &&
      appointment.requested_date === selection.requested_date &&
      appointment.requested_time === selection.requested_time &&
      isOccupyingStatus(appointment.status),
  ).length;
  if (occupiedPlaces >= activeResourceCount) {
    return { status: "unavailable" };
  }

  return { status: "available", workshop };
};

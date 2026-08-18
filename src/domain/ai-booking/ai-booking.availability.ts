import type { AppointmentAvailabilityRequest } from "./ai-booking.schema.js";
import {
  BOOKING_TIME_ZONE,
  MAX_BOOKING_OPTIONS,
  MAX_DAY_SLOT_OPTIONS,
  OCCUPYING_APPOINTMENT_STATUSES,
  type BOOKING_WEEKDAYS,
} from "./ai-booking.constants.js";
import {
  AppointmentAvailabilityCalendarResultSchema,
  AppointmentAvailabilityResultSchema,
  type AppointmentAvailabilityCalendarResult,
  type AppointmentAvailabilityOption,
  type AppointmentAvailabilityResult,
  type BookingShowroom,
  type BookingWorkshopType,
} from "./ai-booking.schema.js";

export type BookingWeekday = (typeof BOOKING_WEEKDAYS)[number];

export type BookingWorkshop = {
  id: number;
  name: string;
  workshop_type: BookingWorkshopType;
  opening_time: string;
  closing_time: string;
  working_days: BookingWeekday[];
  slot_interval_minutes: number;
  active: boolean;
  client_bookable: boolean;
  showroom: BookingShowroom;
};

export type BookingSchedule = {
  workshop_id: number;
  date: string;
  total_capacity_hours: number;
  used_capacity_hours: number;
  remaining_capacity_hours: number;
};

export type BookingResource = {
  workshop_id: number;
  active: boolean;
  daily_hours: number | null;
};

export type BookingAppointment = {
  workshop_id: number;
  requested_date: string;
  requested_time: string;
  status: string;
};

export type DirectusBookingAvailabilitySnapshot = {
  workshops: BookingWorkshop[];
  schedules: BookingSchedule[];
  resources: BookingResource[];
  appointments: BookingAppointment[];
};

const weekdayByIsoNumber: readonly BookingWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const addIsoDateDays = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const getCasablancaIsoDate = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
};

export const getCasablancaIsoTime = (value: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: BOOKING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(value);

const timeToSeconds = (time: string) => {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return hours * 3_600 + minutes * 60 + seconds;
};

const secondsToTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

const normalizeStatus = (status: string) => status.trim().toLowerCase();

const isOccupyingStatus = (status: string) =>
  (OCCUPYING_APPOINTMENT_STATUSES as readonly string[]).includes(
    normalizeStatus(status),
  );

const getWeekday = (date: string): BookingWeekday => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekdayByIsoNumber[day] ?? "sunday";
};

const isPreferredPeriod = (
  time: string,
  period: AppointmentAvailabilityRequest["preferred_period"],
) => {
  if (period === "any") {
    return true;
  }

  const isMorning = timeToSeconds(time) < 12 * 3_600;
  return period === "morning" ? isMorning : !isMorning;
};

const formatOptionLabel = (
  workshopName: string,
  date: string,
  time: string,
) => {
  const [year, month, day] = date.split("-");
  return `${workshopName} — ${day}/${month}/${year} à ${time.slice(0, 5)}`;
};

type RankedOption = {
  dateRank: number;
  timeRank: number;
  workshopRank: number;
  option: AppointmentAvailabilityOption;
};

const findRankedAppointmentAvailability = (
  request: AppointmentAvailabilityRequest,
  snapshot: DirectusBookingAvailabilitySnapshot,
  startDate: string,
  endDate: string,
  notBefore?: { date: string; time: string },
  calendarMode = false,
): RankedOption[] => {
  const searchStartDate =
    request.result_mode === "day_slots" && request.preferred_date !== null
      ? request.preferred_date
      : startDate;
  const searchEndDate =
    request.result_mode === "day_slots" ? searchStartDate : endDate;
  const requestedWorkshopOrder = new Map(
    request.workshop_types.map((workshopType, index) => [workshopType, index]),
  );
  const schedulesByWorkshopAndDate = new Map(
    snapshot.schedules.map((schedule) => [
      `${schedule.workshop_id}|${schedule.date}`,
      schedule,
    ]),
  );
  const resourceCountByWorkshop = new Map<number, number>();
  for (const resource of snapshot.resources) {
    if (!resource.active) {
      continue;
    }
    resourceCountByWorkshop.set(
      resource.workshop_id,
      (resourceCountByWorkshop.get(resource.workshop_id) ?? 0) + 1,
    );
  }

  const occupancyBySlot = new Map<string, number>();
  for (const appointment of snapshot.appointments) {
    if (!isOccupyingStatus(appointment.status)) {
      continue;
    }
    const key = `${appointment.workshop_id}|${appointment.requested_date}|${appointment.requested_time}`;
    occupancyBySlot.set(key, (occupancyBySlot.get(key) ?? 0) + 1);
  }

  const rankedOptions: RankedOption[] = [];
  for (
    let date = searchStartDate, dateRank = 0;
    date <= searchEndDate;
    date = addIsoDateDays(date, 1), dateRank += 1
  ) {
    const weekday = getWeekday(date);
    if (
      calendarMode &&
      (weekday === "saturday" || weekday === "sunday")
    ) {
      continue;
    }

    for (const workshop of snapshot.workshops) {
      const workshopRank = requestedWorkshopOrder.get(workshop.workshop_type);
      if (
        workshopRank === undefined ||
        workshop.showroom.id !== request.showroom_id ||
        !workshop.active ||
        !workshop.client_bookable ||
        !workshop.working_days.includes(weekday)
      ) {
        continue;
      }

      const schedule = schedulesByWorkshopAndDate.get(`${workshop.id}|${date}`);
      const requiredCapacityHours = workshop.slot_interval_minutes / 60;
      if (
        schedule === undefined ||
        schedule.remaining_capacity_hours + Number.EPSILON <
          requiredCapacityHours
      ) {
        continue;
      }

      const resourceCount = resourceCountByWorkshop.get(workshop.id) ?? 0;
      if (resourceCount === 0) {
        continue;
      }

      const openingSeconds = timeToSeconds(workshop.opening_time);
      const closingSeconds = timeToSeconds(workshop.closing_time);
      const intervalSeconds = workshop.slot_interval_minutes * 60;

      for (
        let slotSeconds = openingSeconds;
        slotSeconds + intervalSeconds <= closingSeconds;
        slotSeconds += intervalSeconds
      ) {
        const requestedTime = secondsToTime(slotSeconds);
        if (
          !calendarMode &&
          !isPreferredPeriod(requestedTime, request.preferred_period)
        ) {
          continue;
        }
        if (
          notBefore !== undefined &&
          date === notBefore.date &&
          requestedTime < notBefore.time
        ) {
          continue;
        }
        const occupancyKey = `${workshop.id}|${date}|${requestedTime}`;
        const occupiedPlaces = occupancyBySlot.get(occupancyKey) ?? 0;
        if (occupiedPlaces >= resourceCount) {
          continue;
        }

        rankedOptions.push({
          dateRank,
          timeRank: slotSeconds,
          workshopRank,
          option: {
            workshop_id: workshop.id,
            workshop_name: workshop.name,
            showroom: workshop.showroom,
            requested_date: date,
            requested_time: requestedTime,
            slot_interval_minutes: workshop.slot_interval_minutes,
            label: formatOptionLabel(workshop.name, date, requestedTime),
          },
        });
      }
    }
  }

  rankedOptions.sort(
    (left, right) =>
      left.dateRank - right.dateRank ||
      left.timeRank - right.timeRank ||
      left.workshopRank - right.workshopRank,
  );

  return rankedOptions;
};

export const findAppointmentAvailability = (
  request: AppointmentAvailabilityRequest,
  snapshot: DirectusBookingAvailabilitySnapshot,
  startDate: string,
  endDate: string,
  notBefore?: { date: string; time: string },
): AppointmentAvailabilityResult => {
  const rankedOptions = findRankedAppointmentAvailability(
    request,
    snapshot,
    startDate,
    endDate,
    notBefore,
  );

  const seenSlotKeys = new Set<string>();
  const deduplicatedOptions =
    request.result_mode === "day_slots"
      ? rankedOptions.filter(({ option }) => {
          const key = `${option.workshop_id}|${option.requested_date}|${option.requested_time}`;
          if (seenSlotKeys.has(key)) {
            return false;
          }
          seenSlotKeys.add(key);
          return true;
        })
      : rankedOptions;
  const maximumOptions =
    request.result_mode === "day_slots"
      ? MAX_DAY_SLOT_OPTIONS
      : MAX_BOOKING_OPTIONS;
  const options = deduplicatedOptions
    .slice(0, maximumOptions)
    .map(({ option }) => option);
  const preferredDateAvailable =
    request.result_mode === "day_slots"
      ? options.length > 0
      : request.preferred_date !== null &&
        rankedOptions.some(
          ({ option }) => option.requested_date === request.preferred_date,
        );

  return AppointmentAvailabilityResultSchema.parse({
    preferred_date_available: preferredDateAvailable,
    options,
  });
};

export const findAppointmentAvailabilityCalendar = (
  request: AppointmentAvailabilityRequest,
  snapshot: DirectusBookingAvailabilitySnapshot,
  startDate: string,
  endDate: string,
  notBefore?: { date: string; time: string },
): AppointmentAvailabilityCalendarResult => {
  const rankedOptions = findRankedAppointmentAvailability(
    request,
    snapshot,
    startDate,
    endDate,
    notBefore,
    true,
  );
  const seenSlotKeys = new Set<string>();
  const countsByDate = new Map<
    string,
    {
      available_slot_count: number;
      morning_slot_count: number;
      afternoon_slot_count: number;
    }
  >();

  for (const { option } of rankedOptions) {
    const key = `${option.workshop_id}|${option.requested_date}|${option.requested_time}`;
    if (seenSlotKeys.has(key)) {
      continue;
    }
    seenSlotKeys.add(key);

    const counts = countsByDate.get(option.requested_date) ?? {
      available_slot_count: 0,
      morning_slot_count: 0,
      afternoon_slot_count: 0,
    };
    counts.available_slot_count += 1;
    if (timeToSeconds(option.requested_time) < 12 * 3_600) {
      counts.morning_slot_count += 1;
    } else {
      counts.afternoon_slot_count += 1;
    }
    countsByDate.set(option.requested_date, counts);
  }

  return AppointmentAvailabilityCalendarResultSchema.parse({
    result_mode: "calendar",
    timezone: BOOKING_TIME_ZONE,
    horizon_start: startDate,
    horizon_end: endDate,
    days: [...countsByDate].map(([date, counts]) => ({ date, ...counts })),
  });
};

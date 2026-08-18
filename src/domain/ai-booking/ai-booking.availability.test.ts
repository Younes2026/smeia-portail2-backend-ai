import assert from "node:assert/strict";
import test from "node:test";

import type { AppointmentAvailabilityRequest } from "./ai-booking.schema.js";
import {
  addIsoDateDays,
  findAppointmentAvailability,
  findAppointmentAvailabilityCalendar,
  type BookingAppointment,
  type BookingWorkshop,
  type DirectusBookingAvailabilitySnapshot,
} from "./ai-booking.availability.js";

const MONDAY = "2026-08-10";
const TUESDAY = "2026-08-11";
const WINDOW_END = "2026-09-08";
const AFTER_WINDOW = "2026-09-09";

const createWorkshop = (
  id: number,
  overrides: Partial<BookingWorkshop> = {},
): BookingWorkshop => ({
  id,
  name: `Atelier ${id}`,
  workshop_type:
    id === 1 ? "diagnostic" : id === 2 ? "mecanique" : "carrosserie",
  opening_time: "08:00:00",
  closing_time: "17:00:00",
  working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  slot_interval_minutes: 30,
  active: true,
  client_bookable: true,
  showroom: {
    id: 1,
    name: "Showroom 1",
    address: "Adresse test",
    city: "Casablanca",
    phone: "0000000000",
  },
  ...overrides,
});

const createRequest = (
  overrides: Partial<AppointmentAvailabilityRequest> = {},
): AppointmentAvailabilityRequest => ({
  vehicle_id: 14,
  service_type_id: 2,
  showroom_id: 1,
  workshop_types: ["diagnostic"],
  preferred_date: MONDAY,
  preferred_period: "any",
  result_mode: "suggestions",
  ...overrides,
});

const createSnapshot = (
  overrides: Partial<DirectusBookingAvailabilitySnapshot> = {},
): DirectusBookingAvailabilitySnapshot => ({
  workshops: [createWorkshop(1)],
  schedules: [
    {
      workshop_id: 1,
      date: MONDAY,
      total_capacity_hours: 36,
      used_capacity_hours: 0,
      remaining_capacity_hours: 36,
    },
  ],
  resources: Array.from({ length: 4 }, () => ({
    workshop_id: 1,
    active: true,
    daily_hours: 9,
  })),
  appointments: [],
  ...overrides,
});

const fillSlot = (
  workshopId: number,
  count: number,
  status: string,
  date = MONDAY,
  time = "08:00:00",
): BookingAppointment[] =>
  Array.from({ length: count }, () => ({
    workshop_id: workshopId,
    requested_date: date,
    requested_time: time,
    status,
  }));

test("generates 30-minute working-day slots and returns at most three", () => {
  const result = findAppointmentAvailability(
    createRequest(),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.preferred_date_available, true);
  assert.deepEqual(
    result.options.map((option) => option.requested_time),
    ["08:00:00", "08:30:00", "09:00:00"],
  );
  assert.equal(result.options[0]?.showroom.name, "Showroom 1");
  assert.equal(result.options[0]?.slot_interval_minutes, 30);
});

test("never proposes an elapsed slot on the current Casablanca date", () => {
  const result = findAppointmentAvailability(
    createRequest(),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
    { date: MONDAY, time: "09:10:00" },
  );

  assert.equal(result.options[0]?.requested_time, "09:30:00");
});

test("requires an open working day, a schedule and enough daily capacity", () => {
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      createSnapshot({ schedules: [] }),
      MONDAY,
      WINDOW_END,
    ).options.length,
    0,
  );
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      createSnapshot({
        schedules: [
          {
            workshop_id: 1,
            date: MONDAY,
            total_capacity_hours: 36,
            used_capacity_hours: 35.75,
            remaining_capacity_hours: 0.25,
          },
        ],
      }),
      MONDAY,
      WINDOW_END,
    ).options.length,
    0,
  );
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      createSnapshot({
        workshops: [createWorkshop(1, { working_days: ["tuesday"] })],
      }),
      MONDAY,
      WINDOW_END,
    ).options.length,
    0,
  );
  for (const overrides of [
    { active: false },
    { client_bookable: false },
  ]) {
    assert.equal(
      findAppointmentAvailability(
        createRequest(),
        createSnapshot({ workshops: [createWorkshop(1, overrides)] }),
        MONDAY,
        WINDOW_END,
      ).options.length,
      0,
    );
  }
});

test("never returns an option from another showroom", () => {
  const foreignWorkshop = createWorkshop(2, {
    workshop_type: "mecanique",
    showroom: {
      id: 5,
      name: "Tanger",
      address: "Adresse test",
      city: "Tanger",
      phone: "0000000000",
    },
  });
  const result = findAppointmentAvailability(
    createRequest({ workshop_types: ["mecanique"] }),
    createSnapshot({
      workshops: [foreignWorkshop],
      schedules: [
        {
          workshop_id: 2,
          date: MONDAY,
          total_capacity_hours: 9,
          used_capacity_hours: 0,
          remaining_capacity_hours: 9,
        },
      ],
      resources: [{ workshop_id: 2, active: true, daily_hours: 9 }],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(result.options, []);
});

test("uses the dynamic active-resource count for simultaneous capacity", () => {
  const fourResources = createSnapshot({
    resources: [
      ...createSnapshot().resources,
      { workshop_id: 1, active: false, daily_hours: 9 },
    ],
    appointments: [
      ...fillSlot(1, 2, "pending"),
      ...fillSlot(1, 2, "confirmed"),
    ],
  });
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      fourResources,
      MONDAY,
      WINDOW_END,
    )
      .options[0]?.requested_time,
    "08:30:00",
  );

  const workshopThree = createSnapshot({
    workshops: [createWorkshop(3)],
    schedules: [
      {
        workshop_id: 3,
        date: MONDAY,
        total_capacity_hours: 27,
        used_capacity_hours: 0,
        remaining_capacity_hours: 27,
      },
    ],
    resources: Array.from({ length: 3 }, () => ({
      workshop_id: 3 as const,
      active: true,
      daily_hours: 9,
    })),
    appointments: fillSlot(3, 3, "pending"),
  });
  assert.equal(
    findAppointmentAvailability(
      createRequest({
        service_type_id: 4,
        showroom_id: 1,
        workshop_types: ["carrosserie"],
      }),
      workshopThree,
      MONDAY,
      WINDOW_END,
    ).options[0]?.requested_time,
    "08:30:00",
  );
});

test("pending and confirmed occupy while cancelled and completed do not", () => {
  const snapshot = createSnapshot({
    resources: [{ workshop_id: 1, active: true, daily_hours: 9 }],
    appointments: [
      ...fillSlot(1, 1, "cancelled"),
      ...fillSlot(1, 1, "completed"),
    ],
  });
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      snapshot,
      MONDAY,
      WINDOW_END,
    ).options[0]
      ?.requested_time,
    "08:00:00",
  );

  snapshot.appointments = fillSlot(1, 1, "confirmed");
  assert.equal(
    findAppointmentAvailability(
      createRequest(),
      snapshot,
      MONDAY,
      WINDOW_END,
    ).options[0]
      ?.requested_time,
    "08:30:00",
  );
});

test("falls forward when the preferred date is full", () => {
  const occupiedMonday = Array.from({ length: 18 }, (_, index) =>
    fillSlot(
      1,
      4,
      "pending",
      MONDAY,
      `${String(8 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}:00`,
    ),
  ).flat();
  const snapshot = createSnapshot({
    schedules: [
      ...createSnapshot().schedules,
      {
        workshop_id: 1,
        date: TUESDAY,
        total_capacity_hours: 36,
        used_capacity_hours: 0,
        remaining_capacity_hours: 36,
      },
    ],
    appointments: occupiedMonday,
  });

  const result = findAppointmentAvailability(
    createRequest(),
    snapshot,
    MONDAY,
    WINDOW_END,
  );
  assert.equal(result.preferred_date_available, false);
  assert.equal(result.options[0]?.requested_date, TUESDAY);
});

test("afternoon returns no morning slot and preserves requested type order", () => {
  const snapshot = createSnapshot({
    workshops: [createWorkshop(1), createWorkshop(2)],
    schedules: [
      ...createSnapshot().schedules,
      {
        workshop_id: 2,
        date: MONDAY,
        total_capacity_hours: 36,
        used_capacity_hours: 0,
        remaining_capacity_hours: 36,
      },
    ],
    resources: [
      { workshop_id: 1, active: true, daily_hours: 9 },
      { workshop_id: 2, active: true, daily_hours: 9 },
    ],
  });

  const result = findAppointmentAvailability(
    createRequest({
      workshop_types: ["mecanique", "diagnostic"],
      preferred_period: "afternoon",
    }),
    snapshot,
    MONDAY,
    WINDOW_END,
  );
  assert.ok(
    result.options.every((option) => option.requested_time >= "12:00:00"),
  );
  assert.equal(result.options[0]?.requested_time, "12:00:00");
  assert.equal(result.options[0]?.workshop_id, 2);
});

test("morning returns no afternoon slot", () => {
  const result = findAppointmentAvailability(
    createRequest({ preferred_period: "morning" }),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.options.length, 3);
  assert.ok(
    result.options.every((option) => option.requested_time < "12:00:00"),
  );
});

test("any allows both morning and afternoon slots", () => {
  const result = findAppointmentAvailability(
    createRequest({ preferred_period: "any" }),
    createSnapshot({
      workshops: [
        createWorkshop(1, {
          opening_time: "11:30:00",
          closing_time: "13:00:00",
        }),
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(
    result.options.map((option) => option.requested_time),
    ["11:30:00", "12:00:00", "12:30:00"],
  );
});

test("does not search alternatives after the global window end", () => {
  const result = findAppointmentAvailability(
    createRequest({ preferred_date: WINDOW_END }),
    createSnapshot({
      schedules: [
        {
          workshop_id: 1,
          date: AFTER_WINDOW,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
      ],
    }),
    WINDOW_END,
    WINDOW_END,
  );

  assert.equal(result.preferred_date_available, false);
  assert.deepEqual(result.options, []);
});

test("day-slots never returns an alternative date", () => {
  const result = findAppointmentAvailability(
    createRequest({ result_mode: "day_slots" }),
    createSnapshot({
      schedules: [
        {
          workshop_id: 1,
          date: TUESDAY,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.preferred_date_available, false);
  assert.deepEqual(result.options, []);
});

test("day-slots morning returns every morning slot", () => {
  const result = findAppointmentAvailability(
    createRequest({ result_mode: "day_slots", preferred_period: "morning" }),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.preferred_date_available, true);
  assert.equal(result.options.length, 8);
  assert.ok(
    result.options.every((option) => option.requested_time < "12:00:00"),
  );
});

test("day-slots afternoon returns every afternoon slot", () => {
  const result = findAppointmentAvailability(
    createRequest({
      result_mode: "day_slots",
      preferred_period: "afternoon",
    }),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.preferred_date_available, true);
  assert.equal(result.options.length, 10);
  assert.ok(
    result.options.every((option) => option.requested_time >= "12:00:00"),
  );
});

test("day-slots any returns every morning and afternoon slot", () => {
  const result = findAppointmentAvailability(
    createRequest({ result_mode: "day_slots", preferred_period: "any" }),
    createSnapshot(),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.options.length, 18);
  assert.ok(
    result.options.some((option) => option.requested_time < "12:00:00"),
  );
  assert.ok(
    result.options.some((option) => option.requested_time >= "12:00:00"),
  );
});

test("day-slots sorts by time and then by requested workshop type", () => {
  const result = findAppointmentAvailability(
    createRequest({
      result_mode: "day_slots",
      workshop_types: ["mecanique", "diagnostic"],
    }),
    createSnapshot({
      workshops: [
        createWorkshop(2, {
          opening_time: "08:00:00",
          closing_time: "09:00:00",
        }),
        createWorkshop(1, {
          opening_time: "08:00:00",
          closing_time: "09:00:00",
        }),
      ],
      schedules: [
        {
          workshop_id: 2,
          date: MONDAY,
          total_capacity_hours: 9,
          used_capacity_hours: 0,
          remaining_capacity_hours: 9,
        },
        {
          workshop_id: 1,
          date: MONDAY,
          total_capacity_hours: 9,
          used_capacity_hours: 0,
          remaining_capacity_hours: 9,
        },
      ],
      resources: [
        { workshop_id: 2, active: true, daily_hours: 9 },
        { workshop_id: 1, active: true, daily_hours: 9 },
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(
    result.options.map((option) => [
      option.requested_time,
      option.workshop_id,
    ]),
    [
      ["08:00:00", 2],
      ["08:00:00", 1],
      ["08:30:00", 2],
      ["08:30:00", 1],
    ],
  );
});

test("day-slots removes duplicate workshop, date and time options", () => {
  const workshop = createWorkshop(1, {
    opening_time: "08:00:00",
    closing_time: "09:00:00",
  });
  const result = findAppointmentAvailability(
    createRequest({ result_mode: "day_slots" }),
    createSnapshot({ workshops: [workshop, { ...workshop }] }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(
    result.options.map((option) => option.requested_time),
    ["08:00:00", "08:30:00"],
  );
});

test("day-slots applies the fixed limit of forty after sorting and deduplication", () => {
  const result = findAppointmentAvailability(
    createRequest({
      result_mode: "day_slots",
      workshop_types: ["mecanique", "diagnostic"],
    }),
    createSnapshot({
      workshops: [
        createWorkshop(2, { slot_interval_minutes: 15 }),
        createWorkshop(1, { slot_interval_minutes: 15 }),
      ],
      schedules: [
        {
          workshop_id: 2,
          date: MONDAY,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
        {
          workshop_id: 1,
          date: MONDAY,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
      ],
      resources: [
        { workshop_id: 2, active: true, daily_hours: 9 },
        { workshop_id: 1, active: true, daily_hours: 9 },
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.options.length, 40);
  assert.deepEqual(
    result.options.slice(0, 4).map((option) => [
      option.requested_time,
      option.workshop_id,
    ]),
    [
      ["08:00:00", 2],
      ["08:00:00", 1],
      ["08:15:00", 2],
      ["08:15:00", 1],
    ],
  );
});

test("calendar covers exactly thirty days and excludes Saturdays and Sundays", () => {
  const schedules = Array.from({ length: 30 }, (_, index) => ({
    workshop_id: 1,
    date: addIsoDateDays(MONDAY, index),
    total_capacity_hours: 36,
    used_capacity_hours: 0,
    remaining_capacity_hours: 36,
  }));
  const result = findAppointmentAvailabilityCalendar(
    createRequest({
      preferred_date: null,
      result_mode: "calendar",
    }),
    createSnapshot({
      workshops: [
        createWorkshop(1, {
          working_days: [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ],
        }),
      ],
      schedules,
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.equal(result.horizon_start, MONDAY);
  assert.equal(result.horizon_end, WINDOW_END);
  assert.equal(result.days.length, 22);
  assert.equal(result.days[0]?.date, MONDAY);
  assert.equal(result.days.at(-1)?.date, WINDOW_END);
  assert.ok(
    result.days.every(({ date }) => {
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    }),
  );
});

test("calendar excludes a full day and counts a partially available day by period", () => {
  const result = findAppointmentAvailabilityCalendar(
    createRequest({
      preferred_date: null,
      result_mode: "calendar",
    }),
    createSnapshot({
      schedules: [
        ...createSnapshot().schedules,
        {
          workshop_id: 1,
          date: TUESDAY,
          total_capacity_hours: 9,
          used_capacity_hours: 0,
          remaining_capacity_hours: 9,
        },
      ],
      resources: [{ workshop_id: 1, active: true, daily_hours: 9 }],
      appointments: [
        ...Array.from({ length: 18 }, (_, index) =>
          fillSlot(
            1,
            1,
            "pending",
            MONDAY,
            `${String(8 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}:00`,
          ),
        ).flat(),
        ...fillSlot(1, 1, "confirmed", TUESDAY, "08:00:00"),
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(result.days, [
    {
      date: TUESDAY,
      available_slot_count: 17,
      morning_slot_count: 7,
      afternoon_slot_count: 10,
    },
  ]);
});

test("calendar ignores the day-slots result limit and contains no slot token", () => {
  const result = findAppointmentAvailabilityCalendar(
    createRequest({
      preferred_date: null,
      preferred_period: "any",
      result_mode: "calendar",
      workshop_types: ["mecanique", "diagnostic"],
    }),
    createSnapshot({
      workshops: [
        createWorkshop(2, { slot_interval_minutes: 15 }),
        createWorkshop(1, { slot_interval_minutes: 15 }),
      ],
      schedules: [
        {
          workshop_id: 2,
          date: MONDAY,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
        {
          workshop_id: 1,
          date: MONDAY,
          total_capacity_hours: 36,
          used_capacity_hours: 0,
          remaining_capacity_hours: 36,
        },
      ],
      resources: [
        { workshop_id: 2, active: true, daily_hours: 9 },
        { workshop_id: 1, active: true, daily_hours: 9 },
      ],
    }),
    MONDAY,
    WINDOW_END,
  );

  assert.deepEqual(result.days, [
    {
      date: MONDAY,
      available_slot_count: 72,
      morning_slot_count: 32,
      afternoon_slot_count: 40,
    },
  ]);
  assert.equal(JSON.stringify(result).includes("slot_token"), false);
});

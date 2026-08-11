import assert from "node:assert/strict";
import test from "node:test";

import type { AppointmentAvailabilityRequest } from "./ai-booking.schema.js";
import {
  findAppointmentAvailability,
  type BookingAppointment,
  type BookingWorkshop,
  type DirectusBookingAvailabilitySnapshot,
} from "./ai-booking.availability.js";

const MONDAY = "2026-08-10";
const TUESDAY = "2026-08-11";
const WINDOW_END = "2026-09-08";
const AFTER_WINDOW = "2026-09-09";

const createWorkshop = (
  id: 1 | 2 | 3 | 4,
  overrides: Partial<BookingWorkshop> = {},
): BookingWorkshop => ({
  id,
  name: `Atelier ${id}`,
  opening_time: "08:00:00",
  closing_time: "17:00:00",
  working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  slot_interval_minutes: 30,
  active: true,
  client_bookable: true,
  showroom: {
    id,
    name: `Showroom ${id}`,
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
  workshop_ids: [1],
  preferred_date: MONDAY,
  preferred_period: "any",
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
    workshop_id: 1 as const,
    active: true,
    daily_hours: 9,
  })),
  appointments: [],
  ...overrides,
});

const fillSlot = (
  workshopId: 1 | 2 | 3 | 4,
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
      createRequest({ service_type_id: 4, workshop_ids: [3] }),
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

test("afternoon returns no morning slot and preserves client workshop order", () => {
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
      workshop_ids: [2, 1],
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

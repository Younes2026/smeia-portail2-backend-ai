import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "./ai-booking.availability.js";
import { checkBookingSlotAvailability } from "./ai-booking.confirmation.js";

const selection = {
  workshop_id: 20,
  showroom_id: 8,
  requested_date: "2026-08-12",
  requested_time: "08:00:00",
  slot_interval_minutes: 30,
};

const createSnapshot = (): DirectusBookingAvailabilitySnapshot => ({
  workshops: [
    {
      id: 20,
      name: "Atelier Oujda",
      workshop_type: "mecanique",
      opening_time: "08:00:00",
      closing_time: "17:00:00",
      working_days: ["wednesday"],
      slot_interval_minutes: 30,
      active: true,
      client_bookable: true,
      showroom: {
        id: 8,
        name: "Oujda",
        address: "Adresse test",
        city: "Casablanca",
        phone: "0000000000",
      },
    },
  ],
  schedules: [
    {
      workshop_id: 20,
      date: "2026-08-12",
      total_capacity_hours: 9,
      used_capacity_hours: 0,
      remaining_capacity_hours: 9,
    },
  ],
  resources: [{ workshop_id: 20, active: true, daily_hours: 9 }],
  appointments: [],
});

const check = (snapshot: DirectusBookingAvailabilitySnapshot) =>
  checkBookingSlotAvailability(selection, snapshot, {
    date: "2026-08-10",
    time: "12:00:00",
  });

test("accepts an exact still-available booking slot", () => {
  const result = check(createSnapshot());
  assert.equal(result.status, "available");
  assert.equal(result.status === "available" && result.workshop.id, 20);
});

test("rejects a showroom different from the signed selection", () => {
  const snapshot = createSnapshot();
  snapshot.workshops[0]!.showroom = {
    ...snapshot.workshops[0]!.showroom,
    id: 5,
  };
  assert.equal(check(snapshot).status, "invalid_context");
});

test("rejects an inactive, unbookable or interval-mismatched workshop context", () => {
  for (const workshopOverride of [
    { active: false },
    { client_bookable: false },
    { slot_interval_minutes: 60 },
  ]) {
    const snapshot = createSnapshot();
    snapshot.workshops[0] = {
      ...snapshot.workshops[0]!,
      ...workshopOverride,
    };
    assert.equal(check(snapshot).status, "invalid_context");
  }
});

test("rejects a closed date, absent schedule and insufficient daily capacity", () => {
  const closed = createSnapshot();
  closed.workshops[0]!.working_days = ["monday"];
  assert.equal(check(closed).status, "unavailable");

  const noSchedule = createSnapshot();
  noSchedule.schedules = [];
  assert.equal(check(noSchedule).status, "unavailable");

  const insufficient = createSnapshot();
  insufficient.schedules[0]!.remaining_capacity_hours = 0.25;
  assert.equal(check(insufficient).status, "unavailable");
});

test("rejects a slot with no active resource or full simultaneous capacity", () => {
  const noResource = createSnapshot();
  noResource.resources = [];
  assert.equal(check(noResource).status, "unavailable");

  const full = createSnapshot();
  full.appointments = [
    {
      workshop_id: 20,
      requested_date: selection.requested_date,
      requested_time: selection.requested_time,
      status: "pending",
    },
  ];
  assert.equal(check(full).status, "unavailable");
});

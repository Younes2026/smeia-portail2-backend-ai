import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import { createDirectusBookingAvailabilityService } from "./directus-booking-availability.service.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const TECHNICAL_TOKEN = "unit-test-booking-token-placeholder";

const createHarness = (invalidWorkshops = false) => {
  const calls: Array<{
    endpoint: string;
    params: URLSearchParams;
    accessToken: string;
  }> = [];
  const client: DirectusReadClient = {
    async getJson(endpoint, params, accessToken) {
      calls.push({
        endpoint,
        params: new URLSearchParams(params),
        accessToken,
      });

      if (endpoint === "/items/workshops") {
        return invalidWorkshops
          ? { data: [{ id: 1, token: TECHNICAL_TOKEN }] }
          : {
              data: [
                {
                  id: 1,
                  name: "Atelier Rapide",
                  opening_time: "08:00",
                  closing_time: "17:00:00",
                  working_days: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                  ],
                  slot_interval_minutes: 30,
                  active: true,
                  client_bookable: true,
                  showroom_id: {
                    id: 1,
                    name: "Moulay Slimane",
                    address: "Adresse test",
                    city: "Casablanca",
                    phone: "0000000000",
                  },
                },
              ],
            };
      }

      if (endpoint === "/items/schedules") {
        return {
          data: [
            {
              workshop_id: 1,
              date: "2026-08-12",
              total_capacity_hours: "36.0",
              used_capacity_hours: 1,
              remaining_capacity_hours: "35",
            },
          ],
        };
      }

      if (endpoint === "/items/resources") {
        return {
          data: [
            { workshop_id: { id: 1 }, active: true, daily_hours: 9 },
          ],
        };
      }

      if (endpoint === "/items/appointments") {
        return {
          data: [
            {
              workshop_id: 1,
              requested_date: "2026-08-12",
              requested_time: "09:30",
              status: "pending",
            },
          ],
        };
      }

      throw new Error("Unexpected test endpoint.");
    },
  };

  return {
    calls,
    service: createDirectusBookingAvailabilityService(client),
  };
};

test("reads only the four approved collections with minimal fields", async () => {
  const harness = createHarness();
  const result = await harness.service.getBookingAvailabilitySnapshot(
    TECHNICAL_TOKEN,
    {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-08-13",
    },
  );

  assert.deepEqual(
    harness.calls.map((call) => call.endpoint).sort(),
    [
      "/items/appointments",
      "/items/resources",
      "/items/schedules",
      "/items/workshops",
    ],
  );
  assert.ok(
    harness.calls.every((call) => call.accessToken === TECHNICAL_TOKEN),
  );
  const fieldsByEndpoint = new Map(
    harness.calls.map((call) => [
      call.endpoint,
      call.params.get("fields"),
    ]),
  );
  assert.equal(
    fieldsByEndpoint.get("/items/appointments"),
    "workshop_id,requested_date,requested_time,status",
  );
  assert.equal(
    fieldsByEndpoint.get("/items/resources"),
    "workshop_id,active,daily_hours",
  );
  assert.equal(
    fieldsByEndpoint.get("/items/schedules"),
    "workshop_id,date,total_capacity_hours,used_capacity_hours,remaining_capacity_hours",
  );
  assert.equal(
    fieldsByEndpoint.get("/items/workshops"),
    "id,name,opening_time,closing_time,working_days,slot_interval_minutes,active,client_bookable,showroom_id.id,showroom_id.name,showroom_id.address,showroom_id.city,showroom_id.phone",
  );
  const serializedQueries = harness.calls
    .map((call) => call.params.toString())
    .join("&");
  for (const forbidden of [
    "customer",
    "vehicle",
    "vin",
    "registration",
    TECHNICAL_TOKEN,
  ]) {
    assert.equal(serializedQueries.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.equal(result.workshops[0]?.showroom.name, "Moulay Slimane");
  assert.equal(result.workshops[0]?.opening_time, "08:00:00");
  assert.equal(result.appointments[0]?.requested_time, "09:30:00");
});

test("limits schedule and appointment reads to the requested date range", async () => {
  const harness = createHarness();
  await harness.service.getBookingAvailabilitySnapshot(TECHNICAL_TOKEN, {
    workshopIds: [1],
    startDate: "2026-08-12",
    endDate: "2026-08-13",
  });

  for (const endpoint of ["/items/schedules", "/items/appointments"]) {
    const call = harness.calls.find((candidate) => candidate.endpoint === endpoint);
    assert.equal(call?.params.get("filter[requested_date][_gte]") ?? call?.params.get("filter[date][_gte]"), "2026-08-12");
    assert.equal(call?.params.get("filter[requested_date][_lte]") ?? call?.params.get("filter[date][_lte]"), "2026-08-13");
  }
  const appointmentCall = harness.calls.find(
    (call) => call.endpoint === "/items/appointments",
  );
  assert.equal(
    appointmentCall?.params.get("filter[status][_in]"),
    "pending,confirmed",
  );
});

test("rejects malformed Directus data without exposing the technical token", async () => {
  const harness = createHarness(true);
  await assert.rejects(
    harness.service.getBookingAvailabilitySnapshot(TECHNICAL_TOKEN, {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-08-13",
    }),
    (error: unknown) => {
      assert.ok(error instanceof DirectusError);
      assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
      assert.equal(error.message.includes(TECHNICAL_TOKEN), false);
      return true;
    },
  );
});

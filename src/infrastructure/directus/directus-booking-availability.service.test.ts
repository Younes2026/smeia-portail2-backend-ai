import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError, type DirectusErrorCode } from "./directus-errors.js";
import {
  createDirectusBookingAvailabilityService,
  type DirectusWorkshopResolutionQuery,
} from "./directus-booking-availability.service.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const TECHNICAL_TOKEN = "unit-test-booking-token-placeholder";
const RESOLVED_WORKSHOP_FIELDS =
  "id,name,workshop_type,opening_time,closing_time,working_days,slot_interval_minutes,active,client_bookable,showroom_id.id,showroom_id.name,showroom_id.address,showroom_id.city,showroom_id.phone";
const SYNTHETIC_DIAGNOSTIC_WORKSHOP_ID = Number.MAX_SAFE_INTEGER;

const createHarness = (invalidWorkshops = false, showroomId = 8) => {
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
          ? { data: [{ id: 20, token: TECHNICAL_TOKEN }] }
          : {
              data: [
                {
                  id: 20,
                  name: "Atelier Oujda",
                  workshop_type: "mecanique",
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
                    id: showroomId,
                    name: "Oujda",
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
              workshop_id: 20,
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
            { workshop_id: { id: 20 }, active: true, daily_hours: 9 },
          ],
        };
      }

      if (endpoint === "/items/appointments") {
        return {
          data: [
            {
              workshop_id: 20,
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

type ResolverWorkshopOptions = {
  id: number;
  workshopType: string;
  showroomId: number;
  active?: boolean;
  clientBookable?: boolean;
};

const createResolverWorkshop = ({
  id,
  workshopType,
  showroomId,
  active = true,
  clientBookable = true,
}: ResolverWorkshopOptions) => ({
  id,
  name: `Atelier ${id}`,
  workshop_type: workshopType,
  opening_time: "08:00",
  closing_time: "17:00:00",
  working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  slot_interval_minutes: 30,
  active,
  client_bookable: clientBookable,
  showroom_id: {
    id: showroomId,
    name: showroomId === 8 ? "Oujda" : showroomId === 5 ? "Tanger" : "Test",
    address: "Adresse test",
    city: showroomId === 8 ? "Oujda" : showroomId === 5 ? "Tanger" : "Test",
    phone: "0000000000",
  },
});

const createResolverHarness = (workshopsPayload: unknown) => {
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
      return workshopsPayload;
    },
  };

  return {
    calls,
    service: createDirectusBookingAvailabilityService(client),
  };
};

const assertDirectusError = async (
  operation: Promise<unknown>,
  expectedCode: DirectusErrorCode,
) => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof DirectusError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TECHNICAL_TOKEN), false);
    return true;
  });
};

test("resolves Oujda mecanique to physical workshop 20 with one minimal GET", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 20,
        workshopType: "mecanique",
        showroomId: 8,
      }),
    ],
  });

  const result = await harness.service.resolveBookingWorkshops(
    TECHNICAL_TOKEN,
    { showroomId: 8, workshopTypes: ["mecanique"] },
  );

  assert.deepEqual(result, [
    {
      id: 20,
      name: "Atelier 20",
      workshop_type: "mecanique",
      opening_time: "08:00:00",
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
      showroom: {
        id: 8,
        name: "Oujda",
        address: "Adresse test",
        city: "Oujda",
        phone: "0000000000",
      },
    },
  ]);
  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.ok(call);
  assert.equal(call.endpoint, "/items/workshops");
  assert.equal(call.accessToken, TECHNICAL_TOKEN);
  assert.equal(call.params.get("fields"), RESOLVED_WORKSHOP_FIELDS);
  assert.equal(call.params.get("filter[showroom_id][_eq]"), "8");
  assert.equal(call.params.get("filter[workshop_type][_in]"), "mecanique");
  assert.equal(call.params.get("filter[active][_eq]"), "true");
  assert.equal(call.params.get("filter[client_bookable][_eq]"), "true");
  assert.equal(call.params.get("limit"), "2");
  assert.equal(call.params.toString().includes(TECHNICAL_TOKEN), false);
});

test("resolves Tanger carrosserie to physical workshop 24", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 24,
        workshopType: "carrosserie",
        showroomId: 5,
      }),
    ],
  });

  const result = await harness.service.resolveBookingWorkshops(
    TECHNICAL_TOKEN,
    { showroomId: 5, workshopTypes: ["carrosserie"] },
  );

  assert.equal(result[0]?.id, 24);
  assert.equal(result[0]?.workshop_type, "carrosserie");
  assert.equal(result[0]?.showroom.id, 5);
});

test("preserves requested type order independently from Directus row order", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 20,
        workshopType: "mecanique",
        showroomId: 8,
      }),
      createResolverWorkshop({
        id: SYNTHETIC_DIAGNOSTIC_WORKSHOP_ID,
        workshopType: "diagnostic",
        showroomId: 8,
      }),
    ],
  });

  const result = await harness.service.resolveBookingWorkshops(
    TECHNICAL_TOKEN,
    { showroomId: 8, workshopTypes: ["diagnostic", "mecanique"] },
  );

  assert.deepEqual(
    result.map((workshop) => workshop.workshop_type),
    ["diagnostic", "mecanique"],
  );
  assert.deepEqual(
    result.map((workshop) => workshop.id),
    [SYNTHETIC_DIAGNOSTIC_WORKSHOP_ID, 20],
  );
  assert.equal(harness.calls[0]?.params.get("limit"), "3");
});

test("rejects invalid internal resolution inputs before Directus", async () => {
  const invalidQueries: unknown[] = [
    { showroomId: 0, workshopTypes: ["mecanique"] },
    { showroomId: Number.MAX_SAFE_INTEGER + 1, workshopTypes: ["mecanique"] },
    { showroomId: 8, workshopTypes: [] },
    {
      showroomId: 8,
      workshopTypes: ["diagnostic", "mecanique", "peinture"],
    },
    { showroomId: 8, workshopTypes: ["mecanique", "mecanique"] },
    { showroomId: 8, workshopTypes: ["electricite"] },
    { showroomId: 8, workshopTypes: ["mecanique"], unexpected: true },
  ];

  for (const invalidQuery of invalidQueries) {
    const harness = createResolverHarness({ data: [] });
    await assertDirectusError(
      harness.service.resolveBookingWorkshops(
        TECHNICAL_TOKEN,
        invalidQuery as DirectusWorkshopResolutionQuery,
      ),
      "DIRECTUS_INVALID_RESPONSE",
    );
    assert.equal(harness.calls.length, 0);
  }
});

test("returns a controlled not-found error for a site without matching workshops", async () => {
  const harness = createResolverHarness({ data: [] });

  await assertDirectusError(
    harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
      showroomId: 8,
      workshopTypes: ["mecanique"],
    }),
    "DIRECTUS_NOT_FOUND",
  );
  assert.equal(harness.calls.length, 1);
});

test("rejects a missing requested workshop type", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 20,
        workshopType: "mecanique",
        showroomId: 8,
      }),
    ],
  });

  await assertDirectusError(
    harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
      showroomId: 8,
      workshopTypes: ["diagnostic", "mecanique"],
    }),
    "DIRECTUS_NOT_FOUND",
  );
});

test("rejects duplicate workshops for the same site and type", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 20,
        workshopType: "mecanique",
        showroomId: 8,
      }),
      createResolverWorkshop({
        id: SYNTHETIC_DIAGNOSTIC_WORKSHOP_ID,
        workshopType: "mecanique",
        showroomId: 8,
      }),
    ],
  });

  await assertDirectusError(
    harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
      showroomId: 8,
      workshopTypes: ["mecanique"],
    }),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects a workshop returned for another showroom", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 24,
        workshopType: "carrosserie",
        showroomId: 5,
      }),
    ],
  });

  await assertDirectusError(
    harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
      showroomId: 8,
      workshopTypes: ["carrosserie"],
    }),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects inactive and non-bookable workshops", async () => {
  for (const workshop of [
    createResolverWorkshop({
      id: 20,
      workshopType: "mecanique",
      showroomId: 8,
      active: false,
    }),
    createResolverWorkshop({
      id: 20,
      workshopType: "mecanique",
      showroomId: 8,
      clientBookable: false,
    }),
  ]) {
    const harness = createResolverHarness({ data: [workshop] });
    await assertDirectusError(
      harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
        showroomId: 8,
        workshopTypes: ["mecanique"],
      }),
      "DIRECTUS_INVALID_RESPONSE",
    );
  }
});

test("rejects an unknown Directus workshop type", async () => {
  const harness = createResolverHarness({
    data: [
      createResolverWorkshop({
        id: 20,
        workshopType: "electricite",
        showroomId: 8,
      }),
    ],
  });

  await assertDirectusError(
    harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
      showroomId: 8,
      workshopTypes: ["mecanique"],
    }),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects incomplete responses and unexpected Directus fields", async () => {
  const validWorkshop = createResolverWorkshop({
    id: 20,
    workshopType: "mecanique",
    showroomId: 8,
  });
  const { name: _name, ...incompleteWorkshop } = validWorkshop;

  for (const workshop of [
    incompleteWorkshop,
    { ...validWorkshop, unexpected: "raw-directus-data" },
  ]) {
    const harness = createResolverHarness({ data: [workshop] });
    await assertDirectusError(
      harness.service.resolveBookingWorkshops(TECHNICAL_TOKEN, {
        showroomId: 8,
        workshopTypes: ["mecanique"],
      }),
      "DIRECTUS_INVALID_RESPONSE",
    );
  }
});

test("reads only the four approved collections with minimal fields", async () => {
  const harness = createHarness();
  const result = await harness.service.getBookingAvailabilitySnapshot(
    TECHNICAL_TOKEN,
    {
      workshopIds: [20],
      showroomId: 8,
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
    "id,name,workshop_type,opening_time,closing_time,working_days,slot_interval_minutes,active,client_bookable,showroom_id.id,showroom_id.name,showroom_id.address,showroom_id.city,showroom_id.phone",
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
  const workshopCall = harness.calls.find(
    (call) => call.endpoint === "/items/workshops",
  );
  assert.equal(workshopCall?.params.get("filter[showroom_id][_eq]"), "8");
  assert.equal(workshopCall?.params.get("limit"), "2");
  assert.equal(result.workshops[0]?.id, 20);
  assert.equal(result.workshops[0]?.workshop_type, "mecanique");
  assert.equal(result.workshops[0]?.showroom.name, "Oujda");
  assert.equal(result.workshops[0]?.opening_time, "08:00:00");
  assert.equal(result.appointments[0]?.requested_time, "09:30:00");
});

test("limits schedule and appointment reads to the requested date range", async () => {
  const harness = createHarness();
  await harness.service.getBookingAvailabilitySnapshot(TECHNICAL_TOKEN, {
    workshopIds: [20],
    showroomId: 8,
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

test("rejects a snapshot workshop returned for another showroom", async () => {
  const harness = createHarness(false, 5);

  await assertDirectusError(
    harness.service.getBookingAvailabilitySnapshot(TECHNICAL_TOKEN, {
      workshopIds: [20],
      showroomId: 8,
      startDate: "2026-08-12",
      endDate: "2026-08-13",
    }),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects malformed Directus data without exposing the technical token", async () => {
  const harness = createHarness(true);
  await assert.rejects(
    harness.service.getBookingAvailabilitySnapshot(TECHNICAL_TOKEN, {
      workshopIds: [20],
      showroomId: 8,
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

import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import { createDirectusCatalogService } from "./directus-catalog.service.js";
import {
  createDirectusHttpClient,
  type DirectusFetch,
} from "./directus-http-client.js";

const FAKE_ACCESS_TOKEN = "unit-test-directus-token-placeholder";

const validServices = [
  { id: 8, name: "Service huit", code: "S8" },
  { id: 2, name: "Service deux", code: "S2" },
  { id: 7, name: "Service sept", code: "S7" },
  { id: 3, name: "Service trois", code: "S3" },
  { id: 6, name: "Service six", code: "S6" },
  { id: 4, name: "Service quatre", code: "S4" },
  { id: 5, name: "Service cinq", code: "S5" },
];

const validWorkshops = [
  {
    id: 4,
    name: "Atelier quatre",
    workshop_type: "type-quatre",
    active: true,
    client_bookable: true,
  },
  {
    id: 1,
    name: "Atelier un",
    workshop_type: "type-un",
    active: true,
    client_bookable: true,
  },
  {
    id: 3,
    name: "Atelier trois",
    workshop_type: "type-trois",
    active: true,
    client_bookable: true,
  },
  {
    id: 2,
    name: "Atelier deux",
    workshop_type: "type-deux",
    active: true,
    client_bookable: true,
  },
];

type CatalogHarnessOptions = {
  servicesPayload?: unknown;
  workshopsPayload?: unknown;
};

const createCatalogHarness = (options: CatalogHarnessOptions = {}) => {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImplementation: DirectusFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });

    if (url.pathname === "/api/items/service_types") {
      return new Response(
        JSON.stringify(options.servicesPayload ?? { data: validServices }),
        { status: 200 },
      );
    }

    if (url.pathname === "/api/items/workshops") {
      return new Response(
        JSON.stringify(options.workshopsPayload ?? { data: validWorkshops }),
        { status: 200 },
      );
    }

    return new Response(null, { status: 404 });
  };
  const client = createDirectusHttpClient({
    baseUrl: "https://directus.example.test/api",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  return {
    calls,
    service: createDirectusCatalogService(client),
  };
};

const expectInvalidCatalog = async (promise: Promise<unknown>) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DirectusError);
    assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
    assert.equal(error.message.includes(FAKE_ACCESS_TOKEN), false);
    return true;
  });
};

test("requests the service_types endpoint with limited fields and filters", async () => {
  const harness = createCatalogHarness();

  await harness.service.getAvailableServices(FAKE_ACCESS_TOKEN);

  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.ok(call);
  assert.equal(call.url.pathname, "/api/items/service_types");
  assert.equal(call.url.searchParams.get("fields"), "id,name,code");
  assert.equal(call.url.searchParams.get("filter[id][_in]"), "2,3,4,5,6,7,8");
  assert.equal(call.url.searchParams.get("sort"), "id");
  assert.equal(call.url.searchParams.get("limit"), "7");
  assert.equal(call.init?.method, "GET");
});

test("requests workshops with active and bookable filters", async () => {
  const harness = createCatalogHarness();

  await harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN);

  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.ok(call);
  assert.equal(call.url.pathname, "/api/items/workshops");
  assert.equal(
    call.url.searchParams.get("fields"),
    "id,name,workshop_type,active,client_bookable",
  );
  assert.equal(call.url.searchParams.get("filter[id][_in]"), "1,2,3,4");
  assert.equal(call.url.searchParams.get("filter[active][_eq]"), "true");
  assert.equal(
    call.url.searchParams.get("filter[client_bookable][_eq]"),
    "true",
  );
  assert.equal(call.url.searchParams.get("sort"), "id");
  assert.equal(call.url.searchParams.get("limit"), "4");
});

test("returns both complete catalogs sorted by ID", async () => {
  const harness = createCatalogHarness();

  const result = await harness.service.getAiCatalogs(FAKE_ACCESS_TOKEN);

  assert.deepEqual(
    result.available_services.map((service) => service.id),
    [2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    result.available_workshops.map((workshop) => workshop.id),
    [1, 2, 3, 4],
  );
  assert.equal(result.available_services[0]?.name, "Service deux");
});

test("returns exactly the AI catalog contract without workshop flags", async () => {
  const harness = createCatalogHarness();

  const result = await harness.service.getAiCatalogs(FAKE_ACCESS_TOKEN);

  assert.deepEqual(Object.keys(result).sort(), [
    "available_services",
    "available_workshops",
  ]);
  assert.deepEqual(Object.keys(result.available_services[0] ?? {}).sort(), [
    "code",
    "id",
    "name",
  ]);
  assert.deepEqual(Object.keys(result.available_workshops[0] ?? {}).sort(), [
    "id",
    "name",
    "workshop_type",
  ]);
});

test("rejects an unknown service ID", async () => {
  const services = validServices.map((service) => ({ ...service }));
  services[0] = { id: 9, name: "Unknown", code: "UNKNOWN" };
  const harness = createCatalogHarness({ servicesPayload: { data: services } });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

test("rejects an unknown workshop ID", async () => {
  const workshops = validWorkshops.map((workshop) => ({ ...workshop }));
  workshops[0] = { ...workshops[0]!, id: 5 };
  const harness = createCatalogHarness({ workshopsPayload: { data: workshops } });

  await expectInvalidCatalog(
    harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN),
  );
});

test("rejects duplicate service IDs", async () => {
  const services = validServices.map((service) => ({ ...service }));
  services[0] = { ...services[0]!, id: 2 };
  const harness = createCatalogHarness({ servicesPayload: { data: services } });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

test("rejects duplicate workshop IDs", async () => {
  const workshops = validWorkshops.map((workshop) => ({ ...workshop }));
  workshops[0] = { ...workshops[0]!, id: 1 };
  const harness = createCatalogHarness({ workshopsPayload: { data: workshops } });

  await expectInvalidCatalog(
    harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN),
  );
});

test("rejects an incomplete service catalog", async () => {
  const harness = createCatalogHarness({
    servicesPayload: { data: validServices.slice(0, -1) },
  });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

test("rejects an incomplete workshop catalog", async () => {
  const harness = createCatalogHarness({
    workshopsPayload: { data: validWorkshops.slice(0, -1) },
  });

  await expectInvalidCatalog(
    harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN),
  );
});

test("rejects an empty catalog", async () => {
  const harness = createCatalogHarness({ servicesPayload: { data: [] } });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

test("rejects an inactive workshop", async () => {
  const workshops = validWorkshops.map((workshop) => ({ ...workshop }));
  workshops[0] = { ...workshops[0]!, active: false };
  const harness = createCatalogHarness({ workshopsPayload: { data: workshops } });

  await expectInvalidCatalog(
    harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN),
  );
});

test("rejects a workshop that is not client bookable", async () => {
  const workshops = validWorkshops.map((workshop) => ({ ...workshop }));
  workshops[0] = { ...workshops[0]!, client_bookable: false };
  const harness = createCatalogHarness({ workshopsPayload: { data: workshops } });

  await expectInvalidCatalog(
    harness.service.getAvailableWorkshops(FAKE_ACCESS_TOKEN),
  );
});

test("rejects a response without data", async () => {
  const harness = createCatalogHarness({ servicesPayload: {} });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

test("rejects invalid, missing, and additional item fields", async () => {
  const services = validServices.map((service) => ({ ...service }));
  const invalidItem = { id: 8, name: "", extra: "not allowed" };
  const harness = createCatalogHarness({
    servicesPayload: { data: [invalidItem, ...services.slice(1)] },
  });

  await expectInvalidCatalog(
    harness.service.getAvailableServices(FAKE_ACCESS_TOKEN),
  );
});

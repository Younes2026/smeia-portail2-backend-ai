process.env.DOTENV_CONFIG_QUIET = "true";

const [{ DirectusError, getDirectusAiCatalogs }] = await Promise.all([
  import("../src/infrastructure/directus/index.js"),
]);

const expectedServiceIds = [2, 3, 4, 5, 6, 7, 8] as const;
const expectedWorkshopIds = [1, 2, 3, 4] as const;

const hasExactIds = (
  actualIds: readonly number[],
  expectedIds: readonly number[],
) =>
  actualIds.length === expectedIds.length &&
  actualIds.every((id, index) => id === expectedIds[index]);

const main = async () => {
  const accessToken = process.env.DIRECTUS_TEST_TOKEN?.trim();
  if (accessToken === undefined || accessToken.length === 0) {
    throw new Error("DIRECTUS_TEST_TOKEN_MISSING");
  }

  const catalogs = await getDirectusAiCatalogs(accessToken);

  if (
    !hasExactIds(
      catalogs.available_services.map((service) => service.id),
      expectedServiceIds,
    ) ||
    !hasExactIds(
      catalogs.available_workshops.map((workshop) => workshop.id),
      expectedWorkshopIds,
    ) ||
    catalogs.available_services.some(
      (service) =>
        service.name.trim().length === 0 || service.code.trim().length === 0,
    ) ||
    catalogs.available_workshops.some(
      (workshop) =>
        workshop.name.trim().length === 0 ||
        workshop.workshop_type.trim().length === 0,
    )
  ) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }

  console.log(JSON.stringify(catalogs, null, 2));
};

try {
  await main();
} catch (error: unknown) {
  const errorCode =
    error instanceof DirectusError
      ? error.code
      : error instanceof Error && error.message === "DIRECTUS_TEST_TOKEN_MISSING"
        ? "DIRECTUS_TEST_TOKEN_MISSING"
        : "DIRECTUS_ERROR";

  console.error(JSON.stringify({ error_code: errorCode }));
  process.exitCode = 1;
}

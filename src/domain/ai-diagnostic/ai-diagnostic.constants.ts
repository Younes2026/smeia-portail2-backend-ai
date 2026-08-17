export const ALLOWED_SERVICE_TYPE_IDS = [2, 3, 4, 5, 6, 7, 8] as const;

// Physical IDs remain the contract of the current booking flow.
export const ALLOWED_WORKSHOP_IDS = [1, 2, 3, 4] as const;

// Diagnostic recommendations are site-independent logical types.
export const ALLOWED_WORKSHOP_TYPES = [
  "diagnostic",
  "mecanique",
  "carrosserie",
  "peinture",
] as const;

export type AiDiagnosticWorkshopType =
  (typeof ALLOWED_WORKSHOP_TYPES)[number];

const compatibleWorkshopIdsByServiceCode = new Map<
  string,
  ReadonlySet<number>
>([
  ["MEC-DIAG B", new Set([1, 2])],
  ["CAR", new Set([3])],
  ["PEINT", new Set([4])],
]);

export const getCompatibleWorkshopIdsForServiceCode = (serviceCode: string) =>
  compatibleWorkshopIdsByServiceCode.get(serviceCode) ?? null;

const compatibleWorkshopTypesByServiceCode = new Map<
  string,
  ReadonlySet<AiDiagnosticWorkshopType>
>([
  ["MEC-DIAG B", new Set(["diagnostic", "mecanique"])],
  ["CAR", new Set(["carrosserie"])],
  ["PEINT", new Set(["peinture"])],
]);

export const getCompatibleWorkshopTypesForServiceCode = (
  serviceCode: string,
) => compatibleWorkshopTypesByServiceCode.get(serviceCode) ?? null;

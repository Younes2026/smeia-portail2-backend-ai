export const ALLOWED_SERVICE_TYPE_IDS = [2, 3, 4, 5, 6, 7, 8] as const;

export const ALLOWED_WORKSHOP_IDS = [1, 2, 3, 4] as const;

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

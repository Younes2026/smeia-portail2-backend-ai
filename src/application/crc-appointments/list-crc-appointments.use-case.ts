import {
  CrcAppointmentListQuerySchema,
  type CrcAppointment,
  type CrcAppointmentListQuery,
} from "../../domain/crc-appointments/index.js";
import { listDirectusCrcAppointments } from "../../infrastructure/directus/index.js";

export type ListCrcAppointmentsUseCaseDependencies = {
  listAppointments(
    accessToken: string,
    query: CrcAppointmentListQuery,
  ): Promise<CrcAppointment[]>;
};

export type ListCrcAppointmentsUseCase = (
  accessToken: string,
  query: unknown,
) => Promise<CrcAppointment[]>;

export const createListCrcAppointmentsUseCase = (
  dependencies: ListCrcAppointmentsUseCaseDependencies,
): ListCrcAppointmentsUseCase =>
  async (accessToken, rawQuery) => {
    const query = CrcAppointmentListQuerySchema.parse(rawQuery);
    return dependencies.listAppointments(accessToken, query);
  };

export const listCrcAppointmentsUseCase =
  createListCrcAppointmentsUseCase({
    listAppointments: listDirectusCrcAppointments,
  });

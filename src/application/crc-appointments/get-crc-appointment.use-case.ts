import {
  CrcAppointmentIdParameterSchema,
  type CrcAppointment,
} from "../../domain/crc-appointments/index.js";
import { getDirectusCrcAppointment } from "../../infrastructure/directus/index.js";

export type GetCrcAppointmentUseCaseDependencies = {
  getAppointment(
    accessToken: string,
    appointmentId: number,
  ): Promise<CrcAppointment | null>;
};

export type GetCrcAppointmentUseCase = (
  accessToken: string,
  appointmentId: unknown,
) => Promise<CrcAppointment | null>;

export const createGetCrcAppointmentUseCase = (
  dependencies: GetCrcAppointmentUseCaseDependencies,
): GetCrcAppointmentUseCase =>
  async (accessToken, rawAppointmentId) => {
    const appointmentId = CrcAppointmentIdParameterSchema.parse(
      rawAppointmentId,
    );
    return dependencies.getAppointment(accessToken, appointmentId);
  };

export const getCrcAppointmentUseCase = createGetCrcAppointmentUseCase({
  getAppointment: getDirectusCrcAppointment,
});

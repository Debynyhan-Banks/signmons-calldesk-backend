import { BadRequestException, Injectable } from "@nestjs/common";

export enum TransactionalMessageTemplateKey {
  APPOINTMENT_CONFIRMED = "APPOINTMENT_CONFIRMED",
  APPOINTMENT_RESCHEDULED = "APPOINTMENT_RESCHEDULED",
  APPOINTMENT_CANCELLED = "APPOINTMENT_CANCELLED",
  TECHNICIAN_ON_THE_WAY = "TECHNICIAN_ON_THE_WAY",
}

export interface TransactionalMessageTemplateContext {
  contractorName: string;
  appointmentTime?: Date | null;
  timeZone: string;
  technicianName?: string | null;
}

export interface RenderedTransactionalMessage {
  body: string;
  templateId: string;
  templateKey: TransactionalMessageTemplateKey;
  templateVersion: number;
}

const TEMPLATE_VERSION = 1;

@Injectable()
export class TransactionalMessageTemplateService {
  render(
    key: TransactionalMessageTemplateKey,
    context: TransactionalMessageTemplateContext,
  ): RenderedTransactionalMessage {
    const contractor = context.contractorName.trim();
    if (!contractor) {
      throw new BadRequestException("Contractor message branding is missing.");
    }

    const appointment = context.appointmentTime
      ? this.formatAppointment(context.appointmentTime, context.timeZone)
      : null;
    let message: string;

    switch (key) {
      case TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED:
        message = `${contractor}: Your service appointment is confirmed for ${this.requireAppointment(appointment)}.`;
        break;
      case TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED:
        message = `${contractor}: Your service appointment has been rescheduled for ${this.requireAppointment(appointment)}.`;
        break;
      case TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED:
        message = `${contractor}: Your service appointment has been cancelled. Please call us if you need to schedule another visit.`;
        break;
      case TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY: {
        const technician = context.technicianName?.trim();
        message = technician
          ? `${contractor}: ${technician}, your technician, is on the way.`
          : `${contractor}: Your technician is on the way.`;
        break;
      }
      default:
        throw new BadRequestException("Message template is not supported.");
    }

    return {
      body: `${message} Reply STOP to opt out or HELP for help.`,
      templateId: `transactional_sms:${key.toLowerCase()}:v${TEMPLATE_VERSION}`,
      templateKey: key,
      templateVersion: TEMPLATE_VERSION,
    };
  }

  private requireAppointment(value: string | null): string {
    if (!value) {
      throw new BadRequestException(
        "This message requires a confirmed appointment time.",
      );
    }
    return value;
  }

  private formatAppointment(value: Date, timeZone: string): string {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(value);
    } catch {
      throw new BadRequestException("Tenant timezone is invalid.");
    }
  }
}

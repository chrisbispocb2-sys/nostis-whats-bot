// src/services/notification.service.ts
import { createNotifier } from "notifier-hook";
import { logger } from "../utils/logger";

export class NotificationService {
  private notifier = createNotifier({ appName: "BotBrinzy" });

  constructor() {
    this.notifier.on("error", (err) =>
      logger.error({ err }, "Erro na notificação")
    );
  }

  public async send(title: string, body: string, { sound = true } = {}): Promise<void> {
    try {
      await this.notifier.start();
      await this.notifier.show({ title, body, sound });
    } catch (error) {
      logger.error({ error }, "Falha ao enviar notificação");
    }
  }
}

// Uma única instância pro programa todo (vários notificadores brigariam pelo
// mesmo daemon), criada só na primeira notificação.
let shared: NotificationService | null = null;

/** `sound: false` mostra o aviso do Windows sem tocar o som dele. */
export function sendNotification(title: string, body: string, options: { sound?: boolean } = {}): Promise<void> {
  shared ??= new NotificationService();
  return shared.send(title, body, options);
}

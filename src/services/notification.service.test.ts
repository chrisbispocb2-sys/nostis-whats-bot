import { describe, expect, test } from "bun:test";
import { NotificationService } from "./notification.service";

/** Guarda o que seria mostrado, no lugar do PowerShell de verdade. */
function fakeNotifier(platform = "win32") {
  const shown: Array<{ title: string; body: string; silent: boolean }> = [];
  const service = new NotificationService({ platform, show: async (title, body, silent) => void shown.push({ title, body, silent }) });
  return { service, shown };
}

describe("NotificationService", () => {
  test("no Windows mostra o balão; sound:false vai silencioso", async () => {
    const { service, shown } = fakeNotifier();
    await service.send("Título", "Corpo");
    await service.send("Pago", "R$ 10", { sound: false });
    expect(shown).toEqual([
      { title: "Título", body: "Corpo", silent: false },
      { title: "Pago", body: "R$ 10", silent: true },
    ]);
  });

  test("fora do Windows não tenta mostrar nada (as notificações do app são só no Windows)", async () => {
    const { service, shown } = fakeNotifier("linux");
    await service.send("Título", "Corpo");
    expect(shown).toEqual([]);
  });

  test("uma falha ao mostrar não propaga erro (é só um aviso, melhor esforço)", async () => {
    const service = new NotificationService({
      platform: "win32",
      show: async () => {
        throw new Error("powershell falhou");
      },
    });
    expect(service.send("x", "y")).resolves.toBeUndefined();
  });
});

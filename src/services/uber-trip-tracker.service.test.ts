import { afterEach, describe, expect, test } from "bun:test";
import { UberTripTrackerService, type UberStatusFetcher, type UberTripTrackerOptions } from "./uber-trip-tracker.service";

const wait = (ms: number) => Bun.sleep(ms);

function statusResponse(clientStatus: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      status: {
        clientStatus: "Looking",
        trips: [
          {
            clientStatus,
            eta: null,
            etaToDestination: null,
            statusMessage: { title: "", detailMode: "" },
            driver: { name: "EVERTON", rating: 5 },
            vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" },
            ...extra,
          },
        ],
      },
    },
  };
}

/** Fetcher fake: devolve uma resposta por vez de uma fila (ou lança erro se a fila pedir). */
function fakeFetcher(responses: Array<unknown | "error">) {
  const closed: boolean[] = [];
  let i = 0;
  const fetcher: UberStatusFetcher = {
    fetchStatus: async () => {
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      if (next === "error") throw new Error("falha de rede simulada");
      return next;
    },
    close: () => closed.push(true),
  };
  return { fetcher, isClosed: () => closed.length > 0 };
}

let service: UberTripTrackerService | null = null;

afterEach(() => {
  service?.stopAll();
  service = null;
});

function makeService(options: Partial<UberTripTrackerOptions> & { openStatusFetcher: UberTripTrackerOptions["openStatusFetcher"] }) {
  service = new UberTripTrackerService({ pollIntervalMs: 15, maxConsecutiveErrors: 3, ...options });
  return service;
}

describe("UberTripTrackerService", () => {
  test("a 2 min do local de partida: dispara onNearPickup uma vez", async () => {
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
    const nearPickup: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      onNearPickup: (chatJid) => {
        nearPickup.push(chatJid);
      },
    });

    await svc.startTracking("5511977770000@s.whatsapp.net", "TOKEN1", 3500);
    await wait(40);
    expect(nearPickup).toEqual(["5511977770000@s.whatsapp.net"]);
  });

  describe("gatilho da cobrança (onCharge)", () => {
    test("padrão (sem configurar nada): cobra a 2 min, igual sempre foi", async () => {
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      const charges: Array<{ chatJid: string; amount: number }> = [];
      const svc = makeService({
        openStatusFetcher: async () => fetcher,
        onCharge: (chatJid, amount) => {
          charges.push({ chatJid, amount });
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await wait(40);
      expect(charges).toEqual([{ chatJid: "CHAT", amount: 2500 }]);
    });

    test("'on_link': cobra na hora, antes de qualquer leitura de status", async () => {
      const { fetcher } = fakeFetcher([statusResponse("Looking")]);
      const charges: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => fetcher,
        chargeTrigger: () => "on_link",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      expect(charges).toEqual(["CHAT"]); // já teria disparado mesmo sem nenhum tick
    });

    test("'near_1min': cobra a 1 min, não a 2 min", async () => {
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 }), statusResponse("ArrivingAtPickup", { eta: 50 })]);
      const charges: string[] = [];
      const svc = makeService({
        pollIntervalMs: 10,
        openStatusFetcher: async () => fetcher,
        chargeTrigger: () => "near_1min",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      expect(charges).toEqual([]); // ainda a 90s (passou dos 2 min, mas não chegou em 1 min)
      await wait(40);
      expect(charges).toEqual(["CHAT"]); // agora a 50s, passou do limiar de 1 min
    });

    test("'on_arrival': não cobra enquanto só está perto (2 min nem 1 min contam)", async () => {
      // fica preso na zona de "1 min" pra sempre nesse teste — nunca deveria cobrar com esse gatilho
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 50 })]);
      const charges: string[] = [];
      const svc = makeService({
        pollIntervalMs: 10,
        openStatusFetcher: async () => fetcher,
        chargeTrigger: () => "on_arrival",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await wait(40);
      expect(charges).toEqual([]);
    });

    test("'on_arrival': cobra quando o motorista chega (eta 0)", async () => {
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]);
      const charges: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => fetcher,
        chargeTrigger: () => "on_arrival",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await wait(30);
      expect(charges).toEqual(["CHAT"]);
    });
  });

  test("a 1 min do local de partida: dispara onNearPickup1Min uma vez", async () => {
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 50 })]);
    const near1min: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      onNearPickup1Min: (chatJid) => {
        near1min.push(chatJid);
      },
    });

    await svc.startTracking("5511977770000@s.whatsapp.net", "TOKEN1", 3500);
    await wait(40);
    expect(near1min).toEqual(["5511977770000@s.whatsapp.net"]);
  });

  test("a Uber pula direto pra 'chegou' (eta 0 na primeira leitura): só o aviso atual sai, não os de 2 min e 1 min atrasados", async () => {
    // A leitura da Uber não é um cronômetro suave — é comum o eta sumir/zerar de uma vez, sem passar
    // por 2 min/1 min antes. Mandar "2 minutinhos", "1 minutinho" e "chegou" de uma vez só confundia
    // o cliente: os dois primeiros já não eram verdade. Só o marco atual é avisado.
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]);
    const events: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      onNearPickup: () => {
        events.push("near_2min");
      },
      onNearPickup1Min: () => {
        events.push("near_1min");
      },
      onArrivedPickup: () => {
        events.push("arrived");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 3500);
    await wait(40);
    expect(events).toEqual(["arrived"]);
  });

  test("pula de 'longe' direto pra '1 min': só o aviso de 1 min sai", async () => {
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 400 }), statusResponse("ArrivingAtPickup", { eta: 45 })]);
    const events: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      openStatusFetcher: async () => fetcher,
      onNearPickup: () => {
        events.push("near_2min");
      },
      onNearPickup1Min: () => {
        events.push("near_1min");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 3500);
    await wait(60);
    expect(events).toEqual(["near_1min"]);
  });

  test("pula direto pra 'corrida iniciada' (nunca viu o motorista chegando): só avisa o início, e a cobrança pulada ainda sai", async () => {
    const { fetcher } = fakeFetcher([statusResponse("OnTrip")]);
    const events: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      onNearPickup: () => {
        events.push("near_2min");
      },
      onArrivedPickup: () => {
        events.push("arrived");
      },
      onTripStarted: () => {
        events.push("started");
      },
      onCharge: () => {
        events.push("charge");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 3500);
    await wait(30);
    expect(events).toEqual(["started", "charge"]);
  });

  test("marco pulado com cobrança: o aviso atual sai primeiro e a cobrança depois, mesmo se o aviso demorar pra enviar", async () => {
    // Cada envio é aguardado antes do próximo — sem isso, a cobrança podia chegar ao cliente antes
    // do aviso (ordem trocada), porque os dois `sendMessage` saíam ao mesmo tempo.
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]);
    const events: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      chargeTrigger: () => "near_2min",
      onArrivedPickup: async () => {
        await wait(30); // lento de propósito
        events.push("arrived");
      },
      onCharge: () => {
        events.push("charge");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 3500);
    await wait(80);
    expect(events).toEqual(["arrived", "charge"]);
  });

  test("gatilho de cobrança 'near_2min' nunca mais some mesmo quando o eta pula direto pra 'chegou'", async () => {
    // Esse era o bug relatado: configurado pra cobrar a 2 min, mas a leitura pulou direto pra
    // "chegou" e a cobrança nunca saiu. Agora ela sai (atrasada, mas sai).
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]);
    const charges: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      chargeTrigger: () => "near_2min",
      onCharge: (chatJid) => {
        charges.push(chatJid);
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 2500);
    await wait(40);
    expect(charges).toEqual(["CHAT"]);
  });

  test("embarcou (OnTrip): dispara onTripStarted", async () => {
    const { fetcher } = fakeFetcher([statusResponse("OnTrip")]);
    const started: string[] = [];
    const svc = makeService({
      openStatusFetcher: async () => fetcher,
      onTripStarted: (chatJid) => {
        started.push(chatJid);
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 4200);
    await wait(40);
    expect(started).toEqual(["CHAT"]);
  });

  test("a mesma corrida avançando aos poucos: cada marco dispara exatamente uma vez, na ordem certa", async () => {
    const { fetcher } = fakeFetcher([
      statusResponse("Looking"),
      statusResponse("ArrivingAtPickup", { eta: 90 }),
      statusResponse("ArrivingAtPickup", { eta: 50 }),
      statusResponse("ArrivingAtPickup", { eta: 0 }),
      statusResponse("OnTrip"),
      statusResponse("OnTrip"),
    ]);
    const events: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      openStatusFetcher: async () => fetcher,
      onNearPickup: () => {
        events.push("near_2min");
      },
      onNearPickup1Min: () => {
        events.push("near_1min");
      },
      onArrivedPickup: () => {
        events.push("arrived");
      },
      onTripStarted: () => {
        events.push("started");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(150);
    expect(events).toEqual(["near_2min", "near_1min", "arrived", "started"]);
  });

  test("falha algumas vezes mas depois funciona: não desiste antes da hora", async () => {
    const { fetcher } = fakeFetcher(["error", "error", statusResponse("OnTrip")]);
    const started: string[] = [];
    const gaveUp: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      maxConsecutiveErrors: 5,
      openStatusFetcher: async () => fetcher,
      onTripStarted: (chatJid) => {
        started.push(chatJid);
      },
      onGaveUp: (chatJid) => gaveUp.push(chatJid),
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(80);
    expect(started).toEqual(["CHAT"]);
    expect(gaveUp).toEqual([]);
  });

  test("falha demais vezes seguidas: desiste e fecha a torneira de leituras", async () => {
    const { fetcher, isClosed } = fakeFetcher(["error", "error", "error"]);
    const gaveUp: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      maxConsecutiveErrors: 3,
      openStatusFetcher: async () => fetcher,
      onGaveUp: (chatJid) => gaveUp.push(chatJid),
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(80);
    expect(gaveUp).toEqual(["CHAT"]);
    expect(svc.isTracking("CHAT")).toBe(false);
    expect(isClosed()).toBe(true);
  });

  test("começar a acompanhar de novo na mesma conversa fecha o acompanhamento anterior", async () => {
    const first = fakeFetcher([statusResponse("Looking")]);
    const second = fakeFetcher([statusResponse("Looking")]);
    let calls = 0;
    const svc = makeService({
      openStatusFetcher: async () => {
        calls++;
        return calls === 1 ? first.fetcher : second.fetcher;
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await svc.startTracking("CHAT", "TOKEN2", 2000);
    expect(first.isClosed()).toBe(true);
    expect(second.isClosed()).toBe(false);
  });

  describe("o mesmo link avisado duas vezes (painel + eco do WhatsApp)", () => {
    test("não reinicia o acompanhamento nem cobra de novo com o gatilho 'on_link'", async () => {
      const { fetcher } = fakeFetcher([statusResponse("Looking")]);
      let opened = 0;
      const charges: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => {
          opened++;
          return fetcher;
        },
        chargeTrigger: () => "on_link",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await svc.startTracking("CHAT", "TOKEN1", 2500);
      expect(opened).toBe(1);
      expect(charges).toEqual(["CHAT"]);
    });

    test("os dois avisos chegando juntos, com o navegador ainda abrindo: abre um só e cobra uma vez só", async () => {
      const { fetcher } = fakeFetcher([statusResponse("Looking")]);
      let opened = 0;
      const charges: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => {
          opened++;
          await wait(20); // o Chrome leva alguns segundos pra abrir de verdade
          return fetcher;
        },
        chargeTrigger: () => "on_link",
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      const first = svc.startTracking("CHAT", "TOKEN1", 2500);
      expect(svc.isTracking("CHAT")).toBe(true); // já conta como acompanhando enquanto abre
      await Promise.all([first, svc.startTracking("CHAT", "TOKEN1", 2500)]);

      expect(opened).toBe(1);
      expect(charges).toEqual(["CHAT"]);
    });

    test("parar enquanto o navegador ainda abre: fecha a torneira e não fica acompanhando", async () => {
      const { fetcher, isClosed } = fakeFetcher([statusResponse("Looking")]);
      const svc = makeService({
        openStatusFetcher: async () => {
          await wait(20);
          return fetcher;
        },
      });

      const starting = svc.startTracking("CHAT", "TOKEN1", 2500);
      svc.stopTracking("CHAT");
      await starting;

      expect(svc.isTracking("CHAT")).toBe(false);
      expect(isClosed()).toBe(true);
    });
  });

  test("corrida cancelada antes do embarque (some do link): avisa uma vez, para de acompanhar e fecha a torneira", async () => {
    const semViagem = { data: { status: { clientStatus: "Looking", trips: [] } } };
    const { fetcher, isClosed } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 400 }), semViagem]);
    const cancelled: string[] = [];
    const gaveUp: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      openStatusFetcher: async () => fetcher,
      onCancelled: (chatJid) => cancelled.push(chatJid),
      onGaveUp: (chatJid) => gaveUp.push(chatJid),
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(120);
    expect(cancelled).toEqual(["CHAT"]);
    expect(gaveUp).toEqual([]);
    expect(svc.isTracking("CHAT")).toBe(false);
    expect(isClosed()).toBe(true);
  });

  test("a Uber ainda procurando motorista (viagem nunca apareceu) não é tratado como cancelamento", async () => {
    const { fetcher } = fakeFetcher([{ data: { status: { clientStatus: "Looking", trips: [] } } }]);
    const cancelled: string[] = [];
    const svc = makeService({ pollIntervalMs: 10, openStatusFetcher: async () => fetcher, onCancelled: (chatJid) => cancelled.push(chatJid) });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(80);
    expect(cancelled).toEqual([]);
    expect(svc.isTracking("CHAT")).toBe(true);
  });

  test("link inválido/expirado (resposta sem o formato esperado): conta como falha e desiste, em vez de consultar pra sempre", async () => {
    const { fetcher, isClosed } = fakeFetcher([{ errors: [{ message: "not found" }] }]);
    const gaveUp: string[] = [];
    const svc = makeService({ pollIntervalMs: 10, maxConsecutiveErrors: 3, openStatusFetcher: async () => fetcher, onGaveUp: (chatJid) => gaveUp.push(chatJid) });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(80);
    expect(gaveUp).toEqual(["CHAT"]);
    expect(isClosed()).toBe(true);
  });

  test("link para de responder DEPOIS do embarque: encerra em silêncio (a corrida acabou, não é uma falha)", async () => {
    const { fetcher, isClosed } = fakeFetcher([statusResponse("OnTrip"), "error"]);
    const gaveUp: string[] = [];
    const svc = makeService({ pollIntervalMs: 10, maxConsecutiveErrors: 3, openStatusFetcher: async () => fetcher, onGaveUp: (chatJid) => gaveUp.push(chatJid) });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(100);
    expect(gaveUp).toEqual([]);
    expect(svc.isTracking("CHAT")).toBe(false);
    expect(isClosed()).toBe(true);
  });

  test("troca de motorista (placa diferente) depois do aviso de 2 min: avisa a troca e os marcos voltam a valer pro carro novo, sem cobrar de novo", async () => {
    const { fetcher } = fakeFetcher([
      statusResponse("ArrivingAtPickup", { eta: 90 }),
      statusResponse("ArrivingAtPickup", { eta: 500, vehicle: { licensePlate: "ABC1D23", make: "Fiat", model: "Argo", colorTranslatedName: "Branco" } }),
      statusResponse("ArrivingAtPickup", { eta: 90, vehicle: { licensePlate: "ABC1D23", make: "Fiat", model: "Argo", colorTranslatedName: "Branco" } }),
    ]);
    const events: string[] = [];
    const charges: string[] = [];
    const svc = makeService({
      pollIntervalMs: 10,
      openStatusFetcher: async () => fetcher,
      onNearPickup: (_chatJid, snapshot) => {
        events.push(`near_2min:${snapshot.vehiclePlate}`);
      },
      onDriverChanged: (_chatJid, snapshot) => {
        events.push(`driver_changed:${snapshot.vehiclePlate}`);
      },
      onCharge: (chatJid) => {
        charges.push(chatJid);
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(100);
    expect(events).toEqual(["near_2min:QPQ8I33", "driver_changed:ABC1D23", "near_2min:ABC1D23"]);
    expect(charges).toEqual(["CHAT"]);
  });

  describe("outra corrida na mesma conversa", () => {
    test("link novo depois de uma corrida cobrada que não embarcou: acompanha a nova, mas não cobra de novo (e avisa)", async () => {
      const first = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      const second = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      let calls = 0;
      const charges: string[] = [];
      const skipped: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => (++calls === 1 ? first.fetcher : second.fetcher),
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
        onChargeSkipped: (chatJid) => skipped.push(chatJid),
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await svc.startTracking("CHAT", "TOKEN2", 2500); // motorista cancelou, você pediu outro carro
      expect(first.isClosed()).toBe(true);
      expect(charges).toEqual(["CHAT"]);
      expect(skipped).toEqual(["CHAT"]);
    });

    test("a corrida anterior embarcou: a próxima é uma corrida nova de verdade e cobra normalmente", async () => {
      const first = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 }), statusResponse("OnTrip")]);
      const second = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      let calls = 0;
      const charges: string[] = [];
      const svc = makeService({
        pollIntervalMs: 10,
        openStatusFetcher: async () => (++calls === 1 ? first.fetcher : second.fetcher),
        onCharge: (chatJid) => {
          charges.push(chatJid);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await wait(40);
      await svc.startTracking("CHAT", "TOKEN2", 3000);
      expect(charges).toEqual(["CHAT", "CHAT"]);
    });

    test("cobrança que não saiu de verdade (onCharge devolve false) não bloqueia a cobrança da próxima corrida", async () => {
      const first = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      const second = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      let calls = 0;
      let attempts = 0;
      const svc = makeService({
        openStatusFetcher: async () => (++calls === 1 ? first.fetcher : second.fetcher),
        onCharge: () => {
          attempts++;
          return false;
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", 2500);
      await svc.startTracking("CHAT", "TOKEN2", 2500);
      expect(attempts).toBe(2);
    });
  });

  test("status: mostra o marco, o tempo até o local de partida e o carro (pro painel)", async () => {
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
    const svc = makeService({ openStatusFetcher: async () => fetcher, onCharge: () => {} });

    expect(svc.status("CHAT")).toBeNull();
    await svc.startTracking("CHAT", "TOKEN1", 2500);
    expect(svc.status("CHAT")).toMatchObject({
      phase: "near_pickup",
      agreedAmountCents: 2500,
      charged: true,
      etaSeconds: 90,
      driverName: "EVERTON",
      vehiclePlate: "QPQ8I33",
      vehicleDescription: "Cinza Nissan Versa",
    });
  });

  test("parado bem na hora do aviso: a cobrança que viria em seguida não sai", async () => {
    const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]);
    const events: string[] = [];
    let svc!: UberTripTrackerService;
    svc = makeService({
      openStatusFetcher: async () => fetcher,
      onArrivedPickup: () => {
        events.push("arrived");
        svc.stopTracking("CHAT"); // você clicou "Parar" bem na hora
      },
      onCharge: () => {
        events.push("charge");
      },
    });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(30);
    expect(events).toEqual(["arrived"]);
  });

  describe("corrida sem valor combinado (link mandado pelo celular sem 'chama ?')", () => {
    test("acompanha e avisa, mas não cobra; definir o valor depois cobra na hora se o momento já passou", async () => {
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]);
      const events: string[] = [];
      const svc = makeService({
        openStatusFetcher: async () => fetcher,
        onNearPickup: () => {
          events.push("near_2min");
        },
        onCharge: (_chatJid, amount) => {
          events.push(`charge:${amount}`);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", null);
      expect(events).toEqual(["near_2min"]);
      expect(svc.status("CHAT")).toMatchObject({ agreedAmountCents: null, charged: false });

      expect(await svc.setAgreedAmount("CHAT", 3000)).toBe(true);
      expect(events).toEqual(["near_2min", "charge:3000"]);
      expect(await svc.setAgreedAmount("CHAT", 9900)).toBe(false); // já cobrada: o valor não muda mais
    });

    test("valor definido antes do momento da cobrança: só cobra quando o momento chegar", async () => {
      const { fetcher } = fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 400 }), statusResponse("ArrivingAtPickup", { eta: 400 }), statusResponse("ArrivingAtPickup", { eta: 90 })]);
      const charges: number[] = [];
      const svc = makeService({
        pollIntervalMs: 20,
        openStatusFetcher: async () => fetcher,
        onCharge: (_chatJid, amount) => {
          charges.push(amount);
        },
      });

      await svc.startTracking("CHAT", "TOKEN1", null);
      await svc.setAgreedAmount("CHAT", 3000);
      expect(charges).toEqual([]);
      await wait(80);
      expect(charges).toEqual([3000]);
    });
  });

  describe("fechar e abrir o programa no meio de uma corrida", () => {
    function memoryPersistence() {
      let state: { trips: any[]; unconsumedCharges: Record<string, number> } = { trips: [], unconsumedCharges: {} };
      return { load: () => state, save: (next: typeof state) => void (state = JSON.parse(JSON.stringify(next))), peek: () => state };
    }

    test("retoma do marco em que parou: não repete o aviso nem a cobrança que já saíram, e segue avisando os próximos", async () => {
      const persistence = memoryPersistence();
      const events: string[] = [];
      const callbacks = {
        persistence,
        onNearPickup: () => {
          events.push("near_2min");
        },
        onArrivedPickup: () => {
          events.push("arrived");
        },
        onCharge: () => {
          events.push("charge");
        },
      };

      const before = makeService({ openStatusFetcher: async () => fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 90 })]).fetcher, ...callbacks });
      await before.startTracking("CHAT", "TOKEN1", 2500);
      expect(events).toEqual(["near_2min", "charge"]);
      before.suspendAll(); // programa fechando
      expect(persistence.peek().trips).toHaveLength(1);

      const opened: string[] = [];
      const after = makeService({
        openStatusFetcher: async (token) => {
          opened.push(token);
          return fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 0 })]).fetcher;
        },
        ...callbacks,
      });
      await after.restore();

      expect(opened).toEqual(["TOKEN1"]);
      expect(after.isTracking("CHAT")).toBe(true);
      expect(events).toEqual(["near_2min", "charge", "arrived"]);
    });

    test("parar uma corrida tira ela do disco: não volta ao reabrir", async () => {
      const persistence = memoryPersistence();
      const svc = makeService({ persistence, openStatusFetcher: async () => fakeFetcher([statusResponse("Looking")]).fetcher });
      await svc.startTracking("CHAT", "TOKEN1", 2500);
      svc.stopTracking("CHAT");
      expect(persistence.peek().trips).toEqual([]);
    });

    test("corrida guardada velha demais (programa ficou horas fechado) não é retomada", async () => {
      const persistence = memoryPersistence();
      persistence.save({
        trips: [{ chatJid: "CHAT", shareToken: "TOKEN1", agreedAmountCents: 2500, chargeTrigger: "near_2min", startedAt: Date.now() - 5 * 60 * 60_000, phase: "waiting_pickup", charged: false, lastPlate: null }],
        unconsumedCharges: {},
      });
      let opened = 0;
      const svc = makeService({
        persistence,
        openStatusFetcher: async () => {
          opened++;
          return fakeFetcher([statusResponse("Looking")]).fetcher;
        },
      });

      await svc.restore();
      expect(opened).toBe(0);
      expect(svc.isTracking("CHAT")).toBe(false);
      expect(persistence.peek().trips).toEqual([]);
    });
  });

  test("list: todas as corridas em acompanhamento, com a conversa de cada uma", async () => {
    const svc = makeService({ openStatusFetcher: async () => fakeFetcher([statusResponse("ArrivingAtPickup", { eta: 400 })]).fetcher });
    await svc.startTracking("CHAT_A", "TOKEN1", 2500);
    await svc.startTracking("CHAT_B", "TOKEN2", null);

    expect(svc.list()).toMatchObject([
      { chatJid: "CHAT_A", phase: "waiting_pickup", etaSeconds: 400, agreedAmountCents: 2500 },
      { chatJid: "CHAT_B", phase: "waiting_pickup", agreedAmountCents: null },
    ]);
  });

  test("stopTracking fecha a torneira de leituras e para de consultar", async () => {
    const { fetcher, isClosed } = fakeFetcher([statusResponse("Looking")]);
    const svc = makeService({ openStatusFetcher: async () => fetcher });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    svc.stopTracking("CHAT");
    expect(isClosed()).toBe(true);
    expect(svc.isTracking("CHAT")).toBe(false);
  });

  test("corrida termina (some da resposta) depois de ter embarcado: para de acompanhar sozinho", async () => {
    const { fetcher, isClosed } = fakeFetcher([statusResponse("OnTrip"), { data: { status: { clientStatus: "Looking", trips: [] } } }]);
    const svc = makeService({ pollIntervalMs: 10, openStatusFetcher: async () => fetcher });

    await svc.startTracking("CHAT", "TOKEN1", 1000);
    await wait(60);
    expect(svc.isTracking("CHAT")).toBe(false);
    expect(isClosed()).toBe(true);
  });
});

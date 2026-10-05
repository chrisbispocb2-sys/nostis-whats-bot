import { describe, expect, test } from "bun:test";
import { crossedPhases, describeRide, describeRoute, extractChamaAmountCents, extractUberShareToken, nextUberTripPhase, parseUberStatusResponse, phaseTrigger, type UberTripSnapshot } from "./uber-trip";

function snapshot(overrides: Partial<UberTripSnapshot> = {}): UberTripSnapshot {
  return {
    clientStatus: "Looking",
    etaSeconds: null,
    etaToDestinationSeconds: null,
    statusTitle: null,
    driverName: null,
    vehiclePlate: null,
    vehicleDescription: null,
    pickupAddress: null,
    destinationAddress: null,
    tripExists: true,
    ...overrides,
  };
}

describe("extractUberShareToken", () => {
  test("pega o token de um link trip.uber.com", () => {
    expect(extractUberShareToken("https://trip.uber.com/QUAF2AH")).toBe("QUAF2AH");
  });

  test("pega o token de um link m.uber.com/go/share já expandido", () => {
    expect(extractUberShareToken("https://m.uber.com/go/share?share_token=QUAF2AH&outro=1")).toBe("QUAF2AH");
  });

  test("funciona com o link no meio de uma frase", () => {
    expect(extractUberShareToken("olha o motorista: https://trip.uber.com/AB12cd mandou chegar")).toBe("AB12cd");
  });

  test("texto sem link nenhum devolve null", () => {
    expect(extractUberShareToken("oi, tudo bem?")).toBeNull();
  });
});

describe("extractChamaAmountCents", () => {
  test("pega o valor de 'NN,NN chama ?'", () => {
    expect(extractChamaAmountCents("25,00 chama ?")).toBe(2500);
  });

  test("funciona sem casas decimais e sem a interrogação", () => {
    expect(extractChamaAmountCents("30 chama")).toBe(3000);
  });

  test("não liga pra maiúsculas/minúsculas nem espaço extra", () => {
    expect(extractChamaAmountCents("40,50   CHAMA  ?")).toBe(4050);
  });

  test("acha mesmo no meio de uma frase maior", () => {
    expect(extractChamaAmountCents("Oi! 18,00 chama ? Me avisa quando sair")).toBe(1800);
  });

  test("uma casa decimal só: lê o número inteiro (antes '25,5 chama ?' virava R$ 5,00)", () => {
    expect(extractChamaAmountCents("25,5 chama ?")).toBe(2550);
    expect(extractChamaAmountCents("25.50 chama?")).toBe(2550);
  });

  test("valor com milhar não é lido pela metade (antes '1.250,00 chama ?' virava R$ 250,00): devolve null e o painel pergunta", () => {
    expect(extractChamaAmountCents("1.250,00 chama ?")).toBeNull();
  });

  test("sem o padrão 'chama': devolve null", () => {
    expect(extractChamaAmountCents("Oi, tudo bem?")).toBeNull();
    expect(extractChamaAmountCents("25,00")).toBeNull();
  });
});

describe("describeRide", () => {
  test("carro, placa e motorista numa linha (nome sem ser em maiúsculas)", () => {
    expect(describeRide(snapshot({ vehicleDescription: "Cinza Nissan Versa", vehiclePlate: "QPQ8I33", driverName: "MARIA LUIZA" }))).toBe(
      "Cinza Nissan Versa · placa QPQ8I33 · motorista Maria Luiza"
    );
  });

  test("só o que a Uber já informou; nada informado devolve null", () => {
    expect(describeRide(snapshot({ vehiclePlate: "QPQ8I33" }))).toBe("placa QPQ8I33");
    expect(describeRide(snapshot({ vehicleDescription: "" }))).toBeNull();
  });
});

describe("parseUberStatusResponse", () => {
  test("lê uma resposta de verdade (capturada de uma corrida real em 'a caminho do local de partida')", () => {
    const raw = {
      data: {
        status: {
          clientStatus: "Looking",
          trips: [
            {
              clientStatus: "ArrivingAtPickup",
              eta: 0,
              etaToDestination: 1327,
              statusMessage: { title: "Maria Luiza está aguardando no local de partida", detailMode: "MinutesToPickup" },
              driver: { name: "EVERTON", rating: 5 },
              vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" },
            },
          ],
        },
      },
    };
    expect(parseUberStatusResponse(raw)).toEqual({
      clientStatus: "ArrivingAtPickup",
      etaSeconds: 0,
      etaToDestinationSeconds: 1327,
      statusTitle: "Maria Luiza está aguardando no local de partida",
      driverName: "EVERTON",
      vehiclePlate: "QPQ8I33",
      vehicleDescription: "Cinza Nissan Versa",
      pickupAddress: null,
      destinationAddress: null,
      tripExists: true,
    });
  });

  test("endereços de partida e destino (waypoints): pelo tipo do ponto, ou pela ordem quando o tipo não é reconhecido", () => {
    const withWaypoints = (waypoints: unknown) => parseUberStatusResponse({ data: { status: { trips: [{ clientStatus: "ArrivingAtPickup", waypoints }] } } });

    // tipo reconhecido, mesmo fora de ordem; subtítulo entra junto, sem repetir o que já está no título
    expect(
      withWaypoints([
        { title: "Av. Dois, 456", subtitle: "Av. Dois", type: "DROPOFF" },
        { title: "Rua Um, 123", subtitle: "Centro", type: "PICKUP" },
      ])
    ).toMatchObject({ pickupAddress: "Rua Um, 123, Centro", destinationAddress: "Av. Dois, 456" });

    // tipo desconhecido: primeiro = partida, último = destino (parada no meio fica de fora)
    expect(withWaypoints([{ title: "A" }, { title: "Parada" }, { title: "B" }])).toMatchObject({ pickupAddress: "A", destinationAddress: "B" });

    // um ponto só, sem tipo reconhecido: não dá pra saber qual é
    expect(withWaypoints([{ title: "A" }])).toMatchObject({ pickupAddress: null, destinationAddress: null });
    expect(withWaypoints([{ title: "B", type: "DESTINATION" }])).toMatchObject({ pickupAddress: null, destinationAddress: "B" });
    expect(withWaypoints(null)).toMatchObject({ pickupAddress: null, destinationAddress: null });
  });

  test("describeRoute: linhas de partida e destino pro cliente conferir; null sem endereço nenhum", () => {
    expect(describeRoute(snapshot({ pickupAddress: "Rua Um, 123", destinationAddress: "Av. Dois, 456" }))).toBe("📍 *Partida:* Rua Um, 123\n🏁 *Destino:* Av. Dois, 456");
    expect(describeRoute(snapshot({ destinationAddress: "Av. Dois, 456" }))).toBe("🏁 *Destino:* Av. Dois, 456");
    expect(describeRoute(snapshot())).toBeNull();
  });

  test("lê uma resposta de 'OnTrip' (já embarcou, a caminho do destino)", () => {
    const raw = {
      data: {
        status: {
          clientStatus: "Looking",
          trips: [
            {
              clientStatus: "OnTrip",
              eta: 6,
              etaToDestination: 377,
              statusMessage: { title: "Maria Luiza está a caminho", detailMode: "TimeOfDropoff" },
              driver: { name: "EVERTON", rating: 5 },
              vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" },
            },
          ],
        },
      },
    };
    expect(parseUberStatusResponse(raw)?.clientStatus).toBe("OnTrip");
  });

  test("sem viagem nenhuma na resposta (cancelada/concluída): tripExists false", () => {
    const raw = { data: { status: { clientStatus: "Looking", trips: [] } } };
    expect(parseUberStatusResponse(raw)).toMatchObject({ tripExists: false });
  });

  test("resposta com formato inesperado (link inválido/expirado) devolve null", () => {
    expect(parseUberStatusResponse({ errors: [{ message: "not found" }] })).toBeNull();
    expect(parseUberStatusResponse(null)).toBeNull();
    expect(parseUberStatusResponse("texto qualquer")).toBeNull();
    expect(parseUberStatusResponse({})).toBeNull();
  });
});

describe("nextUberTripPhase", () => {
  test("procurando motorista: fica esperando", () => {
    expect(nextUberTripPhase("waiting_pickup", snapshot({ clientStatus: "Looking" }))).toBe("waiting_pickup");
  });

  test("a caminho, mas ainda longe (eta > 2min): continua esperando", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 300 });
    expect(nextUberTripPhase("waiting_pickup", s)).toBe("waiting_pickup");
  });

  test("a caminho, a 2 minutos ou menos: vira 'near_pickup'", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 120 });
    expect(nextUberTripPhase("waiting_pickup", s)).toBe("near_pickup");
  });

  test("a caminho, a 1 minuto ou menos (mas ainda não chegou): vira 'near_pickup_1min'", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 60 });
    expect(nextUberTripPhase("near_pickup", s)).toBe("near_pickup_1min");
  });

  test("de 'waiting_pickup' direto pro 1 min: pula o 'near_pickup' de 2 min (mesma lógica de nunca regredir)", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 45 });
    expect(nextUberTripPhase("waiting_pickup", s)).toBe("near_pickup_1min");
  });

  test("eta chegou a 0: vira 'arrived_pickup' direto (mesmo pulando o 'near_pickup' e o 'near_pickup_1min')", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 0 });
    expect(nextUberTripPhase("waiting_pickup", s)).toBe("arrived_pickup");
  });

  test("nunca regride de 'near_pickup_1min' de volta pra 'near_pickup' (eta oscilando pra cima)", () => {
    const s = snapshot({ clientStatus: "ArrivingAtPickup", etaSeconds: 90 }); // voltaria pra zona de 2 min
    expect(nextUberTripPhase("near_pickup_1min", s)).toBe("near_pickup_1min");
  });

  test("clientStatus OnTrip: vira 'in_progress' direto, não importa a fase atual (até pulando marcos)", () => {
    expect(nextUberTripPhase("waiting_pickup", snapshot({ clientStatus: "OnTrip" }))).toBe("in_progress");
    expect(nextUberTripPhase("near_pickup", snapshot({ clientStatus: "OnTrip" }))).toBe("in_progress");
  });

  test("nunca regride: já em 'in_progress', uma leitura estranha de 'Looking' não volta atrás", () => {
    expect(nextUberTripPhase("in_progress", snapshot({ clientStatus: "Looking" }))).toBe("in_progress");
  });

  test("em viagem e a corrida some da resposta (cancelada/concluída): vira 'finished'", () => {
    const s = snapshot({ clientStatus: null, tripExists: false });
    expect(nextUberTripPhase("in_progress", s)).toBe("finished");
  });

  test("sem viagem na resposta mas ainda não tinha começado: não é 'finished' (só cancelamento depois de 'in_progress' conta)", () => {
    const s = snapshot({ clientStatus: null, tripExists: false });
    expect(nextUberTripPhase("waiting_pickup", s)).toBe("waiting_pickup");
  });
});

describe("crossedPhases", () => {
  test("avanço de um marco só: devolve só esse marco (igual phaseTrigger)", () => {
    expect(crossedPhases("waiting_pickup", "near_pickup")).toEqual(["near_pickup"]);
    expect(crossedPhases("near_pickup", "arrived_pickup")).toEqual(["near_pickup_1min", "arrived_pickup"]);
  });

  test("nada mudou: lista vazia (não repete marco já disparado)", () => {
    expect(crossedPhases("waiting_pickup", "waiting_pickup")).toEqual([]);
    expect(crossedPhases("in_progress", "in_progress")).toEqual([]);
  });

  test("pulo de vários marcos de uma vez (eta sumiu/zerou entre duas leituras): devolve todos, em ordem", () => {
    expect(crossedPhases("waiting_pickup", "arrived_pickup")).toEqual(["near_pickup", "near_pickup_1min", "arrived_pickup"]);
    expect(crossedPhases("waiting_pickup", "in_progress")).toEqual(["near_pickup", "near_pickup_1min", "arrived_pickup", "in_progress"]);
    expect(crossedPhases("near_pickup", "finished")).toEqual(["near_pickup_1min", "arrived_pickup", "in_progress", "finished"]);
  });
});

describe("phaseTrigger", () => {
  test("mudou de fase: devolve a fase nova", () => {
    expect(phaseTrigger("waiting_pickup", "near_pickup")).toBe("near_pickup");
    expect(phaseTrigger("near_pickup", "arrived_pickup")).toBe("arrived_pickup");
    expect(phaseTrigger("arrived_pickup", "in_progress")).toBe("in_progress");
  });

  test("não mudou: devolve null (não dispara notificação repetida)", () => {
    expect(phaseTrigger("waiting_pickup", "waiting_pickup")).toBeNull();
    expect(phaseTrigger("in_progress", "in_progress")).toBeNull();
  });
});

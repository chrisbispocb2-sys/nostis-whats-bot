import { parseAmountToCents } from "../utils/money";

/**
 * Acompanha uma corrida da Uber pelo link público de "compartilhar viagem" (trip.uber.com/XXXX).
 * Baseado em engenharia reversa de uma chamada GraphQL não-documentada que a própria página usa
 * (m.uber.com/go/graphql, operação GetStatus) — não é uma API oficial da Uber, pode quebrar se a
 * Uber mudar o app deles sem aviso. Os nomes de campo (`clientStatus: "Looking"/"ArrivingAtPickup"/
 * "OnTrip"`, `eta`, `etaToDestination`) foram confirmados observando uma corrida real em andamento.
 */

/** Query enxuta: só os campos que a automação realmente usa (mais robusta que copiar a query inteira do app oficial). */
export const UBER_STATUS_QUERY = `query GetStatusMini($share: InputShare) {
  status(latitude: 0, longitude: 0, share: $share) {
    clientStatus
    trips {
      clientStatus
      eta
      etaToDestination
      statusMessage { title detailMode }
      driver { name rating }
      vehicle { licensePlate make model colorTranslatedName }
    }
  }
}`;

export function buildUberStatusRequestBody(shareToken: string): string {
  return JSON.stringify({
    operationName: "GetStatusMini",
    variables: { share: { shareToken, timezone: "America/Sao_Paulo" } },
    query: UBER_STATUS_QUERY,
  });
}

/** Tira o token de um link colado (trip.uber.com/XXXX ou m.uber.com/go/share?share_token=XXXX). Null = não é um link da Uber. */
export function extractUberShareToken(text: string): string | null {
  const direct = text.match(/trip\.uber\.com\/([A-Za-z0-9]+)/);
  if (direct) return direct[1]!;
  const shareParam = text.match(/m\.uber\.com\/go\/share\?[^\s]*share_token=([A-Za-z0-9]+)/);
  if (shareParam) return shareParam[1]!;
  return null;
}

// O jeito que o operador já combina o valor com o cliente antes de chamar o Uber: "25,00 chama ?" / "30 chama?"
// O número tem que ser lido inteiro: sem o `(?<![\d.,])`, "25,5 chama ?" casava só o "5" e a cobrança
// automática saía de R$ 5,00 (e "1.250,00 chama ?" saía de R$ 250,00).
const CHAMA_PRICE_PATTERN = /(?<![\d.,])(\d{1,4}(?:[.,]\d{1,2})?)\s*chama\s*\??/i;

/**
 * Acha o valor de um "NN,NN chama ?" que você mandou — formato que já é usado pra combinar o preço
 * com o cliente antes de pedir o Uber, reaproveitado aqui como fonte do valor a cobrar automaticamente.
 */
export function extractChamaAmountCents(text: string): number | null {
  const match = text.match(CHAMA_PRICE_PATTERN);
  if (!match) return null;
  return parseAmountToCents(match[1]!);
}

export interface UberTripSnapshot {
  /** "Looking" (procurando motorista), "ArrivingAtPickup" (a caminho do local de partida), "OnTrip" (já pegou, a caminho do destino) — ou outro valor não mapeado ainda. */
  clientStatus: string | null;
  /** Segundos até chegar no local de partida (0 = já chegou e está esperando). Null fora da fase "ArrivingAtPickup". */
  etaSeconds: number | null;
  etaToDestinationSeconds: number | null;
  statusTitle: string | null;
  driverName: string | null;
  vehiclePlate: string | null;
  vehicleDescription: string | null;
  /** false quando a viagem já não aparece mais na resposta (cancelada ou concluída). */
  tripExists: boolean;
}

/** Lê a resposta crua do GetStatusMini. Devolve null se o formato não bate com o esperado (link inválido/expirado, erro da API, etc). */
export function parseUberStatusResponse(raw: unknown): UberTripSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as Record<string, unknown>)["data"] as Record<string, unknown> | undefined;
  const status = data?.["status"] as Record<string, unknown> | undefined;
  if (!status) return null;

  const trips = status["trips"] as Array<Record<string, unknown>> | undefined;
  const trip = trips?.[0];
  if (!trip) {
    return {
      clientStatus: (status["clientStatus"] as string) ?? null,
      etaSeconds: null,
      etaToDestinationSeconds: null,
      statusTitle: null,
      driverName: null,
      vehiclePlate: null,
      vehicleDescription: null,
      tripExists: false,
    };
  }

  const statusMessage = trip["statusMessage"] as Record<string, unknown> | undefined;
  const driver = trip["driver"] as Record<string, unknown> | undefined;
  const vehicle = trip["vehicle"] as Record<string, unknown> | undefined;

  return {
    clientStatus: (trip["clientStatus"] as string) ?? null,
    etaSeconds: typeof trip["eta"] === "number" ? (trip["eta"] as number) : null,
    etaToDestinationSeconds: typeof trip["etaToDestination"] === "number" ? (trip["etaToDestination"] as number) : null,
    statusTitle: (statusMessage?.["title"] as string) ?? null,
    driverName: (driver?.["name"] as string) ?? null,
    vehiclePlate: (vehicle?.["licensePlate"] as string) ?? null,
    vehicleDescription: vehicle
      ? [vehicle["colorTranslatedName"], vehicle["make"], vehicle["model"]].filter(Boolean).join(" ")
      : null,
    tripExists: true,
  };
}

/**
 * Carro e motorista numa linha só, pro cliente saber quem procurar ("Cinza Nissan Versa · placa
 * QPQ8I33 · motorista Everton"). Null se a Uber ainda não informou nada disso.
 */
export function describeRide(snapshot: UberTripSnapshot): string | null {
  const parts = [
    snapshot.vehicleDescription || null,
    snapshot.vehiclePlate ? `placa ${snapshot.vehiclePlate}` : null,
    snapshot.driverName ? `motorista ${formatDriverName(snapshot.driverName)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** A Uber manda o nome em maiúsculas ("EVERTON"): deixa como nome próprio. */
function formatDriverName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

/** Marcos da corrida, em ordem (nunca regride: uma vez passado um marco, não volta pro anterior). */
export type UberTripPhase = "waiting_pickup" | "near_pickup" | "near_pickup_1min" | "arrived_pickup" | "in_progress" | "finished";

const PHASE_ORDER: UberTripPhase[] = ["waiting_pickup", "near_pickup", "near_pickup_1min", "arrived_pickup", "in_progress", "finished"];

/** Posição do marco na ordem da corrida (pra comparar "já passou de tal marco?"). */
export function phaseRank(phase: UberTripPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

const NEAR_PICKUP_THRESHOLD_SECONDS = 120;
const NEAR_PICKUP_1MIN_THRESHOLD_SECONDS = 60;

/** A partir do estado atual e de uma nova leitura, decide qual é o marco agora (nunca regride). */
export function nextUberTripPhase(current: UberTripPhase, snapshot: UberTripSnapshot): UberTripPhase {
  let candidate: UberTripPhase = current;

  if (snapshot.clientStatus === "OnTrip") {
    candidate = "in_progress";
  } else if (snapshot.clientStatus === "ArrivingAtPickup") {
    if (snapshot.etaSeconds !== null && snapshot.etaSeconds <= 0) candidate = "arrived_pickup";
    else if (snapshot.etaSeconds !== null && snapshot.etaSeconds <= NEAR_PICKUP_1MIN_THRESHOLD_SECONDS) candidate = "near_pickup_1min";
    else if (snapshot.etaSeconds !== null && snapshot.etaSeconds <= NEAR_PICKUP_THRESHOLD_SECONDS) candidate = "near_pickup";
  } else if (!snapshot.tripExists && current === "in_progress") {
    candidate = "finished";
  }

  const currentRank = PHASE_ORDER.indexOf(current);
  const candidateRank = PHASE_ORDER.indexOf(candidate);
  return candidateRank > currentRank ? candidate : current;
}

/** Qual marco foi cruzado AGORA (pra disparar a notificação uma única vez), ou null se nada mudou. */
export function phaseTrigger(previous: UberTripPhase, next: UberTripPhase): Exclude<UberTripPhase, "waiting_pickup"> | null {
  if (previous === next) return null;
  return next as Exclude<UberTripPhase, "waiting_pickup">;
}

/**
 * Todos os marcos cruzados entre duas leituras, em ordem — não só o último. A leitura da Uber não é
 * um cronômetro suave: é comum o status pular direto de "longe" pra "chegando agora" (ETA some ou
 * zera de uma vez, sem passar por 2 min/1 min antes), e o polling (a cada ~20s) também pode não
 * pegar exatamente a janela de cada marco. Sem isso, um pulo assim fazia o aviso de "2 minutos" e a
 * cobrança automática configurada pra esse marco nunca saírem — dinheiro perdido, não só um aviso.
 */
export function crossedPhases(previous: UberTripPhase, next: UberTripPhase): Array<Exclude<UberTripPhase, "waiting_pickup">> {
  const from = PHASE_ORDER.indexOf(previous);
  const to = PHASE_ORDER.indexOf(next);
  if (to <= from) return [];
  return PHASE_ORDER.slice(from + 1, to + 1) as Array<Exclude<UberTripPhase, "waiting_pickup">>;
}

/** Uma "torneira" de leituras de status de UMA corrida — aberta uma vez, consultada várias vezes, fechada ao terminar. */
export interface UberStatusFetcher {
  fetchStatus(): Promise<unknown>;
  close(): void;
}

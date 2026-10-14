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
      waypoints { title subtitle type }
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

// O número tem que ser lido inteiro: sem o `(?<![\d.,])`, "25,5 chama" casava só o "5" e a cobrança
// automática saía de R$ 5,00 (e "1.250,00 chama" saía de R$ 250,00).
const PRICE_NUMBER = String.raw`(\d{1,4}(?:[.,]\d{1,2})?)`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Acha o valor combinado que você mandou antes de pedir o Uber, pela palavra-chave configurada (padrão
 * "chama"): "25,00 chama", "chama 25", "30 valor", etc. — o número pode vir ANTES ou DEPOIS da palavra.
 * Reaproveitado aqui como fonte do valor a cobrar automaticamente. Palavra vazia = usa "chama".
 */
export function extractChamaAmountCents(text: string, keyword = "chama"): number | null {
  const kw = escapeRegExp((keyword ?? "").trim() || "chama");
  // número antes da palavra ("25,00 chama"): o número é lido inteiro (ver comentário acima)
  const before = text.match(new RegExp(String.raw`(?<![\d.,])${PRICE_NUMBER}\s*${kw}`, "i"));
  // número depois da palavra ("chama 25,00"): a palavra seguida do valor, sem grudar noutro número
  const after = before ? null : text.match(new RegExp(String.raw`${kw}\s*${PRICE_NUMBER}(?![\d.,])`, "i"));
  const match = before ?? after;
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
  /** Endereço de partida e de destino da corrida, como a Uber mostra no link (null = não informado). */
  pickupAddress: string | null;
  destinationAddress: string | null;
  /** Paradas no meio do caminho, na ordem da rota (vazio = corrida direta). */
  stopAddresses: string[];
  /** false quando a viagem já não aparece mais na resposta (cancelada ou concluída). */
  tripExists: boolean;
}

/** Endereço de um ponto da corrida numa linha só ("Rua Um, 123, Centro"). */
function waypointAddress(waypoint: Record<string, unknown> | undefined): string | null {
  const title = typeof waypoint?.["title"] === "string" ? waypoint["title"].trim() : "";
  const subtitle = typeof waypoint?.["subtitle"] === "string" ? waypoint["subtitle"].trim() : "";
  if (title && subtitle && !title.includes(subtitle)) return `${title}, ${subtitle}`;
  return title || subtitle || null;
}

/**
 * Partida, paradas e destino entre os pontos da corrida. O `type` de cada ponto diz qual é qual;
 * como os valores dele não são documentados, sem um tipo reconhecido vale a ordem (o primeiro é a
 * partida, o último é o destino). Tudo o que sobra no meio é parada, na ordem em que a Uber manda —
 * inclusive pontos marcados como "desembarque" antes do último, que é como uma parada costuma vir.
 */
function routeAddresses(waypoints: unknown): Pick<UberTripSnapshot, "pickupAddress" | "destinationAddress" | "stopAddresses"> {
  const points = Array.isArray(waypoints) ? (waypoints.filter((w) => w && typeof w === "object") as Array<Record<string, unknown>>) : [];
  const typeOf = (point: Record<string, unknown>) => String(point["type"] ?? "");
  const pickup = points.find((p) => /pick|origin/i.test(typeOf(p))) ?? (points.length >= 2 ? points[0] : undefined);
  const lastDrop = points.findLast((p) => p !== pickup && /drop|dest/i.test(typeOf(p))) ?? (points.length >= 2 ? points[points.length - 1] : undefined);
  const destination = lastDrop === pickup ? undefined : lastDrop;

  // Só dá pra falar em "parada" quando se sabe onde a corrida começa ou termina
  const stops = pickup || destination ? points.filter((p) => p !== pickup && p !== destination) : [];
  return {
    pickupAddress: waypointAddress(pickup),
    destinationAddress: waypointAddress(destination),
    stopAddresses: stops.map(waypointAddress).filter((address): address is string => !!address),
  };
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
      pickupAddress: null,
      destinationAddress: null,
      stopAddresses: [],
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
    ...routeAddresses(trip["waypoints"]),
    tripExists: true,
  };
}

/**
 * Partida, paradas e destino em linhas prontas pra mandar ao cliente conferir, na ordem da rota.
 * Com mais de uma parada elas vão numeradas. Null se a Uber não informou partida nem destino.
 */
export function describeRoute(snapshot: UberTripSnapshot): string | null {
  if (!snapshot.pickupAddress && !snapshot.destinationAddress) return null;
  const stops = snapshot.stopAddresses ?? [];
  const lines = [
    snapshot.pickupAddress ? `📍 *Partida:* ${snapshot.pickupAddress}` : null,
    ...stops.map((address, i) => `🛑 *Parada${stops.length > 1 ? ` ${i + 1}` : ""}:* ${address}`),
    snapshot.destinationAddress ? `🏁 *Destino:* ${snapshot.destinationAddress}` : null,
  ].filter(Boolean);
  return lines.join("\n");
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

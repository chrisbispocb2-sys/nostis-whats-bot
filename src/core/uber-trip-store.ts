import { JsonFileStore } from "./base-store";
import type { RideChargeTrigger } from "./settings-store";
import type { UberTripPhase } from "./uber-trip";

/** O que precisa sobreviver a um reinício pra retomar uma corrida de onde parou, sem repetir aviso nem cobrança. */
export interface PersistedUberTrip {
  chatJid: string;
  shareToken: string;
  /** null = sem valor combinado: acompanha e avisa, mas não cobra sozinho. */
  agreedAmountCents: number | null;
  chargeTrigger: RideChargeTrigger;
  startedAt: number;
  phase: UberTripPhase;
  charged: boolean;
  lastPlate: string | null;
  /** Desde quando um pagamento do cliente conta como sendo desta corrida (ausente = desde que ela começou). */
  paymentSince?: number;
  /** Os endereços já foram mandados pro cliente conferir (ausente = corrida guardada antes de isso existir: não manda). */
  routeSent?: boolean;
}

export interface PersistedUberTrips {
  trips: PersistedUberTrip[];
  /** Conversa → quando saiu uma cobrança por uma corrida que ainda não embarcou. */
  unconsumedCharges: Record<string, number>;
}

/** Corridas da Uber em acompanhamento, guardadas em disco (ver `UberTripTrackerService.restore`). */
export class UberTripStore extends JsonFileStore<PersistedUberTrips> {
  constructor(file: string) {
    super(file, { trips: [], unconsumedCharges: {} });
    if (!Array.isArray(this.data.trips)) this.data.trips = [];
    if (!this.data.unconsumedCharges || typeof this.data.unconsumedCharges !== "object") this.data.unconsumedCharges = {};
  }

  read(): PersistedUberTrips {
    return this.data;
  }

  write(state: PersistedUberTrips): void {
    this.data = state;
    this.save();
  }
}

import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ChatMessageRecord } from "./chat-store";
import { logger } from "../utils/logger";

/** Mensagem mais velha que isso não é "chegou agora" (histórico entregue depois de reconectar). */
const MAX_MESSAGE_AGE_MS = 2 * 60_000;
/** Várias mensagens de uma vez tocam um bip só, não uma rajada. */
const MIN_GAP_MS = 1200;
const REMEMBERED_IDS = 500;

const SAMPLE_RATE = 44_100;
/** As duas notas do bip (as mesmas que o painel tocava): início e duração em segundos. */
const NOTES = [
  { freq: 880, start: 0, duration: 0.11 },
  { freq: 1318.51, start: 0.1, duration: 0.18 },
];

/** O bip de mensagem nova como um arquivo WAV (mono, 16 bits), gerado na hora — não precisa embutir áudio no programa. */
export function buildBeepWav(): Buffer {
  const attack = 0.015;
  const peak = 0.45;
  const total = Math.ceil(SAMPLE_RATE * (Math.max(...NOTES.map((n) => n.start + n.duration)) + 0.03));
  const data = Buffer.alloc(total * 2);

  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const note of NOTES) {
      const local = t - note.start;
      if (local < 0 || local > note.duration) continue;
      // sobe rápido e some suave, pra não dar estalo no começo nem no fim
      const gain = local < attack ? (local / attack) * peak : peak * Math.pow(0.0001 / peak, (local - attack) / (note.duration - attack));
      sample += Math.sin(2 * Math.PI * note.freq * local) * gain;
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); // tamanho do bloco de formato
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes por segundo
  header.writeUInt16LE(2, 32); // bytes por amostra
  header.writeUInt16LE(16, 34); // bits por amostra
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Quem toca o som de verdade (no Windows, um PowerShell escondido). Trocável nos testes. */
export interface SoundPlayer {
  play(): void;
  stop(): void;
}

export interface MessageSoundOptions {
  /** Onde o arquivo do bip é gravado (pasta temporária do programa). */
  wavFile: string;
  /** Só pra testes: no lugar do tocador de verdade. Devolver null = não dá pra tocar por aqui. */
  createPlayer?: (wavFile: string, onExit: () => void) => SoundPlayer | null;
  platform?: string;
}

/**
 * Tocador de verdade: um PowerShell escondido que fica vivo e toca o arquivo a cada linha que
 * recebe (abrir um PowerShell por bip levaria perto de um segundo). Fecha sozinho quando o
 * programa fecha, porque a entrada dele acaba.
 */
function createWindowsPlayer(wavFile: string, onExit: () => void): SoundPlayer | null {
  mkdirSync(dirname(wavFile), { recursive: true });
  writeFileSync(wavFile, buildBeepWav());

  const script = `$p = New-Object System.Media.SoundPlayer '${wavFile.replace(/'/g, "''")}'; $p.Load(); while ($null -ne [Console]::In.ReadLine()) { $p.Play() }`;
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  void proc.exited.then(onExit);

  return {
    play() {
      proc.stdin.write("1\n");
      proc.stdin.flush();
    },
    stop() {
      try {
        proc.stdin.end();
        proc.kill();
      } catch {
        // já tinha fechado
      }
    },
  };
}

/**
 * Som de mensagem nova tocado pelo próprio programa, e não pela janela do painel — assim toca com
 * a janela minimizada, escondida atrás de outras ou fechada (o navegador pausa a página nesses
 * casos, e o bip do painel não saía). Onde não dá pra tocar por aqui (fora do Windows, ou o
 * PowerShell não abriu), `available` fica falso e o painel continua tocando, como antes.
 */
export class MessageSound {
  private player: SoundPlayer | null = null;
  private failed = false;
  private lastSoundAt = 0;
  private readonly soundedIds = new Set<string>();

  constructor(private readonly options: MessageSoundOptions) {}

  /** O programa consegue tocar o som por conta própria? */
  get available(): boolean {
    return !this.failed && (this.options.createPlayer !== undefined || (this.options.platform ?? process.platform) === "win32");
  }

  /**
   * Avisa de uma mensagem gravada no histórico de uma conta com o som ligado. Só toca pra mensagem
   * que acabou de chegar de alguém: atualização de mensagem antiga (mídia baixada, status), reação,
   * aviso de grupo e mensagem sua não tocam; a mesma mensagem de grupo recebida por dois WhatsApp
   * seus toca uma vez só.
   */
  notify(message: Pick<ChatMessageRecord, "id" | "fromMe" | "type" | "timestamp">, isNew: boolean): void {
    if (!isNew || message.fromMe) return;
    if (message.type === "reaction" || message.type === "revoked" || message.type === "system") return;
    const now = Date.now();
    if (now - message.timestamp > MAX_MESSAGE_AGE_MS) return;
    if (this.soundedIds.has(message.id)) return;

    this.soundedIds.add(message.id);
    if (this.soundedIds.size > REMEMBERED_IDS) this.soundedIds.delete(this.soundedIds.values().next().value!);
    if (now - this.lastSoundAt < MIN_GAP_MS) return;
    this.lastSoundAt = now;
    this.play();
  }

  private play(): void {
    try {
      this.player ??= (this.options.createPlayer ?? createWindowsPlayer)(this.options.wavFile, () => this.onPlayerGone());
      if (!this.player) {
        this.failed = true;
        return;
      }
      this.player.play();
    } catch (err) {
      logger.warn({ err }, "Não consegui tocar o som de mensagem pelo programa: o painel volta a tocar");
      this.failed = true;
      this.player = null;
    }
  }

  /** O tocador fechou sozinho (PowerShell bloqueado, por exemplo): daqui pra frente o painel toca. */
  private onPlayerGone(): void {
    if (!this.player) return;
    this.player = null;
    this.failed = true;
    logger.warn("O tocador de som do programa fechou: o painel volta a tocar o som de mensagem");
  }

  stop(): void {
    const player = this.player;
    this.player = null;
    player?.stop();
  }
}

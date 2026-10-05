import { describe, expect, test } from "bun:test";
import { buildBeepWav, MessageSound } from "./message-sound";

function message(overrides: Partial<{ id: string; fromMe: boolean; type: "text" | "reaction" | "system" | "revoked" | "image"; timestamp: number }> = {}) {
  return { id: `M${Math.random()}`, fromMe: false, type: "text" as const, timestamp: Date.now(), ...overrides };
}

/** Tocador de mentira que só conta quantas vezes tocou. */
function fakeSound() {
  const state = { plays: 0, exit: () => {} };
  const sound = new MessageSound({
    wavFile: "nao-usado.wav",
    createPlayer: (_file, onExit) => {
      state.exit = onExit;
      return { play: () => state.plays++, stop: () => {} };
    },
  });
  return { sound, state };
}

describe("MessageSound (som de mensagem tocado pelo programa)", () => {
  test("toca pra mensagem que acabou de chegar de alguém", () => {
    const { sound, state } = fakeSound();
    sound.notify(message(), true);
    expect(state.plays).toBe(1);
  });

  test("não toca pra atualização de mensagem antiga, mensagem sua, reação, aviso de grupo, apagada nem histórico velho", () => {
    const { sound, state } = fakeSound();
    sound.notify(message(), false); // mídia que terminou de baixar, status de entrega...
    sound.notify(message({ fromMe: true }), true);
    sound.notify(message({ type: "reaction" }), true);
    sound.notify(message({ type: "system" }), true);
    sound.notify(message({ type: "revoked" }), true);
    sound.notify(message({ timestamp: Date.now() - 10 * 60_000 }), true);
    expect(state.plays).toBe(0);
  });

  test("a mesma mensagem (grupo em que dois WhatsApp seus estão) toca uma vez só; rajada de mensagens, um bip só", async () => {
    const { sound, state } = fakeSound();
    const same = message({ id: "MESMA" });
    sound.notify(same, true);
    sound.notify(same, true);
    sound.notify(message(), true); // outra mensagem logo em seguida: dentro do intervalo mínimo
    expect(state.plays).toBe(1);

    await Bun.sleep(1250);
    sound.notify(message(), true);
    expect(state.plays).toBe(2);
  });

  test("fora do Windows, ou se o tocador fechar sozinho, avisa que não toca por aqui (o painel assume)", () => {
    expect(new MessageSound({ wavFile: "x.wav", platform: "linux" }).available).toBe(false);
    expect(new MessageSound({ wavFile: "x.wav", platform: "win32" }).available).toBe(true);

    const { sound, state } = fakeSound();
    sound.notify(message(), true);
    expect(sound.available).toBe(true);
    state.exit(); // PowerShell bloqueado ou encerrado
    expect(sound.available).toBe(false);

    const semTocador = new MessageSound({ wavFile: "x.wav", createPlayer: () => null });
    semTocador.notify(message(), true);
    expect(semTocador.available).toBe(false);
  });

  test("o bip é um WAV válido (mono, 16 bits, 44,1 kHz) com som de verdade dentro", () => {
    const wav = buildBeepWav();
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);

    let loudest = 0;
    for (let i = 44; i < wav.length; i += 2) loudest = Math.max(loudest, Math.abs(wav.readInt16LE(i)));
    expect(loudest).toBeGreaterThan(8000);
    expect(loudest).toBeLessThanOrEqual(32767);
  });
});

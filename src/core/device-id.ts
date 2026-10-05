import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname } from "path";

/** O identificador que o próprio Windows dá a cada instalação (não muda ao reinstalar o programa). */
function windowsMachineGuid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const result = Bun.spawnSync(["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    return result.stdout.toString().match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Fora do Windows (ou se o registro não responder): um identificador sorteado uma vez e guardado. */
function storedFallbackId(file: string): string {
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf-8").trim();
      if (saved) return saved;
    }
    const fresh = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fresh, "utf-8");
    return fresh;
  } catch {
    return hostname();
  }
}

/**
 * Identificador deste computador pro servidor de licenças (cada conta de cliente vale num número
 * limitado de computadores). Vai embaralhado: o servidor só precisa saber se é o mesmo de antes.
 */
export function getDeviceId(fallbackFile: string): string {
  const raw = windowsMachineGuid() ?? storedFallbackId(fallbackFile);
  return createHash("sha256").update(`botbrinzy:${raw}`).digest("hex").slice(0, 32);
}

/** Nome do computador, só pra você reconhecer qual é no painel de administração. */
export function getDeviceName(): string {
  return hostname().slice(0, 60);
}

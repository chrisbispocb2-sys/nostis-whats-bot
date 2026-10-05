import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { LICENSE } from "../src/config/license";

const OUT_FILE = join("dist", "BotBrinzy.exe");

// Sem servidor de licenças configurado o exe sai em "modo local": as contas ficam no computador de
// quem roda, e a primeira conta criada ali vira administradora. O build não é barrado por isso (é
// assim que o programa funciona enquanto o servidor não está no ar) — só avisa, pra ninguém
// distribuir um exe desses achando que tem controle de acesso.
const hasLicenseServer = !!LICENSE.serverUrl && !!LICENSE.publicKey;
if (LICENSE.serverUrl && !LICENSE.publicKey) {
  console.error("src/config/license.ts tem serverUrl mas não tem publicKey: o exe não conseguiria conferir nenhuma licença. Preencha os dois (ou deixe os dois vazios).");
  process.exit(1);
}
if (hasLicenseServer && !LICENSE.serverUrl.startsWith("https://")) {
  console.warn("Atenção: o endereço do servidor de licenças não usa https — usuário e senha vão trafegar sem proteção.");
}

// O Windows costuma bloquear a edição de recursos (o ícone) de um exe gerado
// dentro da Desktop ("Failed to set Windows metadata: FailedToCommit"), então
// compila numa pasta temporária e só depois copia o exe pronto pra dist/.
const tmpDir = mkdtempSync(join(tmpdir(), "botbrinzy-build-"));
const tmpExe = join(tmpDir, "BotBrinzy.exe");

try {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "./src/index.ts",
      "--compile",
      "--minify",
      "--windows-icon=assets/icon.ico",
      "--outfile",
      tmpExe,
    ],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

  mkdirSync("dist", { recursive: true });
  copyFileSync(tmpExe, OUT_FILE);
  console.log(`Executável gerado em ${OUT_FILE}`);
  if (hasLicenseServer) {
    console.log(`Controle de acesso: servidor de licenças em ${LICENSE.serverUrl}`);
  } else {
    console.warn(
      "\nATENÇÃO: exe em MODO LOCAL (sem servidor de licenças). Quem abrir este exe cria a própria conta de\n" +
        "administrador, com tudo liberado e sem prazo. Antes de entregar a um cliente, configure\n" +
        "src/config/license.ts (serverUrl e publicKey) e gere de novo — veja o LEIA-ME.md."
    );
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

import { CONFIG } from "./config";
import { loadPrivateKey, publicKeyOf } from "./license-token";
import { createLicenseServer } from "./server";
import { openStores } from "./stores";

if (!CONFIG.privateKey) {
  console.error('Falta LICENSE_PRIVATE_KEY no .env. Gere um par de chaves com "bun run gerar-chaves".');
  process.exit(1);
}

const privateKey = loadPrivateKey(CONFIG.privateKey);
const stores = openStores();

if (stores.users.isEmpty()) {
  console.warn('Ainda não existe nenhuma conta. Crie o administrador com "bun run criar-admin <usuario> <senha>".');
}

Bun.serve({ port: CONFIG.port, fetch: createLicenseServer({ ...stores, privateKey }) });

console.log(`Servidor de licenças no ar na porta ${CONFIG.port} (dados em ${CONFIG.dataDir}).`);
console.log(`Chave pública (vai em app/src/config/license.ts): ${publicKeyOf(privateKey)}`);

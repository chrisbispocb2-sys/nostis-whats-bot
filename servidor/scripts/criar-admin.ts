import { openStores } from "../src/stores";
import { AuthError, featuresWith } from "../src/user-store";

// Cria uma conta de administrador direto nos dados do servidor. É o único jeito de criar a primeira
// conta: o servidor não tem tela de cadastro aberta (as demais contas entram por convite).
const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Uso: bun run criar-admin <usuario> <senha>");
  process.exit(1);
}

try {
  const user = openStores().users.create(username, password, "admin", featuresWith(true));
  console.log(`Administrador "${user.username}" criado. Entre com ele no programa.`);
} catch (err) {
  console.error(err instanceof AuthError ? err.message : err);
  process.exit(1);
}

/**
 * Processo de produção: webhook do WhatsApp + laço de processamento (eventos, IA, envios).
 *   npm start
 * Exige SIMULATION_MODE=false e as variáveis do WhatsApp (ver .env.example).
 */
import { montarAplicacao } from "./app.js";
import { carregarAmbiente } from "./config/env.js";
import { migrar } from "./db/migrar.js";
import { iniciarTrabalhador } from "./nucleo/eventos.js";
import { criarServidor } from "./servidor.js";

const env = carregarAmbiente();
if (env.SIMULATION_MODE) {
  console.error("npm start atende o WhatsApp real e exige SIMULATION_MODE=false. Para testar localmente, use npm run sim.");
  process.exit(1);
}
const app = montarAplicacao({ env });
const { deps, whatsapp } = app;
if (!whatsapp) throw new Error("Configuração do WhatsApp ausente.");

await migrar(deps.pool);
const trabalhador = iniciarTrabalhador(deps, whatsapp.idNumero);
const servidor = criarServidor(deps, whatsapp, () => trabalhador.acordar());
await servidor.listen({ port: env.PORT, host: "0.0.0.0" });
deps.log.info("Bot Tia Nane no ar", {
  porta: env.PORT,
  webhook: `${env.PUBLIC_BASE_URL}/webhook/whatsapp`,
  ia: deps.agente ? deps.agente.modelo : "desligada (só menus)",
});

let encerrando = false;
for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, async () => {
    if (encerrando) return;
    encerrando = true;
    deps.log.info("encerrando…");
    await servidor.close();
    await trabalhador.parar();
    await app.encerrar();
    process.exit(0);
  });
}

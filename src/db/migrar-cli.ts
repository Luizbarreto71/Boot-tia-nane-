import { carregarAmbiente } from "../config/env.js";
import { migrar } from "./migrar.js";
import { criarPool } from "./pool.js";

const env = carregarAmbiente();
const pool = criarPool(env.DATABASE_URL, 1);
try {
  const aplicadas = await migrar(pool);
  console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(", ")}` : "Banco já está atualizado.");
} finally {
  await pool.end();
}

import { migrar } from "../../src/db/migrar.js";
import { criarPool } from "../../src/db/pool.js";
import { URL_TESTE } from "../apoio/integracao.js";

/** Recria o esquema do banco de teste do zero e aplica todas as migrações. */
export default async function preparar() {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(URL_TESTE) || !/_test$/.test(new URL(URL_TESTE).pathname)) {
    throw new Error(`Testes de integração só rodam em banco local *_test (recebido: ${new URL(URL_TESTE).host}).`);
  }
  const pool = criarPool(URL_TESTE, 1);
  try {
    await pool.query("drop schema if exists public cascade; create schema public;");
    await migrar(pool);
  } catch (e) {
    throw new Error(`Banco de teste indisponível. Rode "npm run db:start". Detalhe: ${(e as Error).message}`);
  } finally {
    await pool.end();
  }
}

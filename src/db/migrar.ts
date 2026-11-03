import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool.js";

const PASTA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const TRAVA = 7_171_001;

/** Aplica migrations/NNN_*.sql em ordem, cada uma em sua transação. Retorna as versões aplicadas agora. */
export async function migrar(pool: Pool): Promise<string[]> {
  const cliente = await pool.connect();
  const aplicadas: string[] = [];
  try {
    await cliente.query("select pg_advisory_lock($1)", [TRAVA]);
    await cliente.query(
      "create table if not exists schema_migrations (versao text primary key, aplicada_em timestamptz not null default now())",
    );
    const { rows } = await cliente.query<{ versao: string }>("select versao from schema_migrations");
    const feitas = new Set(rows.map((r) => r.versao));
    const arquivos = readdirSync(PASTA)
      .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
      .sort();
    for (const arquivo of arquivos) {
      const versao = arquivo.replace(/\.sql$/, "");
      if (feitas.has(versao)) continue;
      await cliente.query("begin");
      try {
        await cliente.query(readFileSync(path.join(PASTA, arquivo), "utf8"));
        await cliente.query("insert into schema_migrations (versao) values ($1)", [versao]);
        await cliente.query("commit");
        aplicadas.push(versao);
      } catch (e) {
        await cliente.query("rollback");
        throw new Error(`Falha na migração ${arquivo}: ${(e as Error).message}`);
      }
    }
    return aplicadas;
  } finally {
    await cliente.query("select pg_advisory_unlock($1)", [TRAVA]).catch(() => undefined);
    cliente.release();
  }
}

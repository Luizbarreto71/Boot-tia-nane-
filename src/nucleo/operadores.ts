import type { Pool } from "../db/pool.js";

export interface NovoOperador {
  chave: string;
  nome: string;
  papel: "admin" | "atendente";
  demonstrativo?: boolean;
}

/** Cria o operador se a chave ainda não existir; não altera um operador existente. */
export async function garantirOperador(pool: Pool, o: NovoOperador): Promise<string> {
  await pool.query(
    `insert into operadores (chave, nome, papel, demonstrativo) values ($1, $2, $3, $4)
     on conflict (chave) do nothing`,
    [o.chave, o.nome, o.papel, o.demonstrativo ?? false],
  );
  const r = await pool.query<{ id: string }>("select id from operadores where chave = $1", [o.chave]);
  return r.rows[0]!.id;
}

export async function buscarOperadorPorChave(pool: Pool, chave: string) {
  const r = await pool.query<{ id: string; nome: string; papel: string; ativo: boolean }>(
    "select id, nome, papel, ativo from operadores where chave = $1",
    [chave],
  );
  return r.rows[0] ?? null;
}

/** Operadores fictícios para a simulação com a configuração demonstrativa. */
export async function garantirOperadoresDemo(pool: Pool): Promise<void> {
  await garantirOperador(pool, { chave: "janiere", nome: "Janiere (demonstrativo)", papel: "admin", demonstrativo: true });
  await garantirOperador(pool, { chave: "atendente-demo", nome: "Atendente (demonstrativo)", papel: "atendente", demonstrativo: true });
}

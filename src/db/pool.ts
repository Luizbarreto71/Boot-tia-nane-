import pg from "pg";

export type Pool = pg.Pool;
export type Cliente = pg.PoolClient;

/** Sessões sempre em UTC; o fuso de negócio é aplicado no código. */
export function criarPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max, options: "-c timezone=UTC" });
}

export async function emTransacao<T>(pool: Pool, fn: (c: Cliente) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    const r = await fn(cliente);
    await cliente.query("commit");
    return r;
  } catch (e) {
    await cliente.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    cliente.release();
  }
}

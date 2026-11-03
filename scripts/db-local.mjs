#!/usr/bin/env node
/**
 * PostgreSQL local para desenvolvimento e testes — NÃO usar em produção.
 *
 *   node scripts/db-local.mjs start|stop|status|reset
 *
 * Cria um cluster próprio em .local-pg/ (porta LOCAL_PG_PORT, padrão 54400), com autenticação
 * trust apenas em localhost, e os bancos tia_nane e tia_nane_test.
 * Binários: PG_BIN (pasta com initdb/pg_ctl/psql) ou o PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

const raiz = process.cwd();
const dados = path.join(raiz, ".local-pg", "data");
const logFile = path.join(raiz, ".local-pg", "postgres.log");
const porta = String(process.env.LOCAL_PG_PORT || 54400);
const pgBin = process.env.PG_BIN || "";
const bin = (nome) => (pgBin ? path.join(pgBin, process.platform === "win32" ? `${nome}.exe` : nome) : nome);
const bancos = ["tia_nane", "tia_nane_test"];

function run(cmd, args, opts = {}) {
  const r = spawnSync(bin(cmd), args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message} (defina PG_BIN com a pasta dos binários do PostgreSQL)`);
  if (r.status !== 0 && !opts.permitirFalha) {
    console.error(r.stdout ?? "", r.stderr ?? "");
    throw new Error(`${cmd} ${args.join(" ")} falhou`);
  }
  return r;
}

const rodando = () => run("pg_ctl", ["-D", dados, "status"], { permitirFalha: true }).status === 0;

function start() {
  if (!existsSync(path.join(dados, "PG_VERSION"))) {
    mkdirSync(path.dirname(dados), { recursive: true });
    console.log("• initdb");
    run("initdb", ["-D", dados, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
  }
  if (!rodando()) {
    console.log(`• iniciando PostgreSQL na porta ${porta}`);
    // stdio não pode ficar em pipe: o postmaster herda e o spawnSync nunca retornaria
    run("pg_ctl", ["-D", dados, "-l", logFile, "-w", "-o", `-p ${porta} -c listen_addresses=localhost -c timezone=UTC`, "start"], {
      stdio: "ignore",
    });
  }
  for (const banco of bancos) {
    const existe = run("psql", ["-h", "localhost", "-p", porta, "-U", "postgres", "-tAc", `select 1 from pg_database where datname='${banco}'`])
      .stdout.trim();
    if (existe !== "1") {
      console.log(`• criando banco ${banco}`);
      run("createdb", ["-h", "localhost", "-p", porta, "-U", "postgres", banco]);
    }
  }
  console.log(`PostgreSQL local pronto: postgres://postgres@localhost:${porta}/tia_nane`);
}

function stop() {
  if (rodando()) run("pg_ctl", ["-D", dados, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  console.log("PostgreSQL local parado");
}

const comando = process.argv[2];
if (comando === "start") start();
else if (comando === "stop") stop();
else if (comando === "status") console.log(rodando() ? `rodando (porta ${porta})` : "parado");
else if (comando === "reset") {
  stop();
  rmSync(path.join(raiz, ".local-pg"), { recursive: true, force: true });
  start();
} else {
  console.error("uso: node scripts/db-local.mjs start|stop|status|reset");
  process.exit(1);
}

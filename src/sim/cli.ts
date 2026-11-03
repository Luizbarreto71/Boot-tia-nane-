/**
 * Simulador de conversa — roda o mesmo núcleo, grava no banco e NÃO envia nada a provedores.
 *
 *   npm run sim                                  conversa interativa (contato padrão)
 *   npm run sim -- --contato sim-5511999990001   outro contato (cada um tem sua conversa)
 *   npm run sim -- --canal canal_proprio         perfil hipotético com o menu completo de 7 opções
 *   npm run sim -- --roteiro roteiros/nutricao.txt
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { montarAplicacao } from "../app.js";
import type { EnvioSaida } from "../canais/tipos.js";
import { carregarAmbiente } from "../config/env.js";
import { migrar } from "../db/migrar.js";
import { perfilDoCanal, modulosVisiveis, type CanalId } from "../dominio/elegibilidade.js";
import { assumirAtendimento, devolverAoBot, responderComoOperador } from "../nucleo/atendimento.js";
import { buscarOperadorPorChave, garantirOperadoresDemo } from "../nucleo/operadores.js";
import { receberMensagem, type MensagemRecebida } from "../nucleo/recebimento.js";

const { values: args } = parseArgs({
  options: {
    canal: { type: "string", default: "whatsapp" },
    contato: { type: "string", default: "sim-5500000000001" },
    roteiro: { type: "string" },
  },
});

const canal = args.canal as CanalId;
const perfil = perfilDoCanal(canal);
const contatoExterno = args.contato!;
let deslocamentoMs = 0;
const relogio = () => new Date(Date.now() + deslocamentoMs);

const recuo = (texto: string) => texto.replace(/\n/g, "\n       ");
const ROTULO = { motor: "bot (menu)", ia: "bot (IA)  ", operador: "equipe    " } as const;
const imprimirBot = (e: EnvioSaida) => {
  const linhas = [e.texto, ...e.opcoes.map((o) => `${o.numero}. ${o.rotulo}   ⟨${o.id}⟩`)];
  console.log(`${ROTULO[e.origem]} › [SIMULADO] ${recuo(linhas.join("\n"))}`);
};

const env = carregarAmbiente();
if (!env.SIMULATION_MODE) {
  console.error("O simulador exige SIMULATION_MODE=true.");
  process.exit(1);
}
const app = montarAplicacao({ env, relogio, aoEnviarSimulado: imprimirBot });
const { deps } = app;
const pool = deps.pool;

const aplicadas = await migrar(pool);
if (aplicadas.length) console.log(`(migrações aplicadas: ${aplicadas.join(", ")})`);
if (deps.negocio.demonstrativo) await garantirOperadoresDemo(pool);

console.log("═".repeat(72));
console.log(" MODO SIMULAÇÃO — nenhuma mensagem real é enviada");
console.log(` Perfil de canal: ${perfil.nome}`);
console.log(` Menu neste canal: ${modulosVisiveis(perfil, deps.negocio).join(", ")}`);
console.log(` Contato simulado: ${contatoExterno}`);
console.log(` Configuração: ${env.BUSINESS_CONFIG_PATH}${deps.negocio.demonstrativo ? "  [DADOS DEMONSTRATIVOS]" : ""}`);
console.log(
  ` IA: ${deps.agente ? `${deps.agente.modelo} (chamadas reais à API da Anthropic)` : "desligada — defina ANTHROPIC_API_KEY no .env para o bot responder com IA"}`,
);
console.log(" Digite como se fosse o contato. /ajuda lista os comandos da simulação.");
console.log("═".repeat(72));

let operadorChave = "janiere";
let ultimoEvento: MensagemRecebida | null = null;

async function conversaId(): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    "select cv.id from conversas cv join contatos ct on ct.id = cv.contato_id where ct.canal = $1 and ct.id_externo = $2",
    [canal, contatoExterno],
  );
  return r.rows[0]?.id ?? null;
}

async function enviarComoContato(conteudo: MensagemRecebida["conteudo"], idProvedor = `sim-entrada-${randomUUID()}`) {
  ultimoEvento = { canal, contatoExterno, idProvedor, recebidaEm: relogio(), conteudo };
  const r = await receberMensagem(deps, ultimoEvento);
  if (r.status === "duplicada") console.log("       (evento repetido: ignorado pela deduplicação, nenhuma resposta)");
  if (r.status === "pausada") console.log("       (automação pausada: mensagem registrada para a equipe, sem resposta automática)");
}

async function operador() {
  const op = await buscarOperadorPorChave(pool, operadorChave);
  if (!op) throw new Error(`Operador "${operadorChave}" não existe.`);
  return op;
}

async function exigirConversa() {
  const id = await conversaId();
  if (!id) throw new Error("Este contato ainda não tem conversa — mande uma mensagem primeiro.");
  return id;
}

async function mostrarEstado() {
  const r = await pool.query(
    `select ct.nome, ct.etapa_comercial, cv.controle, cv.estado, cv.versao, cv.ultima_mensagem_contato_em,
            (select status from atendimentos a where a.conversa_id = cv.id order by solicitado_em desc limit 1) as atendimento,
            (select status from consentimentos k where k.contato_id = ct.id and finalidade = 'acompanhamento'
              order by registrado_em desc limit 1) as consentimento_acompanhamento
     from conversas cv join contatos ct on ct.id = cv.contato_id where ct.canal = $1 and ct.id_externo = $2`,
    [canal, contatoExterno],
  );
  console.log(r.rows[0] ? JSON.stringify(r.rows[0], null, 2) : "(sem conversa ainda)");
}

async function mostrarEquipe() {
  const id = await conversaId();
  const r = await pool.query(
    "select tipo, dados, criada_em from notificacoes_equipe where conversa_id = $1 order by criada_em desc limit 10",
    [id],
  );
  if (!r.rows.length) return console.log("(nenhum aviso para a equipe)");
  for (const n of r.rows) console.log(`  • ${n.tipo}  ${JSON.stringify(n.dados)}`);
}

const AJUDA = `Comandos da simulação (o contato não vê):
  /acao <id>          envia a seleção de uma lista interativa (ex.: /acao p3:1)
  /repetir            reenvia o último evento com o MESMO id do provedor (teste de deduplicação)
  /estado             estado persistido da conversa
  /equipe             avisos gerados para a equipe
  /operador <chave>   escolhe quem age como equipe (padrão: janiere; outro: atendente-demo)
  /assumir            o operador assume o atendimento
  /responder <texto>  o operador responde (passa pela política de envio)
  /devolver [nota]    devolve a conversa ao bot
  /tempo +25h | +30m  avança o relógio simulado
  /encerrar           sai do simulador`;

async function comandoSimulacao(linha: string) {
  const [cmd = "", ...resto] = linha.slice(1).split(" ");
  const arg = resto.join(" ").trim();
  switch (cmd) {
    case "ajuda":
      return console.log(AJUDA);
    case "acao":
      return enviarComoContato({ tipo: "acao", id: arg });
    case "repetir":
      if (!ultimoEvento) return console.log("(nenhum evento ainda)");
      console.log(`       (reenviando evento ${ultimoEvento.idProvedor})`);
      return enviarComoContato(ultimoEvento.conteudo, ultimoEvento.idProvedor);
    case "estado":
      return mostrarEstado();
    case "equipe":
      return mostrarEquipe();
    case "operador":
      operadorChave = arg || "janiere";
      return console.log(`(operador atual: ${operadorChave})`);
    case "assumir": {
      const op = await operador();
      await assumirAtendimento(deps, { conversaId: await exigirConversa(), operadorId: op.id });
      return console.log(`equipe › ${op.nome} assumiu o atendimento.`);
    }
    case "responder": {
      const op = await operador();
      console.log(`equipe › ${op.nome} tenta responder: ${arg}`);
      await responderComoOperador(deps, { conversaId: await exigirConversa(), operadorId: op.id, texto: arg });
      return;
    }
    case "devolver": {
      const op = await operador();
      await devolverAoBot(deps, { conversaId: await exigirConversa(), operadorId: op.id, resultado: arg || undefined });
      return console.log(`equipe › ${op.nome} devolveu a conversa ao bot.`);
    }
    case "tempo": {
      const m = /^\+(\d+)(h|m)$/.exec(arg);
      if (!m) return console.log("uso: /tempo +25h ou /tempo +30m");
      deslocamentoMs += Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
      return console.log(`(relógio simulado: ${relogio().toISOString()})`);
    }
    default:
      return console.log(`(comando desconhecido: /${cmd}; veja /ajuda)`);
  }
}

async function processarLinha(linha: string): Promise<boolean> {
  const texto = linha.trim();
  if (!texto) return true;
  if (texto === "/encerrar") return false;
  try {
    if (texto.startsWith("/")) await comandoSimulacao(texto);
    else await enviarComoContato({ tipo: "texto", texto });
  } catch (e) {
    console.log(`  ⚠ ${(e as Error).name}: ${(e as Error).message}`);
  }
  return true;
}

try {
  if (args.roteiro) {
    let anteriorComentario = false;
    for (const linha of readFileSync(args.roteiro, "utf8").split(/\r?\n/)) {
      if (linha.startsWith("#")) {
        console.log(anteriorComentario ? linha : `\n${linha}`);
        anteriorComentario = true;
        continue;
      }
      if (!linha.trim()) continue;
      anteriorComentario = false;
      console.log(linha.startsWith("/") ? `sim  › ${linha}` : `você › ${linha}`);
      if (!(await processarLinha(linha))) break;
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "você › " });
    rl.prompt();
    for await (const linha of rl) {
      if (!(await processarLinha(linha))) break;
      rl.prompt();
    }
    rl.close();
  }
} finally {
  await app.encerrar();
}

/**
 * Logger JSON em uma linha, com mascaramento de credenciais: chaves com nomes sensíveis
 * e qualquer valor registrado como segredo são substituídos antes de escrever.
 */
export type Nivel = "debug" | "info" | "warn" | "error";
const ORDEM: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CHAVE_SENSIVEL = /(token|secret|segredo|senha|password|api[_-]?key|authorization|database_url|connection)/i;
export const MASCARA = "[oculto]";

export interface Logger {
  debug(msg: string, dados?: unknown): void;
  info(msg: string, dados?: unknown): void;
  warn(msg: string, dados?: unknown): void;
  error(msg: string, dados?: unknown): void;
}

export function criarLogger(opcoes: {
  nivel?: Nivel;
  segredos?: (string | undefined)[];
  escrever?: (linha: string) => void;
}): Logger {
  const minimo = ORDEM[opcoes.nivel ?? "info"];
  const segredos = (opcoes.segredos ?? []).filter((s): s is string => typeof s === "string" && s.length >= 6);
  const escrever = opcoes.escrever ?? ((linha) => process.stderr.write(`${linha}\n`));

  const limparTexto = (s: string) => segredos.reduce((acc, seg) => acc.split(seg).join(MASCARA), s);
  const limpar = (v: unknown, profundidade = 0): unknown => {
    if (profundidade > 6) return "[profundo]";
    if (typeof v === "string") return limparTexto(v);
    if (v instanceof Error) return { nome: v.name, mensagem: limparTexto(v.message) };
    if (Array.isArray(v)) return v.map((x) => limpar(x, profundidade + 1));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, CHAVE_SENSIVEL.test(k) ? MASCARA : limpar(x, profundidade + 1)]),
      );
    }
    return v;
  };

  const log = (nivel: Nivel) => (msg: string, dados?: unknown) => {
    if (ORDEM[nivel] < minimo) return;
    const registro: Record<string, unknown> = { t: new Date().toISOString(), nivel, msg: limparTexto(msg) };
    if (dados !== undefined) registro.dados = limpar(dados);
    escrever(JSON.stringify(registro));
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

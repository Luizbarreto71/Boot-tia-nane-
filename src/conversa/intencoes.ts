import type { ModuloId } from "../dominio/modulos.js";
import { avaliarModulo, type PerfilCanal, type RestricoesNegocio } from "../dominio/elegibilidade.js";

/**
 * Interpretação determinística de texto livre por palavras-chave (texto já normalizado).
 * Cobre os casos claros; a interpretação por IA entra na etapa 3 como reforço, sempre depois
 * deste roteador e sujeita às mesmas regras de canal.
 */
const PALAVRAS: Record<Exclude<ModuloId, "falar_janiere">, RegExp[]> = {
  nutricao: [
    /\bnutri\w*/,
    /\bdietas?\b/,
    /\bemagrec\w*/,
    /\balimenta\w*/,
    /\bperder peso\b/,
    /\bcardapio\b/,
    /\bplano alimentar\b/,
    /\breeducacao alimentar\b/,
  ],
  personal: [
    /\bpersonal\b/,
    /\btreinos?\b/,
    /\btreinar\b/,
    /\btreinamento\b/,
    /\bacademia\b/,
    /\bmusculacao\b/,
    /\bexercicios?\b/,
    /\bhipertrofia\b/,
    /\bganhar massa\b/,
  ],
  produtos: [/\bprodutos?\b/, /\bshakes?\b/, /\bcha\b/, /\bcatalogo\b/, /\bsuplement\w*/, /\bherbalife\b/],
  renda_extra: [/\brenda\b/, /\bganhar dinheiro\b/, /\boportunidade\b/, /\bnegocios?\b/, /\btrabalhar (com|de casa|em casa)\b/],
  distribuidor: [
    /\bdistribuid\w*/,
    /\brevend\w*/,
    /\brevender\b/,
    /\bconsultor\w* herbalife\b/,
    /\b(cadastro|cadastrar) (na|da|como|pela) herbalife\b/,
    /\bherbalife\b/,
  ],
  equipe: [
    /\b(minha|meu|montar|crescer|desenvolver|formar|liderar)( a| o| uma| um)? (equipe|time|rede)\b/,
    /\broyalt\w*/,
    /\brecrut\w*/,
    /\bdownline\b/,
    /\blinha descendente\b/,
    /\bpatrocin\w*/,
  ],
};

export function detectarModulos(n: string): ModuloId[] {
  return (Object.keys(PALAVRAS) as (keyof typeof PALAVRAS)[]).filter((m) => PALAVRAS[m].some((r) => r.test(n)));
}

/** Temas do texto que este canal não permite (usado em texto livre, assunto do handoff e respostas humanas). */
export function temasNaoPermitidos(n: string, perfil: PerfilCanal, negocio: RestricoesNegocio): ModuloId[] {
  return detectarModulos(n).filter((m) => !avaliarModulo(perfil, negocio, m).permitido);
}

const SAUDACAO = /^(oi+|ola|opa|eai|e ai|hey|hello|bom dia|boa tarde|boa noite|tudo bem|tudo bom|salve)( (tudo bem|tudo bom|como vai|janiere|nane))*$/;
const AGRADECIMENTO = /^(muito )?(obrigad[oa]|brigad[oa]|valeu|agradeco|grat[oa])( (mesmo|demais|viu))*$/;

export const ehSaudacao = (n: string) => SAUDACAO.test(n);
export const ehAgradecimento = (n: string) => AGRADECIMENTO.test(n);

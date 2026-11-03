-- Ordem de chegada dos eventos do webhook: dois eventos no mesmo instante são processados na ordem em que chegaram.
alter table eventos_recebidos add column ordem bigint generated always as identity;
create index eventos_ordem_idx on eventos_recebidos (ordem) where status = 'pendente';

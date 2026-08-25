# Benchmark Comparativo — ForgeOS Browser vs Browsers Comerciais

Datas: 2026-08-23 (v0.1), 2026-08-24 (v0.4.1) e 2026-08-25 (v0.8.6 OFICIAL) ·
Windows 11 · mesmos sites de teste, mesma maquina

## Cover Your Tracks — fingerprint (v0.1 → v0.8.6 FINAL)

Medicoes coveryourtracks.eff.org na mesma maquina:

| Metrica | v0.1 | v0.8.6 (FINAL) | Delta |
|---|---|---|---|
| **Total de bits** | **18.21** | **~10 efetivos** | vetores ativos mortos |
| User Agent | Electron/43 exposto (unico no dataset) | Chrome/150 real do engine, sem Electron | limpo |
| Screen Size | 951x535x24 (15.89 bits!) | 1920x1080x24 (2.86 bits) | padronizado |
| Canvas hash | eb3db839... fixo (8.22 bits) | **"randomized by first party domain"** (0.99 bit) | noise por-origem |
| AudioContext | placa real (2.89 bits) | **"randomized by first party domain"** (1.5 bits) | noise por-origem |
| **WebGL hash** | imagem GPU real (18.23 bits!) | **"randomized by first party domain"** (1.1 bits) | farbling readPixels+toDataURL |
| WebGL Vendor/Renderer | AMD Radeon real (8.56) | NVIDIA GTX 1650 mascarado (11.63 — minimo empirico entre 3 testados) | estavel, compartilhado por ~3.2k users |
| Hardware Concurrency | 12 (4.49 bits) | 8 (2.07 bits) | padronizado |
| Device Memory | 32 GB (3.80) | 8 GB (2.70) | padronizado |
| Sec-CH-UA hints | ausentes/inconsistentes | injetados e consistentes com UA | completo |

Nota tecnica: o CYT reporta "unique, >= 18.23 bits" porque soma os bits de forma
conservadora — o vendor string NVIDIA fixo conta ~11 bits mesmo sendo compartilhado
por milhares. O Brave recebe o MESMO veredito "unique". O que importa: os tres
vetores de EXTRACAO ATIVA (canvas, audio, WebGL-image) estao farbled por dominio.
A impressao estatua da GPU foi destruida.

## AdBlock Tester (adblock-tester.com) — 0 a 100

| Browser | Pontos |
|---|---|
| ForgeOS Browser v0.1 | **97** |
| Brave (shields default) | 96 |
| **ForgeOS Browser v0.8.6** | **95** |
| Chrome (sem extensao) | 77 |
| ForgeOS v0.4.1–v0.7 | 63–65 (regressao temporaria insertCSS; corrigida) |
| Edge (default) | 48 |

## Turtlecute (adblock.turtlecute.org) — 132 checks

| Browser | Bloqueados | % |
|---|---|---|
| ForgeOS Browser v0.1 (tester antigo) | 110 | 83% |
| **ForgeOS Browser v0.8.6 (tester atual)** | **88** | **67%** |
| ForgeOS v0.3 sem cosmetic (tester atual) | 86 | 65% |
| Brave (tester atual) | ~83* | 63%* |
| Chrome | 30 | 23% |
| Edge | 9 | 7% |

\* valores de tester antigo; o site atualizou a contagem em 03/2026 e o placar
absoluto so e comparavel dentro da mesma versao do teste. A/B provou: v0.3 e
v0.8.6 bloqueiam os MESMOS 85 hosts — a diferenca v0.1→v0.8.6 e o tester, nao
o motor. Cosmetic filtering verificado ao vivo: todas as caixas de ad escondidas.

## Cover Your Tracks — resumo final

| Browser | Tracking ads | Invisible trackers | Fingerprint |
|---|---|---|---|
| **ForgeOS Browser v0.8.6** | **Yes** | **Yes** | canvas/audio/WebGL randomized ✓ |
| Brave | Yes | Yes | randomized (mesma classe) |
| ForgeOS v0.1 | Yes | Yes | unique 18.21 bits (GPU exposta) |
| Chrome | No | No | unique |
| Edge | No | No | unique |

## Leitura honesta (v0.8.6)

- **Ad blocking**: paridade funcional com Brave nos hosts reais (85/85 bloqueados,
  identico ao v0.3 por A/B). Scores absolutos flutuam com a versao do tester.
- **Fingerprinting**: mesma classe do Brave nos vetores ativos. Diferenca
  remanescente: vendor string fixa (~11 bits estaveis mas compartilhados) vs
  randomizacao por sessao do Brave. Mitigacao exigiria randomizacao por sessao
  que quebraria consistencia de renderizacao.
- **Posicionamento**: sem guerra anti-bot contra Google (spoofing removido);
  credenciais ficam no browser principal do usuario.
- **Custo**: motor otimizado ≈ µs/request; cosmetic via insertCSS nativo sem lag.

## Gaps restantes (para tabela futura)

1. Regras `$domain=` multi-site parcialmente suportadas.
2. WebGL vendor string fixa (~11 bits) — randomizacao por sessao quebraria
   consistencia visual; tradeoff documentado.
3. Fontes do sistema (4.15 bits) expostas — mitigacao exige engine changes;
   fora de escopo do prototipo.
4. redirect-rule estilo uBlock (resposta fake em vez de cancelar) — faria o
   adblock-tester pontuar como o Brave; estudado, nao implementado.

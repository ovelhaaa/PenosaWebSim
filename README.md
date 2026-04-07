# Penosa Desktop Sim

Simulador desktop da Penosa para PC, feito em HTML/CSS/JavaScript.

## O que ele replica

- Algoritmo euclidiano da Penosa com a mesma logica de `steps`, `hits`, `rotation` e `auto-rotate downbeat`
- Visualizacao concentrica dos circulos no estilo do display
- BassGroove com `density`, `bassProb` (probabilidade de tocar), `range`, `scale` e `root`
- Ghost Notes com controle de probabilidade global (afeta SNARE, HATS, CRASH)
- Slots de preset com persistencia em `localStorage`
- Audio via WebAudio com sintese mais proxima das vozes do firmware (`KickVoice`, `SnareVoice`, `HatsVoice`, `BassVoice`)
- Laboratorio de algoritmo com seed deterministica, step manual, export/import de estado e debug do `BassGroove`
- Edicao de voz por track com controles de tune, decay, timbre, drive, snap, harmonics e modo de snare

## Como rodar

Opcao 1:

- Abra `index.html` diretamente no navegador

Opcao 2:

```powershell
cd "C:\Users\devx\Documents\PlatformIO\Projects\Penosa DM\desktop-penosa-sim"
python -m http.server 8080
```

Depois abra:

- [http://localhost:8080](http://localhost:8080)

## Controles

- `Space`: play/stop
- `Right Arrow`: avanca um step quando o transporte estiver parado
- `1..5`: troca de track
- `Play`: inicia o transporte
- `Step`: executa um tick manual do algoritmo
- `Randomize`: varia os pads euclidianos
- `Apply Seed`: fixa a seed para reproduzir variacoes e testes
- `Export/Import State`: salva e restaura snapshots completos do experimento
- `Save Slot`: salva o estado atual no slot selecionado
- `Voice DSP`: edita a sintese da track selecionada

## Observacoes

- O audio aqui ainda e uma aproximacao desktop, mas agora segue mais de perto as formulas e envelopes do firmware ESP32.
- A visualizacao foi portada da logica do `drawPerformanceView()` da Penosa.
- O painel `Debug` mostra a ultima decisao do baixo, o log recente de eventos e os pads euclidianos com `steps/hits/rotation`.

## UI Identity CYD

### Fonte unica de tokens

- O projeto usa `ui-tokens.js` como fonte unica de identidade visual (paleta, espacamento, tipografia e estados de interface).
- `styles.css` deve consumir apenas variaveis CSS (`--bg`, `--green`, `--state-active-bg`, etc.) geradas a partir desses tokens.
- `app.js` deve ler `window.UI_TOKENS` para desenhar o canvas com as mesmas cores sem duplicar hex em componentes novos.

### Cores por funcao

- **Base/superficie**: `bg`, `panel`, `panelAlt`, `line`.
- **Texto**: `text` (principal) e `dim` (secundario/hints).
- **Acoes**: `accentCyan` para foco/selecao e chamada primaria.
- **Sucesso/atividade**: `accentGreen` para elemento ativo em execucao.
- **Erro/mute**: `accentRed` para estado mutado, perigo e alertas de bloqueio.
- **Warning**: usar `state.warning` para avisos temporarios sem semantica de erro.

### Estados padrao

- `active`: destaque de foco/navegacao e botoes selecionados.
- `muted`: feedback visual de mudo/inativo por intencao.
- `warning`: feedback de atencao (ex.: acao irreversivel, parametro limite).

### Abreviacoes permitidas

- Labels curtos podem usar: `Perf`, `Trk`, `Stp`, `Hit`, `Rot`, `Dens`, `Rnge`, `Scl`, `Trns`, `Vce`, `Exp`, `Imp`, `Pnc`.
- Evitar novas abreviacoes sem necessidade; quando adicionar, manter padrao de 3-5 caracteres e caixa alta no canvas.

### Navegacao por paginas

- Ordem oficial de paginas: `performance -> track -> bass -> voice -> slots -> lab`.
- O fluxo de `BK` (back) sempre retorna para `performance`.
- Cada pagina deve manter hint de input no rodape (`PAGE_HINTS`) com o mesmo formato visual e sem mudar atalhos globais (`SPC RUN/STOP · TRK 1-5`).

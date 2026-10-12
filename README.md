# Asset Maker — Workflows de IA com nodes gráficos

Editor visual de workflows (estilo n8n / Langflow / ComfyUI) para **geração e edição de imagens**, **imagem → modelo 3D**, **texto → fala com modelos locais** e **texto com o Claude Code local (`claude -p`)**, feito em HTML/CSS/JS puro, sem build. Interface em estilo glass: canvas em tela cheia com painéis de vidro flutuantes.

## Como rodar

Recomendado: dê dois cliques em **`iniciar-editor.bat`** ou rode

```bash
python serve.py --open
```

> **“Python não foi encontrado” no Windows?** O atalho da Microsoft Store (`%LocalAppData%\Microsoft\WindowsApps\python.exe`) vem antes do Python de verdade no `PATH` e só imprime essa mensagem. Use **`py serve.py --open`** — o `py` (Python Launcher) acha a instalação correta. Para resolver de vez: *Configurações → Aplicativos → Configurações avançadas do aplicativo → Aliases de execução do aplicativo* e desligue `python.exe` e `python3.exe`. O `iniciar-editor.bat` já tenta os dois, nessa ordem.

O editor abre em `http://localhost:8741`. O `serve.py` (só biblioteca padrão do Python) serve os arquivos sem cache — alterações aparecem com um F5 comum — e permite **ligar e desligar o servidor local de modelos pelo próprio editor** (🔑 Chaves). Opções: `--port`, `--models-dir`, `--max-loaded`, `--server-port`. `Ctrl+C` encerra o editor e o servidor de modelos que ele abriu.

Qualquer servidor estático também funciona (`python -m http.server 8741`, `npx serve .`), mas aí o botão **Ligar** fica indisponível — Desligar continua funcionando.

> Não abra o `index.html` direto pelo `file://` — as chamadas de API e o cliente Gradio precisam de uma origem HTTP.

Os nodes marcados com o selo **LOCAL** rodam na sua GPU e precisam do servidor local — veja [Modelos locais](#modelos-locais-servidor-local).

## Configuração

Clique em **🔑 Chaves de API** no topo e informe as chaves que for usar:

| Provedor | Usada pelos nodes | Onde obter |
|---|---|---|
| OpenAI | Texto (GPT), Gerar/Editar Imagem | platform.openai.com |
| Anthropic | Claude — Texto | console.anthropic.com |
| Google Gemini | Gemini — Texto | aistudio.google.com |
| Hugging Face | HF — Imagem (Inference API) e TRELLIS (Space) | huggingface.co/settings/tokens |
| Servidor local | Qwen3-TTS — Voz / Fala e Claude Code — Texto | roda na sua máquina (seção abaixo); padrão `http://127.0.0.1:8765` |

As chaves ficam somente no `localStorage` do navegador e são enviadas direto para cada provedor. No mesmo modal, **🔌 Testar conexão** mostra a GPU do servidor local e quais modelos ele encontrou.

### Listas de modelos atualizadas

Os selects **Modelo** dos nodes OpenAI (texto, gerar e editar imagem), Claude, Claude Code e Gemini, e o do chat de edição de imagem, têm uma lista padrão e são completados com o que a API de cada provedor informa (`/v1/models` da OpenAI e da Anthropic, `models` do Gemini):

- **Quando atualiza:** sozinho, ao abrir o editor, se a última consulta tiver mais de 1 dia; ao salvar uma chave nova ou trocada; e em **🔑 Chaves de API → ⟳ Atualizar modelos**, que usa as chaves digitadas no modal, mesmo antes de salvar.
- **Onde aparecem:** os modelos fora da lista padrão ficam no grupo **Mais modelos (da API)**. Os lançados desde a consulta anterior ganham **🆕** por 14 dias, e a barra de status avisa (ex.: “🆕 Modelos novos disponíveis nos nodes: gpt-image-2.5”).
- **O que entra:** cada node só recebe modelos compatíveis. Nos nodes de imagem entram só os `gpt-image*`. No GPT — Texto ficam de fora áudio, realtime, TTS, embeddings, busca, codex, `-pro` e snapshots datados.
- **Cache:** a lista fica em `localStorage["assets-pipeline-models"]`, então funciona sem rede. Se uma consulta falhar, a lista anterior continua valendo e o erro aparece no modal.
- **Assistente (✦):** os modelos novos de texto também aparecem na escolha de modelo do assistente.

Junto com os modelos, a mesma verificação atualiza os campos que dependem deles:

- **Tamanho e Qualidade (nodes de imagem)** passam a depender do modelo escolhido. Como a lista `/v1/models` não diz quais valores cada modelo aceita, o editor descobre com dois pedidos **inválidos de propósito** por modelo (`size` e `quality` com um valor impossível, mais um prompt vazio como trava): a API responde 400 dizendo o que aceita, sem gerar imagem nem custo. O resultado fica no cache por 30 dias. Se a sondagem falhar, vale a lista padrão da família do modelo.
- **Tamanhos grandes:** os modelos novos (gpt-image-2 em diante) não têm lista fechada — respondem “Expected WIDTHxHEIGHT”. Nesses, o seletor Tamanho passa a oferecer do quadrado ao 4K (1024×1024, 2048×2048, 2048×1152, 2560×1440, 3072×3072, 3840×2160, 4096×4096…), mais **✏️ Outro tamanho…** para digitar qualquer `LARGURAxALTURA`. Uma terceira sondagem, com um tamanho absurdo, descobre o teto do modelo: os tamanhos acima dele somem da lista, a dica abaixo do campo mostra o limite (“até 4096 px por lado”) e um valor digitado fora do limite é recusado. Nos modelos com lista fechada, continua a lista de antes.
- Trocar o modelo no node **atualiza os selects na hora**. Um valor que o novo modelo não aceita aparece como “(indisponível)”, e o assistente recebe a lista válida ao tentar usá-lo.
- **Esforço do node Claude Code** vem do `claude --help` da sua CLI, pelo `/claude/info` do servidor local — um nível novo aparece sem mexer no editor.
- **Vozes salvas** do servidor local são recarregadas na mesma verificação.

## Nodes disponíveis

- **Organização**: **Grupo** — área colorida com título e descrição para separar partes do workflow (ver [Grupos](#grupos-containers))
- **Entrada**: Texto (prompt manual, com entrada opcional e interpolação — o placeholder `{{input}}` no conteúdo marca onde o texto conectado entra; sem placeholder, um seletor define antes/depois), Imagem (upload), **Áudio (upload)** — converte no navegador para WAV mono 24 kHz (até 60 s), **Arquivo de texto** — lê um .txt/.md/.csv/.json e entrega o texto inteiro e uma lista de itens (ver [Listas](#listas-e-múltiplos-outputs-fan-out))
- **Texto (LLM)**: OpenAI GPT, Claude, Gemini — com instrução de sistema, temperatura e **Formato de saída** (JSON objeto/array, lista por linha, CSV, Markdown, XML ou templates personalizados criados em “⚙ Gerenciar templates de saída”; a instrução é anexada ao final do prompt e cercas de código são removidas da resposta quando aplicável)
- **Claude Code — Texto** (LOCAL): chama o `claude -p` instalado na sua máquina, com o seu login, e aceita **schemas de saída** (JSON Schema) — ver [Claude Code local](#claude-code-local-claude--p-e-schemas-de-saída)
- **Utilidades**: Dividir Texto → Lista (linhas, vírgula, ponto e vírgula ou JSON)
- **Imagem**: OpenAI Gerar Imagem (gpt-image-1 / DALL·E 3), OpenAI Editar Imagem, Hugging Face Inference (FLUX, SDXL…) — com parâmetro **Quantidade por prompt**
- **3D**: TRELLIS (HF Space da Microsoft) — imagem → modelo GLB
- **Áudio** (LOCAL): **Qwen3-TTS — Voz** (cria/reutiliza um perfil de voz persistente) e **Qwen3-TTS — Fala** (texto → fala) — detalhes em [Qwen3-TTS](#qwen3-tts--fala-local-com-voz-consistente)
- **Saída**: Visualizador (texto, imagem, áudio ou 3D interativo). No modal ampliado: setas ◀ ▶ (ou ←/→ no teclado) para navegar entre os itens, e um **chat de edição** abaixo da imagem que chama a API de edição da OpenAI (gpt-image) sobre a imagem exibida — cada edição vira um novo item na galeria e vai para o histórico. Ao executar o Visualizador via ▶, ele **reaproveita os outputs existentes** dos nodes anteriores (só roda o que falta) e se atualiza automaticamente quando um node conectado é executado.

Há também um **🕘 Histórico** (botão no topo) que guarda automaticamente todas as imagens, áudios e modelos 3D gerados (IndexedDB do navegador, até 200 itens), com visualização, exclusão individual e limpeza total.

## Biblioteca (💬): prompts, templates, schemas e vozes

O botão **💬** da topbar abre a Biblioteca, um painel à direita com as seções **Prompts**, **Prompts de agentes** (personas/instruções de sistema para os nodes LLM), **Templates de saída**, **Schemas de saída (JSON)** e **Vozes locais** — os quatro primeiros salvos no navegador, as vozes no servidor local. Em qualquer campo de texto de node (conteúdo do Texto, instrução de sistema, prompts…), escreva `{{nome}}` — ex.: `{{cartinhas_v2}}` — e o texto do prompt é interpolado na hora da execução. Prompts podem referenciar outros prompts (até 5 níveis), nomes desconhecidos ficam intactos, `{{input}}` continua reservado ao node Texto, e o painel tem botões para copiar o placeholder, editar e excluir. O chat de edição do visualizador também aceita `{{nome}}`.

### Pastas

Prompts, prompts de agentes, templates e schemas podem ser separados em **pastas**, cada seção com as suas:

- **📁** no cabeçalho da seção cria uma pasta. Clique no nome para abrir/fechar (o estado fica lembrado). No cabeçalho da pasta, ao passar o mouse: **＋** cria um item já dentro dela, **📁** cria uma **subpasta**, **✏️** renomeia, **🗑️** exclui (com confirmação). Excluir uma pasta **não apaga nada**: ela e as subpastas somem e os itens vão para “Sem pasta”.
- **Subpastas:** a pasta é um caminho com `/` — `pokeru/characters`, `pokeru/backgrounds`, `pokeru/voices` aparecem aninhadas dentro de `pokeru`. Dá para digitar o caminho inteiro em qualquer campo **Pasta** (a pasta-pai é criada sozinha) ou usar o 📁 da pasta. Até 5 níveis.
- **Renomear** com um nome simples mantém a pasta onde está (`characters` → `herois` continua em `pokeru`); com um caminho, a pasta **muda de lugar** (`outro/herois`) levando subpastas e itens junto.
- A contagem ao lado do nome inclui os itens das subpastas.
- Para mover um item, **arraste o card** para outra pasta (inclusive subpasta) ou para “Sem pasta”, ou use o campo **Pasta** ao criar/editar (um caminho novo cria as pastas).
- Pastas são só organização: o `{{nome}}` de um prompt funciona igual em qualquer pasta, e os nomes continuam únicos. Arrastar o card de um prompt para um campo de texto de um node insere o `{{nome}}` dele.
- Nos nodes, o select “Formato de saída” e o “Schema de saída (JSON)” mostram os itens agrupados por pasta, com o caminho completo (📁 pokeru/characters). Os schemas embutidos ficam na pasta fixa 🧩 Embutidos.

Na seção **Vozes locais** dá para ouvir o áudio de referência de cada perfil de voz, ver origem/seed e excluir (com confirmação — excluir um perfil é irreversível).

## Listas e múltiplos outputs (fan-out)

Qualquer saída pode ser uma **lista**. Quando uma entrada recebe uma lista, o node executa **uma vez por item** e agrega os resultados (havendo mais de uma entrada em lista, executa o produto cartesiano). Fluxo típico:

1. LLM gera N prompts (um por linha) a partir de um conceito;
2. **Dividir Texto → Lista** transforma a resposta em N itens;
3. O node de imagem roda uma vez por prompt — e ainda pode gerar M imagens por prompt (parâmetro Quantidade) → N×M imagens;
4. As prévias e o Visualizador mostram os resultados em galeria (clique numa miniatura para ampliar/baixar).

O mesmo vale para áudio: uma lista de falas → um áudio por fala, todas com a mesma voz.

Não existe um node “iterar” separado: **qualquer node que recebe uma lista roda uma vez por item**. As listas vêm do **Dividir Texto → Lista**, da porta “itens” do **Claude Code** (com schema) ou do **📄 Arquivo de texto**:

- **texto (inteiro)** — o arquivo todo como um único texto (ex.: para um LLM ou para o Dividir Texto);
- **itens (lista)** — o arquivo já dividido pelo Separador: **linhas**, **parágrafos** (blocos separados por linha em branco — bom para prompts de várias linhas), **vírgula**, **ponto e vírgula**, **JSON** (array, ou objeto com uma única lista) ou uma **coluna de CSV** (por número ou pelo nome no cabeçalho; aspas e separador `,` `;` ou tab detectados sozinhos). Numeração e marcadores (“1.”, “-”, “•”) são removidos nos modos de linha/vírgula.

**JSON com lista de objetos:** no modo JSON aparecem dois selects, preenchidos com o que existe no arquivo carregado:

- **Lista a iterar** — qual lista percorrer: *Automático* usa a raiz (se o arquivo for um array) ou a única lista do objeto; se houver várias, escolha uma (ex.: `personagens`, `dados.cenas`), cada opção mostra quantos itens tem;
- **Campo de cada item** — qual propriedade de cada objeto vira o item (ex.: `prompt`, `fala.texto`), com um valor de exemplo ao lado. Sem campo, cada objeto sai inteiro como JSON. Itens sem o campo escolhido são ignorados, com aviso no node.

Ex.: `[{"nome": "Guarda", "fala": "Alto lá!"}, {"nome": "Ferreiro", "fala": "Precisa de uma espada?"}]` com o campo `fala` → dois itens, “Alto lá!” e “Precisa de uma espada?”.

O modo JSON é tolerante: aceita comentários (`// …` e `/* … */`, comuns em arquivos `.jsonc` e escritos à mão), vírgula sobrando antes de `]` ou `}`, cercas de código ```` ``` ```` e **JSON Lines** (`.jsonl`, um objeto por linha). Os comentários são **ignorados** — nada deles segue adiante: os itens saem do JSON já interpretado e, no modo JSON, a saída “texto (inteiro)” (e a prévia do node) traz o JSON limpo e formatado, não o arquivo cru. Se o arquivo não for JSON mesmo, o erro mostra a linha, a coluna e o trecho do problema — e, se o arquivo for uma lista simples de texto, sugere o separador “linhas”.

No Chrome, o arquivo escolhido é **relido do disco a cada execução** enquanto a página estiver aberta (o ↻ relê na hora): edite o `.txt` no seu editor e rode de novo. Depois de recarregar a página, o node usa a cópia salva no workflow até você escolher o arquivo outra vez.

Exemplo: `prompts.txt` (um prompt por linha) → **Arquivo de texto** → porta **itens** → OpenAI — Gerar Imagem → uma imagem por linha do arquivo.

### Coletar resultados (🧺)

Os resultados de um loop ficam juntos na saída do node (ex.: os N áudios de um Fala ligado a uma lista). Para fazer algo com o conjunto, ligue essa saída no **🧺 Coletar resultados** (categoria Saída). Ele aceita **várias conexões** ao mesmo tempo (ex.: os áudios de dois personagens + as imagens de um terceiro) e não roda de novo por item:

- **⇩ Baixar .zip** — um arquivo por item (`.wav`, `.png`, `.txt`…) + `manifest.json` com o texto, a seed e a voz de cada arquivo;
- **📁 Pasta…** (Chrome/Edge) — escolha uma pasta do computador: os arquivos são gravados nela na hora e **a cada execução** (com “Salvar na pasta a cada execução” marcado), sobrescrevendo os de mesmo nome; **Salvar agora** grava sob demanda. Depois de recarregar a página, escolha a pasta de novo;
- saída **áudio único** — todos os áudios emendados na ordem, com a pausa configurada (ex.: a cena inteira num só arquivo);
- saída **texto único** — todos os textos juntos (linha, linha em branco, vírgula ou nada);
- saída **lista** — repassa os itens para outro node (ele roda uma vez por item).

**Nome dos arquivos:** `{n}` = número do item, `{voz}` = voz/speaker que gerou o áudio (vazio nos demais itens), `{texto}` = início do texto/prompt que gerou o item, `{tipo}` = image/audio/text. Padrão `{n}_{voz}_{texto}` → `001_guarda_eldoria_Bem-vindo_a_Eldoria,_viajante.wav` (sem voz, fica `001_Bem-vindo…`). Imagens, áudios e modelos 3D agora guardam o texto que os gerou — ele também aparece como legenda no Visualizador ampliado.

O Exemplo 3 já termina num Coletar resultados: rode e baixe as três falas num .zip, ou ouça a cena inteira na saída “áudio único”.

## Workflows de exemplo (menu 📋 Exemplos)

1. **Texto → Prompts → Imagens** — GPT gera 3 prompts distintos a partir de um conceito, o node Dividir separa em lista e o node de imagem gera uma arte por prompt (galeria no Visualizador).
2. **Prompt → Imagem → Modelo 3D** — gera uma imagem de asset e envia ao space TRELLIS para produzir um `.glb`, visualizado em 3D no próprio node.
3. **Falas com voz consistente (Qwen3-TTS local)** — três falas de um NPC viram lista; o node **Voz** cria o perfil “guarda_eldoria” por descrição e o node **Fala** gera as três com exatamente a mesma voz. Rode de novo amanhã: o perfil é reutilizado e a voz continua a mesma.

## Controles do editor

- Arrastar o fundo: move o canvas · Scroll: zoom
- Arrastar da porta de **saída** para uma de **entrada**: conecta (portas coloridas por tipo: azul = texto, laranja = imagem, verde = 3D, rosa = áudio, amarelo = voz)
- Duplo clique numa conexão: remove
- `Delete`: apaga o que estiver selecionado · ▶ no cabeçalho do node: executa só aquele ramo
- **Toda exclusão pergunta antes:** um modal mostra o que sai (nodes, conexões, subpastas, saves…) com **Cancelar** e o botão vermelho de confirmar. `Enter` confirma, `Esc` ou o clique fora cancelam. Vale para nodes, grupos, seleção por área, prompts, prompts de agentes, templates, schemas, pastas, workflows, saves, sessões do assistente, vozes locais e histórico.
- **Campos de texto ampliados:** clicar num campo de texto de um node (conteúdo, instrução de sistema, schema…) abre uma folha grande sobre o canvas com o mesmo texto — dá para ler e escrever sem depender da rolagem miúda do node. O texto é salvo enquanto você digita; `Esc`, `Ctrl+Enter`, o ✕ ou um clique fora voltam ao node. O rodapé mostra a contagem de caracteres e palavras.
- **Redimensionar node:** arraste a alça no canto inferior direito. A largura vale sempre; definir uma **altura** transforma o corpo do node numa área rolável — e a lista de áudios da prévia passa a usar todo o espaço, que é o jeito de ver muitos resultados sem abrir o ⤢. **Duplo clique** na alça volta ao tamanho automático. O tamanho é salvo no workflow.
- **Redimensionar modais:** todo modal tem a mesma alça no canto inferior direito, e o tamanho escolhido **vale para os próximos modais** (fica guardado no navegador). Útil para o visualizador e para as telas de prompts e schemas.
- Paleta: o campo **Buscar node…** filtra por nome, descrição ou categoria
- Aparência (ícone de meio círculo na topbar): 5 paletas de cor (ou cor livre) e cantos arredondados, retos ou em pílula
- Passe o mouse no **?** do canto inferior direito para ver os atalhos
- ⇩/⇧ Exportar/Importar workflow em JSON — o arquivo inclui os resultados (sessão), então quem importa recupera de onde parou. O importado entra como um **workflow novo** (não substitui o que está aberto). O ⇧ também aceita um backup completo (menu 📋 → Backup)
- **Ctrl+S** salva o workflow atual

### Execução em paralelo e fila

O ▶ **Executar** não roda mais um node de cada vez. Assim que as dependências de um node ficam prontas ele começa, e vários rodam ao mesmo tempo — respeitando um limite por tipo de recurso:

| fila | limite | quem entra |
|---|---|---|
| **local** | 1 por vez | Qwen3-TTS (Voz e Fala) e Claude Code — é uma GPU só, e o servidor local atende um pedido por vez |
| **rede** | 4 ao mesmo tempo | OpenAI, Claude, Gemini, Hugging Face e TRELLIS |
| **cpu** | 8 ao mesmo tempo | Texto, Arquivo de texto, Dividir, Visualizador, Coletar — instantâneos |

Quem não encontra vaga entra na **fila**: o node fica com o selo **⏸ Na fila** e começa sozinho assim que o anterior daquela fila termina. A barra de status mostra o resumo (`⏳ 4 nodes rodando · 1 na fila`) e, quando só um node está rodando, o progresso dele. O ⏹ **Parar** continua valendo: os nodes em andamento terminam o item atual e o que estava na fila não chega a começar. Um node que falha continua impedindo os que dependem dele — os outros ramos seguem normalmente.

### Selecionar, copiar e colar

- **Botão direito** num node, num grupo ou no fundo abre o menu: **Copiar**, **Duplicar**, **Colar aqui**, **Remover**, **Selecionar tudo** e **Limpar seleção**. Em campos de texto continua valendo o menu do navegador.
- **Arraste com o botão direito** (ou **Ctrl/Shift + arraste** com o esquerdo) para **selecionar por área**: os nodes que a área encostar entram, e os grupos que couberem inteiros dentro dela também. Ao soltar, o menu já abre com a seleção. Arrastar o fundo com o botão esquerdo continua movendo o canvas.
- **Copiar um grupo leva os nodes de dentro** e as conexões entre os copiados; as conexões que saíam da seleção ficam para trás.
- Atalhos: `Ctrl+C` copia, `Ctrl+V` cola onde o mouse está, `Ctrl+D` duplica 40 px ao lado, `Ctrl+A` seleciona tudo, `Esc` limpa a seleção, `Delete` remove.
- O recorte também vai para a **área de transferência do sistema** (JSON), então dá para colar em outro workflow ou em outra aba. Se o navegador não liberar, ou se o recorte tiver imagens grandes, ele continua valendo só na aba onde foi copiado.
- Nodes colados vêm **sem os resultados** — só o tipo, os parâmetros e as ligações.

## Grupos (containers)

Para organizar um workflow em partes (roteiro, geração, pós-processamento…), use o item **Grupo** no topo da paleta:

- **Criar**: clique no item (se houver um node selecionado, o grupo já nasce envolvendo ele) ou arraste-o para o canvas.
- **Título**: duplo clique no título para renomear; Enter confirma.
- **Descrição**: clique na linha abaixo do título (“Adicionar descrição…”) e escreva — o campo cresce com o texto; pode ficar vazio.
- **Cor**: clique na bolinha à esquerda do título e escolha uma das 7 cores.
- **Mover**: arraste pelo título — os nodes que estão dentro do grupo (pelo cabeçalho) vão junto. A área vazia do grupo funciona como o fundo: arrastar ali move o canvas.
- **Redimensionar**: canto inferior direito. **Remover**: ✕ no título ou `Delete` com o grupo selecionado (os nodes continuam no canvas).

Grupos são só visuais (não afetam a execução) e são salvos com o grafo: entram nos templates, nos saves e no JSON exportado. O Exemplo 3 já vem organizado em três grupos.

## Workflows, rascunhos e saves (menu 📋)

O botão **📋** da topbar mostra o nome do workflow aberto; um **●** ao lado indica alterações ainda não salvas (passe o mouse para ver o motivo).

- **Nada se perde ao trocar de workflow**: cada alteração no grafo vai para um **rascunho** do próprio workflow (auto-save no IndexedDB, com cópia no localStorage). Trocar de workflow, recarregar ou fechar a aba e voltar depois reabre exatamente como estava, mesmo sem salvar.
- **💾 Salvar** (botão no topo ou **Ctrl+S**): grava o grafo atual no workflow e o ● some. Nos **exemplos embutidos** e no **Rascunho**, que nunca são sobrescritos, ele pede um nome e cria um workflow seu. O exemplo de onde você partiu volta ao original.
- **Workflow atual** (no menu): *Salvar como novo workflow…* (duplica com outro nome), *Renomear…* e *Descartar alterações não salvas* (volta à última versão salva; num exemplo, *Restaurar o exemplo original*). Descartar pede confirmação.
- **Workflows**: os exemplos + os seus (🧩), com ✏️ renomear e 🗑 excluir. Excluir pede confirmação e apaga também o rascunho, os saves e as sessões do assistente daquele workflow. ➕ *Novo workflow em branco* abre o **Rascunho**; se já houver um rascunho com nodes, ele é guardado antes como save (“Rascunho anterior…”).
- **Resultados automáticos**: os resultados dos nodes também são salvos por workflow depois de cada execução e voltam ao reabrir. O ▶ reaproveita o que já foi gerado.
- **Saves** (📸 *Criar save agora*): snapshot com nome (sugere data/hora) de **grafo + resultados**. Clique para restaurar; ✏️ renomeia, 🗑 exclui (com confirmação). Ao restaurar, o estado atual vira um save “Antes de restaurar…” se tiver alterações ou resultados, então restaurar nunca apaga trabalho.
- **Backup**: *⇩ Exportar backup completo* baixa um único `.json` com todos os workflows, rascunhos, saves, sessões do assistente (sem os pontos de desfazer) e a Biblioteca (prompts, prompts de agentes, templates, schemas e pastas). O 🕘 Histórico fica de fora. *⇧ Importar backup* **soma** ao que já existe e nunca sobrescreve: itens idênticos são ignorados, e conflitos entram como cópia com outro nome. **Estado espelhado fora do navegador (SQLite):** com o editor aberto pelo `serve.py`, toda mudança em workflows, rascunhos, saves, sessões e Biblioteca é gravada também em `dados/estado.db`. O navegador continua sendo onde o editor lê e escreve — por isso ele funciona em qualquer servidor estático —, mas o banco é a cópia que **não depende dele**. Na abertura, o editor compara o que tem com o que está no banco e **traz de volta sozinho** o que estiver faltando, avisando na barra de status. É isso que impede a perda quando o Chrome apaga o IndexedDB por falta de espaço em disco.

Detalhes: a gravação é incremental (só as linhas que mudaram) e sai 1,5 s depois da última alteração; a lista de ids enviada junto é o que apaga do banco o que você excluiu no editor — mas uma lista **vazia** é ignorada (seria perda de dados) e linhas gravadas há menos de um minuto são poupadas, para duas abas abertas não apagarem o trabalho uma da outra. A Biblioteca só é restaurada quando sumiu inteira, para não ressuscitar prompt excluído. As chaves de API **não** entram no banco: continuam só no navegador. A pasta `dados/` não é servida por HTTP, e `--dados-dir` troca o local do banco.

**Backup automático em disco**: com o editor aberto pelo `serve.py`, ele grava sozinho uma cópia igual à do ⇩ na pasta `backups/` do projeto — uma ao abrir e, depois, no máximo uma a cada 10 minutos, só quando algo mudou (nunca durante um ▶). Ficam os **12 arquivos mais novos**, com teto de **2 GB**; o mais velho sai quando passa disso. O menu mostra quantos são, quanto ocupam e quando foi o último, e a linha **🗑 Limpar backups automáticos** apaga todos (a confirmação diz o tamanho). Pela linha de comando: `py serve.py --limpar-backups`, que apaga e diz quantos GB liberou. `--backups-dir` troca a pasta — use uma separada se abrir uma segunda instância do editor, senão as duas disputam os mesmos 12 arquivos da rotação. A pasta não é servida pelo HTTP. Para restaurar, use ⇧ Importar e escolha um arquivo de `backups/`.

O editor também pede ao navegador armazenamento persistente, para ele não apagar os dados sozinho quando faltar espaço. O menu mostra se foi concedido. A faixa vermelha acima da barra de status aparece quando **nada** protege os dados (sem garantia do navegador e sem backup automático) ou quando uma gravação de backup falha — com o motivo.

> **Atenção: o Chrome pode apagar tudo.** Ele só concede a garantia de armazenamento a páginas com "engajamento" — na prática, **favorite o editor (Ctrl+D)**. Sem a garantia, quando o disco fica quase cheio o Chrome apaga os dados dos sites menos usados, e `http://localhost` entra nessa fila: workflows salvos, saves e a Biblioteca somem de uma vez, sem aviso e sem lixeira. A proteção que não depende do navegador é o banco `dados/estado.db` (restaura sozinho na abertura), e o backup em disco: o automático em `backups/` cobre o dia a dia, e vale exportar um `.json` para fora do projeto de tempos em tempos.

Os workflows salvos em versões anteriores continuam valendo: o formato é o mesmo, e o grafo que estava aberto (inclusive edições não salvas) é recuperado na primeira abertura.

## Assistente de IA (✦)

O botão **✦** da topbar abre, à direita, um chat com um agente (LangChain.js, rodando no próprio navegador) que **cria e edita workflows, prompts, prompts de agentes, templates de saída, schemas e pastas da Biblioteca** a partir do que você pede. Exemplos: “crie um workflow que gera 3 prompts de imagem a partir de um conceito e depois as imagens”, “adicione um schema Ficha de NPC com nome, classe e falas”, “por que o n4 deu erro?”.

- **Provedores** — clique no nome do modelo, no topo do painel:
  - **Anthropic, OpenAI e Gemini** usam as chaves do 🔑. Os modelos oferecidos são os mesmos dos nodes de texto.
  - **Claude Code local** usa o `claude -p` do servidor local, com o seu login: não precisa de chave, mas o servidor tem de estar ligado. Cada passo leva de 5 a 20 s, e cada pedido tem no máximo 12 chamadas ao modelo.
- **O que ele faz** — lê e edita o workflow aberto (nodes, conexões, params, grupos e layout automático); abre, cria, salva, renomeia e exclui workflows; e mexe na Biblioteca.
  - As edições são validadas antes: tipos de porta, opções dos selects, faixas numéricas e ciclos. Se uma operação do lote falhar, nada é aplicado e ele corrige.
  - Params de arquivo (imagem, áudio, arquivo de texto) ficam por sua conta.
- **O que ele não faz** — executar workflows ou nodes: quem aperta ▶ é você. Ele lê resultados e erros para ajudar a depurar. Também só salva o workflow quando você pede: as edições ficam no rascunho, com o ● de não salvo.
- **Desfazer** — cada resposta com alterações ganha **↺ Desfazer · N alterações** (dois cliques), que volta grafo, workflows e Biblioteca ao estado de antes daquela resposta (e das seguintes).
  - Antes da primeira mudança em cada workflow, ele cria um save “Antes do assistente…” no menu 📋.
  - Exclusões de workflow, prompt, schema ou pasta pedem confirmação no chat.
- **Sessões** — cada workflow guarda suas sessões de conversa no navegador. O seletor 🗂 abaixo do cabeçalho mostra a sessão aberta e lista as outras daquele workflow (data e nº de pedidos): clique para abrir, ✏️ renomeia, 🗑 exclui (com confirmação); ⟲ ou “＋ Nova sessão” começa outra. O título padrão é o primeiro pedido. Ao trocar de workflow, abre a sessão mais recente dele.
  - Quando é o assistente que abre ou cria um workflow no meio de um pedido, a sessão continua a mesma e passa a pertencer ao workflow novo.
  - Excluir um workflow apaga as sessões dele. O backup completo leva as sessões, sem os pontos de ↺ desfazer.
- **Largura** — arraste a borda esquerda do painel (entre 300 px e quase a tela toda); duplo clique volta ao padrão. A largura fica salva, e a Biblioteca abre ao lado.
- **Parar** interrompe o pedido na hora. No Claude local, o processo que já está rodando no servidor termina sozinho.
- **Primeira abertura** — o LangChain é baixado do CDN esm.sh; na primeira vez pode levar até um minuto, depois fica em cache. Abra o editor pelo `serve.py`, que serve os `.js` como `text/javascript`, necessário para o módulo do assistente.
- **Testes sem custo** — com `localStorage["assets-pipeline-assistant-debug"] = "1"`, aparece o provedor 🧪 Roteiro (respostas pré-definidas), e `assistantDebug.selfTest()` no console roda o autoteste das operações de grafo e do desfazer.
- **“Não foi possível carregar o LangChain”** — se a mensagem citar um *export* que não existe (por exemplo `does not provide an export named 'Langsmith'`), **não é a sua internet**: é um pacote publicado quebrado no CDN. Todas as versões ficam fixadas em `js/assistant/lc.js`, inclusive as indiretas — o `langsmith` está lá porque o `@langchain/core` o pede por faixa (`>=0.5.0 <1.0.0`) e o CDN escolhia sozinho a mais nova. Para conferir uma versão antes de subir:

  ```
  curl -s "https://esm.sh/langsmith@<versão>/es2022/langsmith.mjs" | head -c 200
  ```

  Se o `langsmith.mjs` importar `{ Langsmith }` de `./client.mjs` (que só exporta `{ Client }`), aquela versão está quebrada — foi o caso de 0.10.10 e 0.10.11.

## Imagens de referência nos nodes de imagem

Os nodes **OpenAI — Gerar Imagem** (entrada opcional "imagens") e **OpenAI — Editar Imagem** aceitam **várias conexões** de nodes de imagem ao mesmo tempo (e listas): todos os valores conectados são agregados e enviados juntos numa única chamada ao endpoint /images/edits, como referência para composição/variação/estilo. O prompt continua fazendo fan-out normalmente.

## Fundo transparente

Os dois nodes da OpenAI têm o campo **Fundo**: *Automático* (padrão, o modelo decide), *Transparente* ou *Opaco*. Só **Transparente** garante canal alfa — ele manda `background: "transparent"` e `output_format: "png"` para a API. Escrever "fundo transparente" no prompt **não** produz alfa: com o padrão automático a API devolve um PNG RGB sem alfa, com o fundo pintado.

O editor nunca reabre a imagem num canvas: o download entrega os mesmos bytes que a API devolveu, então a transparência que vier é preservada no arquivo. Para conferir a olho, abra o resultado no visualizador — o xadrez atrás da imagem aparece onde houver alfa.

## Observações sobre o TRELLIS

O node usa o cliente Gradio para chamar o space (padrão `microsoft/TRELLIS`, editável no parâmetro do node — troque para a variante 2 se preferir, ex.: um space "TRELLIS 2" da Microsoft). Spaces gratuitos podem hibernar ou ter fila longa; se falhar, abra o space no navegador para "acordá-lo" e tente de novo. A geração 3D pode levar alguns minutos.

---

## Modelos locais (servidor local)

Nodes **LOCAL** não chamam APIs direto do navegador: ele conversa com um pequeno servidor Python (FastAPI) em `local-server/`, que carrega os modelos na sua GPU (Qwen3-TTS) e executa a CLI do Claude Code (`claude -p`).

```
navegador (editor)  ──HTTP──▶  local-server/server.py (127.0.0.1:8765)  ──▶  GPU
                                     │
                                     └─ D:\modelos\qwen3-tts\…   (pesos dos modelos + perfis de voz)
```

### Requisitos

- Windows com GPU NVIDIA e driver atualizado (testado numa RTX 5070 12 GB, driver 610). Os modelos 1.7B usam ~4,5 GB de VRAM cada; 8 GB já bastam com `-MaxLoaded 1`. Sem GPU funciona na CPU, mas bem devagar.
- [uv](https://docs.astral.sh/uv/) (recomendado) ou Python 3.12 com `pip`.
- Espaço em disco: **~13 GB em `D:\modelos`** (três modelos 1.7B) e **~6 GB** para o ambiente Python (`local-server\.venv`, com o PyTorch CUDA).

### Passo a passo

Rode os comandos a partir da pasta do projeto, num PowerShell. O `-ExecutionPolicy Bypass` só é necessário porque o Windows bloqueia scripts `.ps1` por padrão.

1. **Criar o ambiente Python** (PyTorch com CUDA 12.8 + `qwen-tts` + servidor):

   ```powershell
   powershell -ExecutionPolicy Bypass -File local-server\setup.ps1
   ```

   No final ele imprime algo como `torch 2.11.0+cu128 | CUDA: True | NVIDIA GeForce RTX 5070`. Se aparecer `CUDA: False`, veja [Solução de problemas](#solução-de-problemas). GPUs mais antigas/drivers antigos: `-Cuda cu126`.

2. **Baixar os modelos para `D:\modelos\qwen3-tts`**:

   ```powershell
   powershell -ExecutionPolicy Bypass -File local-server\download-models.ps1
   ```

   | Pasta (em `D:\modelos\qwen3-tts\`) | Para quê | Tamanho |
   |---|---|---|
   | `Qwen3-TTS-12Hz-1.7B-Base` | clonagem de voz — usado por **todos** os perfis de voz | ~4,3 GB |
   | `Qwen3-TTS-12Hz-1.7B-CustomVoice` | 9 speakers pré-definidos + instrução de estilo/emoção | ~4,3 GB |
   | `Qwen3-TTS-12Hz-1.7B-VoiceDesign` | cria vozes a partir de uma descrição em texto | ~4,3 GB |

   Cada pasta já inclui o speech tokenizer (`speech_tokenizer/`), então não é preciso baixar o `Qwen3-TTS-Tokenizer-12Hz` à parte. `-Small` baixa também as variantes 0.6B (Base e CustomVoice; mais leves, qualidade menor) e `-ModelsDir E:\outra\pasta` troca o destino. Se o download cair, rode de novo — ele retoma.

   Download manual equivalente (com o `hf` do Hugging Face):

   ```powershell
   hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base        --local-dir D:\modelos\qwen3-tts\Qwen3-TTS-12Hz-1.7B-Base
   hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --local-dir D:\modelos\qwen3-tts\Qwen3-TTS-12Hz-1.7B-CustomVoice
   hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --local-dir D:\modelos\qwen3-tts\Qwen3-TTS-12Hz-1.7B-VoiceDesign
   ```

3. **Iniciar o servidor** — pelo editor ou pelo terminal.

   **Pelo editor** (precisa do editor aberto pelo `serve.py`): **🔑 Chaves → Servidor local → Ligar**. O servidor roda em segundo plano, sem janela, com log em `local-server\logs\server.log` (botão **Log**); **Desligar** libera a VRAM e encerra o processo. O ponto ao lado de “Chaves” na topbar fica verde com o servidor ligado.

   **Pelo terminal** (deixe-o aberto enquanto usa o editor):

   ```powershell
   powershell -ExecutionPolicy Bypass -File local-server\start.ps1
   ```

   Opções: `-Port 8765`, `-ModelsDir D:\modelos`, `-MaxLoaded 2` (quantos modelos ficam na GPU ao mesmo tempo; use `1` com pouca VRAM), `-BindHost 127.0.0.1`. Os modelos só são carregados na primeira geração que precisa deles (~10–30 s); depois ficam em memória.

   Velocidade de referência (RTX 5070, PyTorch sem flash-attn): ~4–5 s de processamento por segundo de fala — uma fala de 5 s leva ~20 s, e criar uma voz por descrição leva ~1 min na primeira vez. As gerações são enfileiradas (uma por vez na GPU).

4. **No editor**: abra **🔑 Chaves de API → Modelos locais**, deixe a URL vazia (padrão `http://127.0.0.1:8765`) ou informe outra, e clique em **🔌 Testar conexão**. Carregue o **📋 Exemplo 3** e clique em ▶ Executar.

### Estrutura em disco

```
D:\modelos\
└─ qwen3-tts\
   ├─ Qwen3-TTS-12Hz-1.7B-Base\           pesos (baixados)
   ├─ Qwen3-TTS-12Hz-1.7B-CustomVoice\
   ├─ Qwen3-TTS-12Hz-1.7B-VoiceDesign\
   └─ vozes\                              perfis criados pelo node Voz
      └─ guarda_eldoria\
         ├─ profile.json                  origem, descrição, transcrição, idioma, seed
         ├─ reference.wav                 o áudio que define a voz
         └─ prompt-Qwen3-TTS-12Hz-1.7B-Base.pt   prompt de clonagem em cache
```

Faça backup da pasta `vozes\` se quiser guardar as vozes do projeto — é ela que garante que a voz de um personagem continue idêntica meses depois.

### API do servidor

| Método | Rota | Uso |
|---|---|---|
| GET | `/health` | status, GPU, modelos encontrados e carregados |
| POST | `/unload` | descarrega todos os modelos (libera VRAM) |
| POST | `/shutdown` | desliga o servidor (botão Desligar em Chaves) |
| GET | `/qwen3-tts/voices` | lista os perfis de voz |
| POST | `/qwen3-tts/voices` | cria/reutiliza um perfil (`name`, `source`: design/speaker/audio, `instruct`, `speaker`, `ref_text`, `ref_audio`, `language`, `seed`, `overwrite`…) |
| DELETE | `/qwen3-tts/voices/{nome}` | exclui um perfil |
| GET | `/qwen3-tts/voices/{nome}/audio` | WAV de referência do perfil |
| POST | `/qwen3-tts/tts` | gera fala (`text`, `mode`: voice/speaker/design, `voice`, `seed_mode`, `sampling`, `split`, `normalize`…) — devolve WAV em dataURL |

| GET | `/claude/info` | se a CLI `claude` foi encontrada e a versão |
| POST | `/claude/run` | roda `claude -p` (`prompt`, `system`, `model`, `effort`, `json_schema`) — devolve `text`, `structured`, `model`, `cost_usd`, `duration_ms` |

Documentação interativa em `http://127.0.0.1:8765/docs`.

**Segurança:** o servidor só aceita chamadas de páginas servidas pelo próprio computador (`localhost`, `127.0.0.1` ou `[::1]`, em qualquer porta), porque ele usa a GPU e executa o Claude Code com o seu login — com o CORS aberto, qualquer site que você visitasse poderia fazer o mesmo. Para liberar outra origem (ex.: o editor aberto de outro PC da rede), inicie o `server.py` com `--allow-origin http://meu-pc.local:8741`.

### Solução de problemas

- **“Servidor local não respondeu”** — o servidor está desligado (ligue em 🔑 Chaves ou rode o `start.ps1`), ou a URL em 🔑 está diferente da porta usada.
- **Botão “Ligar” desabilitado** — o editor foi aberto por outro servidor estático; feche-o e abra pelo `serve.py` / `iniciar-editor.bat`. Se o servidor fechar logo ao ligar, o botão **Log** mostra o motivo.
- **`CUDA: False` no setup** — atualize o driver NVIDIA; RTX 50xx exige `-Cuda cu128` ou mais novo. Reinstale com `setup.ps1` (ele reaproveita o `.venv`).
- **Falta de memória de GPU (erro 507)** — feche jogos/apps que usam a GPU ou inicie com `-MaxLoaded 1`. O servidor também tenta sozinho descarregar os outros modelos antes de desistir.
- **“Modelo … não encontrado”** — rode o `download-models.ps1` (ou `-Small` para os 0.6B) ou ajuste `-ModelsDir`.
- **Avisos `SoX could not be found` / `flash-attn is not installed`** ao iniciar — inofensivos. O SoX não é usado na inferência, e sem flash-attn o servidor usa a atenção SDPA do PyTorch. (O flash-attn é difícil de compilar no Windows; não compensa para TTS.)
- **Porta em uso** — `start.ps1 -Port 8766` e atualize a URL em 🔑.
- **“CLI `claude` não encontrada”** — instale o Claude Code, rode `claude` uma vez no terminal para fazer login e reinicie o servidor (ele procura o `claude` no PATH ao iniciar).

### Adicionando outros modelos locais

O servidor foi feito para crescer: cada modelo é um backend em `local-server/backends/` (ver `qwen3_tts.py`) que usa o `ModelCache` compartilhado (LRU de modelos na GPU) e o `audio_utils.py`; as rotas são registradas em `server.py`. No front-end, um node com `local: true` em `js/nodes.js` chama o servidor com `callLocal(rota, { method, body })` e ganha o selo **LOCAL** na paleta.

---

## Claude Code local (`claude -p`) e schemas de saída

O node **✳️ Claude Code — Texto** (categoria Texto (LLM), selo LOCAL) gera texto com a CLI do Claude Code instalada no seu computador, usando o login que você já tem nela (assinatura ou API key) — não precisa de chave no 🔑.

**Requisitos:** Claude Code instalado e logado (`claude` funcionando no terminal) e o servidor local rodando (`local-server\start.ps1`; não precisa de GPU para este node).

**Como roda:** o servidor chama `claude -p --output-format json --tools "" --safe-mode --no-session-persistence` numa pasta temporária vazia, com o prompt pela entrada padrão. Ou seja: sem ferramentas (o Claude não lê nem altera arquivos), sem CLAUDE.md, hooks, skills ou MCP, e sem salvar sessões. A “Instrução de sistema” do node substitui o prompt de sistema padrão do Claude Code.

**Parâmetros:** modelo (padrão da sua CLI, Opus 5, Sonnet 5, Fable 5.1 ou Haiku 4.5), esforço (low → max), instrução de sistema e **Schema de saída**.

### Schemas de saída

Com um schema escolhido, o node passa `--json-schema` para a CLI e o Claude Code devolve um JSON **validado** nesse formato:

- a porta **texto / JSON** traz o JSON formatado;
- se o JSON tiver uma lista (array na raiz ou uma única propriedade do tipo array), a porta **itens (lista)** entrega essa lista — os nodes seguintes rodam uma vez por item, sem precisar do “Dividir Texto”.

De onde vêm os schemas:

- **🧩 Embutidos**: Lista de itens, Prompts de imagem, Falas de personagem, Ficha de asset.
- **📐 Seus**: crie em **💬 Biblioteca → Schemas de saída (JSON)** (➕), com validação do JSON enquanto você digita e botão “Formatar”; os embutidos têm ⧉ para duplicar e editar. Ficam salvos no navegador.
- **✏️ Personalizado**: escreva o JSON Schema direto no node.

Sem schema, o node usa o “Formato de saída” (instruções/templates de texto), como os outros nodes de texto. Modelo usado, duração e custo estimado ficam no 🐞 Debug.

Exemplo: Texto (“Crie 3 prompts de imagem para um baú de tesouro”) → **Claude Code** (schema “Prompts de imagem”) → porta **itens** → OpenAI — Gerar Imagem: uma imagem por prompt.

---

## Qwen3-TTS — fala local com voz consistente

Dois nodes, na categoria **Áudio**:

- **🎙️ Qwen3-TTS — Voz**: cria um **perfil de voz** persistente e o entrega na saída **voz** (amarela). Origens:
  - **Descrição (voice design)** — descreva idade, gênero, timbre, ritmo, sotaque e emoção; o VoiceDesign fala a *frase de referência* com essa voz;
    - ⚠ a entrada **“transcrição”** do node **substitui** o campo “Frase de referência”, em qualquer origem. Ela existe para a clonagem a partir de áudio; se estiver conectada em “Descrição”, o node avisa e o texto que chega por ela é o que será falado. Conectar ali a lista de falas do personagem é o jeito mais fácil de pedir, sem perceber, horas de geração;
  - **Speaker pré-definido** — um dos 9 speakers do CustomVoice (Aiden, Ryan, Vivian, Serena, Uncle_Fu, Dylan, Eric, Ono_Anna, Sohee), com estilo/emoção opcional;
  - **Áudio de referência (clonar)** — conecte um **Áudio (upload)** com 5–15 s de fala limpa e informe a transcrição exata (campo ou entrada “transcrição”). O modo x-vector dispensa a transcrição, mas é menos fiel.
- **🗣️ Qwen3-TTS — Fala**: texto → WAV. A voz vem da entrada **voz** ou do campo “Voz” (voz salva, speaker pré-definido ou descrição). Aceita lista de textos (um áudio por item), tem “Takes” para gerar variações e escolhe o modelo 1.7B/0.6B.
  - **Várias vozes**: em “Voz”, escolha *Várias vozes (uma geração por voz)* e marque na lista as vozes salvas e/ou os speakers pré-definidos (há “Marcar todas” e “Limpar”). O mesmo texto é gerado em cada voz marcada — um áudio por voz, na ordem da lista, com o nome da voz na prévia. Estilo/emoção vale só para os speakers. Com uma lista de textos, sai cada texto em cada voz. Também dá para conectar **vários nodes Voz** na entrada “voz” — o resultado é o mesmo.

Os 10 idiomas suportados: português, inglês, espanhol, francês, italiano, alemão, russo, chinês, japonês e coreano (ou automático).

### Salvar uma voz gerada

Gostou de uma voz que saiu de um speaker, de uma descrição ou de um take? Clique em **Salvar voz** embaixo do áudio, na prévia do node (ou em **Salvar como voz** no Visualizador ampliado e no 🕘 Histórico). Dê um nome; a transcrição já vem preenchida com o texto usado na geração — confira se o áudio fala exatamente aquilo. O áudio vira um perfil clonado, igual aos criados pelo node Voz: aparece em “Voz salva” no node Fala e em 💬 Biblioteca → Vozes locais. Funciona também com áudios do node Áudio (upload) — aí é só escrever a transcrição.

Dica: para clonar, prefira um take de 5–15 s com fala limpa. O **⇩** ao lado do “Salvar voz” baixa o WAV.

### Como a consistência de voz é garantida

Por padrão, TTS neural sorteia prosódia e até timbre a cada geração. Os nodes combinam várias camadas para que a mesma voz saia igual entre falas, execuções e dias:

1. **Referência fixa (“design → clone”)** — toda voz, mesmo a criada por descrição ou por speaker, vira um *áudio de referência* salvo no perfil. As falas são sempre geradas pelo modelo **Base** clonando essa referência — o fluxo recomendado pela Qwen para personagens recorrentes. Descrever a voz de novo a cada fala (modo “Descrição” sem perfil) sorteia uma voz diferente toda vez; o node avisa quando você faz isso.
2. **Prompt de clonagem em cache** — o embedding do speaker e os códigos da referência são calculados **uma única vez** e salvos em `prompt-<modelo>.pt`. Toda geração usa exatamente o mesmo condicionamento, inclusive depois de reiniciar o servidor.
3. **Perfil imutável por nome** — rodar o node Voz de novo com o mesmo nome **reutiliza** o perfil sem gerar nada. Se você mudou a descrição/frase, o node mostra um aviso em vez de trocar a voz silenciosamente. “Recriar se a voz já existir” substitui o perfil uma vez e se desmarca sozinho.
4. **Seed reprodutível** — a seed (do perfil, fixa ou aleatória) é reaplicada no início de *cada trecho*. Mesmo texto + mesma voz + mesma seed = mesmo áudio. No modo aleatório, a seed usada aparece no 🐞 Debug para você fixá-la depois. “Takes” usam seeds seguidas (seed, seed+1…), então cada take também é reproduzível.
5. **Amostragem “Equilibrado”** (padrão) — temperatura 0,75 e top-k/top-p mais fechados que o padrão do modelo (0,9) reduzem variações de entonação sem travar a geração. “Estável” (0,6) varia ainda menos, mas temperatura baixa faz o modelo repetir em vez de encerrar a fala: num teste com 6 seeds ele entrou em loop em 2, contra nenhuma do “Equilibrado”. “Padrão do modelo” e “Expressivo” soltam a variação quando você quer mais emoção.
6. **Divisão de textos longos** — textos grandes são quebrados em frases (até “Máx. caracteres por trecho”, padrão 220) e cada trecho é gerado com o mesmo condicionamento e a mesma seed, evitando que a voz “derive” ao longo de um áudio longo. Os trechos são unidos com a pausa configurada. Em voice design sem perfil, o 1º trecho vira referência e os demais são clonados dele.
7. **Pós-processamento uniforme** — silêncio aparado nas pontas e volume normalizado (RMS −20 dBFS por padrão, ou pico −1 dBFS), para que clipes gerados em momentos diferentes tenham o mesmo nível.
8. **Detecção de loop** — se uma geração não termina (bate no limite de tokens, ~2× a duração esperada do texto), o servidor refaz o trecho com seeds derivadas (seed+1000, seed+2000) e registra no 🐞 Debug. O resultado continua reproduzível: a mesma entrada sempre percorre as mesmas seeds.

> **A frase de referência tem que ser curta.** Ela existe só para definir o *timbre*, não o repertório: 5–15 s bastam (~75–225 caracteres latinos, ~30–60 japoneses), acima de 25 s o editor avisa e **acima de 30 s estimados ele recusa antes de usar a GPU**. O modelo **fala a frase inteira** para criar a voz, a cerca de 1 s de áudio por 11 s de GPU — um roteiro de 6 000 caracteres japoneses daria 20 min de fala e **horas** de geração, para um perfil que sairia inútil. O limite é em segundos, não em caracteres, porque um caractere japonês rende quase 3× a duração de um latino. Com uma referência longa — especialmente uma lista de exclamações curtas separadas por pausas — o modelo tende a **emendar o fim da referência no começo de cada fala gerada**, e aquela última frase vira um prefixo em tudo. Não coloque as falas do personagem na referência: elas são o que você vai gerar depois.

### Refazer um áudio só (↻)

Um lote de texto × voz × takes vira dezenas de áudios; quando **um** sai ruim, não é preciso refazer o resto.

- Cada áudio da prévia tem um **↻** que refaz **só ele** e o coloca de volta na mesma posição — a ordem texto × voz não muda, e os demais áudios não são tocados.
- O clique usa a **seed seguinte** à daquele áudio (e a cada clique avança mais uma), que é o que resolve take em loop, fala cortada ou entonação ruim. **Shift+clique** abre um campo para digitar a seed exata.
- O texto, a voz e o idioma vêm do próprio áudio; os ajustes de geração (modelo, amostragem, divisão, pausa, normalização) vêm dos campos **atuais** do node — dá para corrigir um parâmetro e refazer só o item afetado.
- A prévia lista **todos** os áudios do node numa área rolável (até 300 px de altura; a roda do mouse rola a lista em vez de dar zoom no canvas, e a posição é mantida quando você refaz um item). Com mais de 12 áudios o `preload` é desligado, então a duração só aparece depois do play — é o que mantém o node leve.
- O mesmo ↻ existe no visualizador **⤢**, para ouvir em tela cheia.
- Quando alguma combinação **falha**, ela fica registrada no resultado e aparece a linha **“↻ Refazer os que falharam”**, que tenta de novo só essas, em série. O que já deu certo nunca é gerado de novo. Exceção: se *todas* as vozes de um mesmo texto falharem, o node inteiro falha e não há o que refazer por item — normalmente é o servidor local fora do ar.
- Enquanto o ▶ estiver rodando, o ↻ fica bloqueado: o servidor local gera um áudio por vez.
- Coletar e Visualizador ligados ao node são atualizados logo depois, então o zip e o áudio único já saem com a versão nova.

### Receitas

- **Personagem de jogo com várias falas**: Texto (uma fala por linha) → Dividir → **Fala** ← **Voz** (descrição do personagem). É o Exemplo 3. Para outro personagem, duplique o node Voz com outro nome e conecte a outro node Fala.
- **Mesma voz em workflows diferentes**: crie o perfil uma vez; nos outros workflows use só o node Fala com “Voz salva” e escolha o perfil na lista (⟳ atualiza a lista).
- **Clonar uma voz real**: Áudio (upload) → Voz (origem “Áudio de referência”, transcrição exata) → Fala. Use só vozes que você tem direito de usar.
- **A mesma fala em várias vozes** (escolher o elenco, comparar vozes): node Fala com “Várias vozes”, marque as vozes/speakers → um áudio por voz. Ligue num **Coletar resultados** para baixar tudo num .zip, com o nome da voz em cada arquivo.
- **Emoção por fala**: estilo/emoção só funciona com speaker pré-definido (limitação do modelo Base, usado na clonagem). Para um personagem com emoções diferentes e timbre fixo, crie perfis separados a partir do mesmo speaker com estilos diferentes (ex.: `guarda_calmo`, `guarda_bravo`).

### Dicas para uma boa voz

- A frase de referência define o jeito de falar: escreva-a no estilo do personagem e **no mesmo idioma das falas**; 8–15 s rende a melhor clonagem.
- Na descrição, seja concreto: “mulher de 30 anos, voz média e calorosa, fala clara e tranquila” funciona melhor que “voz bonita”.
- Se a voz criada não agradar, mude a seed do perfil e marque “Recriar” — cada seed gera uma variação da mesma descrição. Quando gostar, não mexa mais na seed.
- Mantenha a mesma amostragem e o mesmo tamanho de modelo em todas as falas de um personagem (1.7B e 0.6B clonam com pequenas diferenças).

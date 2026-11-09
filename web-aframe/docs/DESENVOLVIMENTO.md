# PrevQuedasRV Web — guia de desenvolvimento

Este guia é para quem vai manter ou estender o código. Ele cobre a arquitetura, a estrutura de pastas,
o formato dos dados, o salvamento, as telas do app e do editor e as convenções que não são óbvias
lendo o código. Para usar o editor, veja o [tutorial de uso](TUTORIAL.md).

---

## 1. Visão geral

O projeto tem três partes, e todas rodam localmente:

| Parte | Arquivo de entrada | Precisa do servidor? | Para que serve |
|---|---|---|---|
| **App** (visitante) | `public/index.html` | **Não**: só lê arquivos estáticos | Experiência em RV: Cardboard ou "janela mágica" no celular |
| **Editor** | `public/editor.html` | Sim | Criar e editar ambientes no PC |
| **Servidor local** | `tools/server.js` | — | Serve `public/` e grava os ambientes em disco |

```
            ┌──────────── PC (desenvolvimento / autoria) ─────────────┐
 Unity  ──► │ tools/export-unity.js ──► public/data/scenes.js          │
 (Assets)   │                          public/assets/ (glb, mp3, png)  │
            │                                                         │
            │ editor.html ──HTTP──► tools/server.js ──► public/ambientes/ (json + arquivos)
            └─────────────────────────────────────────────────────────┘
                                         │  (pasta public/ copiada como está)
                                         ▼
                 index.html (app) — navegador do celular ou WebView do React Native
                 lê data/scenes.js + ambientes/index.json + ambientes/<id>/ambiente.json
```

Stack: **A-Frame 1.7.1** (three.js r173, fork `super-three`), JavaScript puro sem bundler.
O editor é um módulo ES que importa `OrbitControls` e `TransformControls` do three.js por import map.
O servidor é Node puro, **sem dependências**.

---

## 2. Rodando

```bash
cd web-aframe
npm install          # aframe, fbx2gltf (para o exportador)
npm run export       # Unity -> public/data, public/assets, public/vendor (inclui os addons do three)
npm start            # node tools/server.js -> http://localhost:8080
npm run phone        # adb reverse tcp:8080 + servidor (testar no Android via USB)
npm run vendor       # só recopia OrbitControls/TransformControls para public/vendor/three-addons
```

O servidor aceita `--port` e `--host` (padrão `127.0.0.1`). Para abrir pela rede local, use `node tools/server.js --host 0.0.0.0`.
Nesse caso o giroscópio do celular só funciona em `localhost` ou HTTPS.

URLs úteis:

- `http://localhost:8080/?cena=0..5`: cenas originais (0 tutorial, 1 menu, 2–5 cômodos).
- `http://localhost:8080/?amb=<id>&modo=magic`: um ambiente criado no editor, sem a tela de entrada.
- `http://localhost:8080/editor.html#<id>`: abre o editor direto num ambiente.

---

## 3. Estrutura de pastas

```
web-aframe/
├─ package.json
├─ README.md                    índice + início rápido
├─ docs/
│  ├─ DESENVOLVIMENTO.md        este arquivo
│  ├─ TUTORIAL.md               manual de uso
│  └─ img/                      prints usados nos docs
├─ tools/
│  ├─ export-unity.js           lê ../Assets (cenas .unity, .mat, .meta, FBX, WAV) e gera os dados
│  ├─ vendor-addons.js          copia addons do three + gera o "shim" three.js para o import map
│  └─ server.js                 servidor estático + API do editor (sem dependências)
└─ public/                      tudo que vai para o celular/APK
   ├─ index.html                app do visitante
   ├─ editor.html               editor
   ├─ css/app.css, css/editor.css
   ├─ js/
   │  ├─ engine.js              motor compartilhado (monta qualquer ambiente)  -> window.PrevEngine
   │  ├─ app.js                 app do visitante                                -> window.PrevQuedas
   │  ├─ editor.js              editor (módulo ES)                              -> window.PrevEditor
   │  ├─ components.js          componentes A-Frame
   │  └─ stereo.js              modo Cardboard (system "stereo-mode")
   ├─ data/scenes.js            GERADO: cenas originais, materiais, UI  -> window.PREV_DATA
   ├─ assets/                   GERADO: models/*.glb, audio/*.mp3, textures/*.png, ui/*.png, video/*.mp4
   ├─ vendor/                   GERADO: aframe.min.js, three-addons/
   └─ ambientes/                criado pelo servidor: conteúdo feito no editor (versionar se quiser)
      ├─ index.json
      └─ <id>/ambiente.json, <id>/arquivos/*
```

O que é **gerado** (`data/`, `assets/`, `vendor/`) não deve ser editado à mão. Rode `npm run export` de novo.

---

## 4. Telas

### 4.1 App (`index.html` + `app.js`)

| Tela | Rota interna (`goTo`) | Montada por | O que faz |
|---|---|---|---|
| Entrada (HTML) | — | `index.html` `#intro` | Botões "Usar com óculos" e "Ver sem óculos". O gesto do usuário libera áudio, tela cheia e giroscópio. |
| Tutorial | `tutorial` (ou `0`) | `buildTutorial()` | Vídeo num painel 3D, play/pause, barra de progresso, "Avançar". |
| Menu | `menu` (ou `1`) | `buildMenu()` | Os 4 cômodos originais e, se houver ambientes publicados, o card "Outros ambientes". |
| Outros ambientes | `lista:<página>` | `buildList()` | Grade 3×2 com miniaturas e paginação. Deixa um vão no centro, para a mira não abrir nada sozinha. |
| Cômodo original | `unity:<2..5>` (ou `2..5`) | `buildEnv(E.fromUnity(key))` | Cena exportada do Unity. |
| Ambiente do editor | `amb:<id>` | `fetch ambientes/<id>/ambiente.json` → `buildEnv` | Cômodo 3D ou foto 360°. |

Elementos fixos da cena: `#world` (conteúdo, limpo a cada troca), `#rig > #recenter > #camera > #cursor`.

- **`#rig`**: posição e orientação inicial do ambiente (o visitante olha para **+Z** do rig).
- **`#recenter`**: depois de montar, gira o rig para que o "para frente" da cena fique onde a pessoa já está olhando (`recenterView()`). Também carrega o componente `look-down-menu`.
- **`#cursor`**: mira com `fuse` de 1800 ms. O raio sai da câmera (`raycaster.origin` compensa a distância da mira) e atinge apenas `.clickable`.

### 4.2 Editor (`editor.html` + `editor.js`)

**Lista** (`#home`)
- Cards "Criar ambiente": Cômodo 3D vazio, Cópia de um cômodo original, Foto 360° e Importar pacote.
- Grade "Meus ambientes", com as ações Editar, Testar, Duplicar, Exportar e Excluir.

**Área de edição** (`#workspace`, grade de 3 colunas)

| Região | Id | Conteúdo |
|---|---|---|
| Barra superior | `.topbar` | Nome editável, status de salvamento, desfazer/refazer, "Testar no app". |
| Painel esquerdo | `#tree` | Árvore de objetos, ou lista de pontos no modo foto. A bolinha tem a cor da marcação e o olho mostra ou esconde o objeto. |
| Centro | `#viewport` | Cena A-Frame `embedded`. |
| Painel direito | `#props` | Propriedades. O conteúdo depende do que está selecionado. |

Barras de ferramentas do centro:
- **`#vp-toolbar`** (cômodo 3D): Mover/Girar/Tamanho (W/E/R), No chão, Focar, De cima, Visitante e Sem teto.
- **`#vp-toolbar-photo`** (foto 360°): "+ Colocar ponto".

O painel direito (`renderProps()`) muda conforme a seleção:

| Seleção | Função | Seções |
|---|---|---|
| Nada | `envProps()` | Cômodo (medidas, piso, cores, teto), Aparência (brilho, fundo), Visitante, Narração de abertura, Publicação (publicar, exportar, excluir). No modo foto: trocar a foto e a direção inicial. |
| Boneco (`__spawn`) | `spawnProps()` | Posição, direção do olhar, "Pôr no centro da vista", "Ver como visitante". |
| Objeto | `nodeProps()` | Nome, visível, cor (formas), luz, Posição e tamanho, **Marcação** (`interactionSection`), ações. |
| Ponto da foto | `hotspotProps()` | Nome, legenda, tamanho do sinal, Marcação, ações. |

Diálogos (`<dialog>`):
- `#dlg-room`: novo cômodo.
- `#dlg-copy`: escolher um original.
- `#dlg-photo`: nome e foto.
- `#dlg-add`: abas **Objetos dos cômodos**, **Formas e marcadores** e **Modelos 3D (.glb)**.

Atalhos (ignorados enquanto se digita num campo):

| Tecla | Ação |
|---|---|
| Ctrl+S | Salvar agora |
| Ctrl+Z / Ctrl+Y (ou Ctrl+Shift+Z) | Desfazer / refazer |
| Ctrl+D | Duplicar |
| Delete / Backspace | Excluir |
| W / E / R | Mover / girar / tamanho |
| F | Focar no objeto |
| Esc | Cancela "colocar ponto", sai do modo visitante ou solta a seleção |

---

## 5. Formato de um ambiente (`ambiente.json`)

```jsonc
{
  "id": "quarto-da-dona-maria-1a0f78",     // definido pelo servidor (slug do nome + 6 hex)
  "name": "Quarto da Dona Maria",
  "type": "model",                          // "model" (3D) | "photo" (foto 360)
  "published": true,                        // aparece em "Outros ambientes" no app
  "thumb": "ambientes/<id>/arquivos/miniatura.jpg",
  "updatedAt": "2026-11-08T21:26:12.124Z",  // definido pelo servidor
  "background": "#9fb6bf",
  "brightness": 1,                          // multiplicador das luzes
  "camera": { "position": [0, 1.6, 1.2], "yaw": 180 },     // ou { position, rotation: [qx,qy,qz,qw] }
  "intro": { "text": "…", "audio": null },  // narração ao entrar

  // ---- só type "model"
  "lighting": "room",                       // "room" (luzes padrão) | "unity" (luzes da cena original)
  "ambient": { "sky": [r, g, b] },          // usado com lighting "unity"
  "room": { "width": 4, "depth": 3.6, "height": 2.7, "floorColor": "#c8b59a",
            "wallColor": "#e8e4dc", "floorTexture": "lajota-madeira-gimp", "ceiling": true },
  "nodes": [ /* árvore de nós, ver abaixo */ ],
  "source": "3-Quarto-risco",               // só nas cópias de originais (informativo)

  // ---- só type "photo"
  "photo": "ambientes/<id>/arquivos/foto-abc.jpg",   // equiretangular 2:1
  "hotspots": [ { "id": "h1", "name": "Tapete", "label": "Tapete", "yaw": -119.8, "pitch": -63.9,
                  "size": 1.6, "interactive": { /* igual ao dos nós */ } } ]
}
```

**Nó** (`nodes[]`, recursivo via `children`):

```jsonc
{
  "id": "k3j9x0a", "name": "Tapete solto",
  "position": [x, y, z], "rotation": [qx, qy, qz, qw], "scale": [sx, sy, sz],   // locais ao pai
  "hidden": true,                     // opcional
  "group": true,                      // conjunto da biblioteca: clique seleciona o grupo
  "mesh": { "model": "quarto", "name": "luminaria" }      // malha de assets/models/<model>.glb
       |  { "file": "ambientes/<id>/arquivos/modelo-x.glb" }  // glb importado (cena inteira)
       |  { "primitive": "box|cylinder|sphere|plane|marker", "color": "#hex" },
  "materials": ["madeira-clara"],     // ids de PREV_DATA.materials, um por primitiva
  "box": { "center": [..], "size": [..] },                // BoxCollider do Unity (área de seleção)
  "light": { "type": "point", "hex": "#fff3e0", "intensity": 1, "range": 5 },  // luz do editor
                                     // (luzes do Unity usam { type, color:[r,g,b], intensity, range })
  "interactive": {
    "kind": "risco|prevencao|info",
    "title": "…", "text": "…",
    "audio": "assets/audio/x.mp3" | "ambientes/<id>/arquivos/audio-x.webm" | null,
    "action": null | "menu" | "amb:<id>",
    "hover": "prevencao"              // opcional: id de material de destaque (herdado do Unity)
  },
  "children": [ … ]
}
```

Os caminhos de arquivos são sempre **relativos à raiz de `public/`**, como `ambientes/<id>/arquivos/...`.
Assim o JSON funciona igual no servidor, no celular e dentro do APK.

`PrevEngine.normInteractive()` também aceita o formato antigo exportado do Unity (`{audio, hover, scene}`)
e o converte, por exemplo `scene: 1` → `action: "menu"`.

---

## 6. Salvamento e servidor

### 6.1 Como o editor salva

1. Toda alteração passa por `mutate(fn, opts)`, que:
   - tira um snapshot (`JSON.stringify(env)`) e aplica `fn`;
   - se algo mudou, empilha o snapshot em `undo` (máx. 100) e limpa `redo`;
   - chama `afterChange()`, que agenda o salvamento e redesenha a árvore, as propriedades e a cena 3D, conforme as opções.
2. Campos de texto usam `bindText()`:
   - atualizam o objeto **a cada tecla**, sem redesenhar;
   - registram **um** passo de desfazer por edição (snapshot no `focus`, empilhado no `change`).
3. O gizmo (setas) usa `dragging-changed`: guarda o snapshot no início do arrasto e o empilha no fim.
   Durante o arrasto, `objectChange` grava posição, rotação e escala direto no nó.
4. `scheduleSave()` tem *debounce* de 700 ms e depois chama `saveNow()`, que faz `PUT /api/ambientes/<id>` com o JSON inteiro.
   Os salvamentos são serializados (`saving`/`savePending`). O status aparece na barra: "Alterado…", "Salvando…", "Salvo" ou "Erro ao salvar".
5. Se a página for fechada com salvamento pendente, `beforeunload` pede confirmação.
6. Desfazer e refazer trocam o `env` inteiro pelo snapshot e remontam a cena. A seleção é mantida se o nó ainda existir.

**Arquivos enviados** (áudio, foto, `.glb`):
- São gravados na hora, com `PUT /api/ambientes/<id>/arquivos/<nome>`, e o caminho retornado é posto no JSON.
- Os nomes levam sufixo aleatório (`audio-<uid>.webm`), então trocar um arquivo não sobrescreve o antigo.
  Com isso, desfazer sempre aponta para um arquivo que ainda existe.
- Arquivos que deixaram de ser usados **não** são apagados automaticamente. Eles só somem quando o ambiente é excluído.

**Miniatura** (`captureThumb()`):
- É gerada ao sair do ambiente, ao clicar em "Testar no app" e ao abrir um ambiente que ainda não tem miniatura.
- O processo:
  1. esconde os auxiliares (gizmo, contornos, boneco, corte do teto);
  2. renderiza do ponto de vista do visitante;
  3. recorta em 480×270 e envia `miniatura.jpg`.

### 6.2 API do servidor (`tools/server.js`)

| Método e rota | Corpo | Resposta / efeito |
|---|---|---|
| `GET /api/ambientes` | — | Lista: `[{id,name,type,published,thumb,updatedAt,order}]`. Também regenera `index.json`. |
| `POST /api/ambientes` | ambiente (JSON) | Cria com id novo e devolve o ambiente salvo. |
| `GET /api/ambientes/:id` | — | `ambiente.json` |
| `PUT /api/ambientes/:id` | ambiente (JSON) | Sobrescreve, define `id` e `updatedAt` e regenera `index.json`. |
| `DELETE /api/ambientes/:id` | — | Apaga a pasta inteira do ambiente. |
| `POST /api/ambientes/:id/duplicar` | — | Copia a pasta, troca `ambientes/<old>/` por `ambientes/<new>/` no JSON e marca `published=false`. |
| `GET /api/ambientes/:id/pacote` | — | Download de `<id>.prevamb.json`: `{formato, versao, id, ambiente, arquivos:{nome: base64}}`. |
| `POST /api/importar` | pacote | Cria um ambiente novo a partir do pacote, com caminhos reescritos e `published=false`. |
| `PUT /api/ambientes/:id/arquivos/:nome` | binário | Grava o arquivo (máx. 200 MB) e devolve `{path}`. |
| `DELETE /api/ambientes/:id/arquivos/:nome` | — | Apaga o arquivo. |

Detalhes:
- **Validação de nomes:**
  - id: `^[a-z0-9][a-z0-9-]{0,63}$`;
  - nome de arquivo: `^[\w][\w.-]{0,120}$`;
  - caminhos estáticos fora de `public/` dão 403.
- **Gravação atômica:** escreve em `arquivo.tmp` e depois faz `rename`.
- **`index.json`:** é reescrito a cada gravação. Fica ordenado por `order` e nome, e o app só mostra os itens com `published: true`.
- **Arquivos estáticos:** vão com `Cache-Control: no-cache` e suporte a `Range`, que o vídeo e o áudio usam para avançar e voltar.
- **Acesso:** só escuta em `127.0.0.1`. **Não há autenticação**: não exponha o servidor na internet.

---

## 7. Motor (`engine.js`, `window.PrevEngine`)

Funções principais:

| Função | Uso |
|---|---|
| `build(env, {world, rig, onActivate, editor})` | Monta o ambiente dentro de `world`. Devolve `Promise<ctx>` quando as malhas carregaram. `ctx.entities[id]` é a entidade de cada nó. |
| `clearWorld(world)` | Remove entidades e objetos three soltos (luzes direcionais, casco do cômodo). |
| `fromUnity(key)` | Converte uma cena original de `PREV_DATA` num ambiente (ids novos, câmera composta, interações normalizadas). |
| `newRoomEnv(name,w,d,h)` / `newPhotoEnv(name, photo)` | Ambientes vazios. |
| `libraryFromOriginals()` | Itens "Objetos dos cômodos": conjuntos (`PRESETS`) e peças avulsas, com a transformação de mundo já aplicada e a posição zerada. |
| `normInteractive(it)` | Normaliza a interação. |
| `dirFromYawPitch` / `yawPitchFromDir` | Conversão de direções (ver §8). |

Como um nó vira entidade (`buildNode`):
1. Cria uma `a-entity` com `data-node-id` e TRS (posição, rotação e escala).
2. Monta a malha:
   - glTF do Unity: `meshFrom()` clona a malha e **zera a transformação**, porque o GLTFLoader aplica a TRS do nó glTF no objeto da malha;
   - `.glb` importado: clona a cena inteira;
   - formas: geometria do three.
3. Monta os filhos.
4. Se houver interação, cria uma **caixa invisível de seleção** (`[data-hit-for]`, classe `.clickable`):
   - usa `n.box` (BoxCollider do Unity) quando existe;
   - senão, a caixa envolvente do **nó e de todos os filhos**, depois que as malhas carregam. É isso que faz um conjunto inteiro ser selecionável.

   O componente `interactive` troca o material ao olhar: o material `risco`/`prevencao` do Unity, ou a cor do tipo. Nos marcadores, ele aumenta o sinal.

Luzes:
- `lighting: "unity"` reproduz a iluminação da cena original (hemisfério, ambiente e luzes da cena).
- `lighting: "room"` usa hemisfério, ambiente, uma pontual no teto e uma direcional.
- As duas são multiplicadas por `brightness`.

Casco do cômodo gerado (`buildRoomShell`):
- piso, 4 paredes, rodapé e teto, como **planos voltados para dentro**;
- vistos de fora, eles somem por *backface culling*, e por isso o editor enxerga o cômodo de cima.

---

## 8. Convenções de coordenadas

- **Unity → three:** o exportador espelha X: posição `(-x, y, z)`, quaternion `(x, -y, -z, w)`, escala igual.
- **"Para frente" = +Z do rig.** É assim no Unity, e o app gira o `#recenter` para alinhar.
  - Em `camera: {yaw}`, `yaw` é o ângulo de +Z em torno de Y, em graus: `yaw = atan2(dir.x, dir.z)`.
  - A câmera do three olha para −Z. Por isso o editor soma π ao converter (`setLookFromEnvYaw`), e a miniatura multiplica por uma rotação de 180°.
- **Pontos da foto 360°:**
  - `yaw`/`pitch` em graus, com `dir = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch)`;
  - o ponto fica a `PHOTO_RADIUS = 4` m de `(0, EYE=1.6, 0)`.
- **Esfera da foto:** o `a-sky` usa escala `-1 1 1`. O pixel `(u, v)` da imagem aparece na direção `(cos 2πu·sin πv, cos πv, sin 2πu·sin πv)`.
  Isso só importa se você **gerar** panorâmicas por código, como foi feito para os prints da documentação.

---

## 9. Componentes A-Frame (`components.js`, `stereo.js`)

| Componente | Função |
|---|---|
| `canvas-text` | Texto desenhado em canvas (acentos e offline). Diminui a fonte até caber na largura. |
| `text-panel` | Placa com título e parágrafo, quebra de linha automática e faixa colorida do tipo. |
| `fuse-ring` | Anel de progresso da seleção pelo olhar, em volta da mira. |
| `interactive` | Destaque ao olhar: troca o material do alvo ou aumenta o marcador. |
| `look-at-camera` | Vira a entidade para a câmera. `yOnly: true` gira só no eixo vertical; `false` é um billboard completo, usado pela placa e pelas legendas. |
| `look-down-menu` | Botão "⌂ Menu" perto dos pés, quando o *pitch* passa de −70°. Emite `menu-requested`. **O limite é de propósito:** objetos no chão ficam entre −40° e −65°, e um limite menor faria a mira selecionar "Menu" ao olhar um tapete. |
| `stereo-mode` (system) | Cardboard sem WebXR. Intercepta `renderer.render` e desenha olho esquerdo e direito com `THREE.StereoCamera` (scissor/viewport). Não há correção de distorção das lentes. |

O app registra ainda `panel-watch`, que fecha a placa quando a pessoa desvia o olhar mais de 40°.
O editor registra `editor-tick`, que atualiza os contornos dos objetos.

---

## 10. Detalhes do editor

- **Câmera:**
  - Cômodo 3D: `OrbitControls`.
  - Foto 360° e modo Visitante: "olhar arrastando", com `look.yaw` e `look.pitch` e rotação `YXZ` na câmera.
  - A roda do mouse muda o FOV.
- **Seleção:**
  - O clique (sem arrastar) faz um raycast no `#world`. `nodeIdOf()` sobe a hierarquia até achar `data-hit-for` ou `data-node-id`.
  - `groupTarget()` faz o primeiro clique numa peça de um `group` selecionar o conjunto e o segundo selecionar a peça.
  - Raycasts que podem atingir sprites (marcadores) precisam de `raycaster.camera`.
- **Corte do teto ("Sem teto"):**
  - É um `THREE.Plane` aplicado como `material.clippingPlanes` em todos os materiais do mundo (`renderer.localClippingEnabled = true`).
  - A altura vem da parte de baixo dos nós chamados `teto*` (cômodos do Unity) ou de `room.height`.
  - Fica desligado no modo Visitante e na miniatura.
- **"No chão":** lança um raio para baixo a partir do centro do objeto, ignorando o próprio objeto e as caixas invisíveis, e apoia na primeira superfície encontrada.
- **Gravação de áudio:** `MediaRecorder` (normalmente `audio/webm;codecs=opus`). Não toca no Safari do iOS.
- **`<dialog>`:** o `returnValue` sobrevive entre aberturas, e Esc não o limpa. Por isso existe `openDialog()`.

---

## 11. Exportador do Unity (`tools/export-unity.js`)

- Lê os `.meta` para montar `guid → arquivo` e os nomes das malhas (`fileIDToRecycleName`).
- Faz o parse do YAML das cenas por tipo de documento:
  - `1` GameObject, `4` Transform, `33`/`23` MeshFilter/Renderer, `65` BoxCollider;
  - `82` AudioSource, `108` Light, `114` MonoBehaviour (EventTrigger), `1001` instância de prefab.
- **EventTrigger:** `eventID 0` é a entrada (troca o material), `4` é o clique (`AudioSource.Play` ou `AbrirCena(n)`).
- Converte FBX → GLB com o **FBX2glTF**, WAV → MP3 com o **ffmpeg**, se disponível, e copia texturas, UI e o vídeo.
- **Armadilhas que já deram problema:**
  - GUIDs que começam com dígitos não podem virar número: há uma regex estrita em `obj()`;
  - a câmera é filha de um transform *stripped* de prefab: o fallback é `'pi:'+id`.

---

## 12. APIs globais (integração e testes)

`window.PrevQuedas` (app):

| Membro | Função |
|---|---|
| `goTo(rota \| número)` | Navega para uma rota (ver §4.1). |
| `setStereo(bool)` | Liga ou desliga o modo Cardboard. |
| `recenter()` | Recentraliza a vista. |
| `look(yawGraus, pitchGraus)` | Aponta o olhar, útil em testes. |
| `current()` | Rota atual. |
| `nowPlaying()` | Áudio tocando, ou `null`. |
| `panel()` | Dados da placa aberta, ou `null`. |

Dentro do WebView, o app envia `{type:'scene', route}` por `ReactNativeWebView.postMessage` a cada troca de tela.

`window.PrevEditor` (editor):
- `openEnv(id)`, `closeEnv()`, `select(id)`, `addNode(node)`, `dropToFloor(id)`
- `mutate(fn, opts)`, `saveNow()`, `captureThumb()`, `setFirstPerson(bool)`, `library()`
- getters `env`, `envId`, `selectedId`, `ctx`, `camera`, `orbit`

Não há testes automatizados versionados no repositório. Durante o desenvolvimento, os testes foram feitos com
**puppeteer-core** no Chrome headless (`--use-angle=swiftshader`), usando essas APIs para mirar com o cursor
real e conferir áudio, placa e navegação. Para recriar uma bateria de testes, use essas APIs.

---

## 13. Como estender

- **Novo tipo de forma:** some em `primitiveMesh()` (engine) e no array `SHAPES` (editor).
- **Novo conjunto de móveis:** adicione um item em `PRESETS` (engine) com `scene` e a lista de nomes de nós.
- **Nova ação ao selecionar:** trate em `onActivate()` (app) e adicione a opção no `<select>` de `interactionSection()` (editor).
- **Novo campo do ambiente:** leia em `build()`/`addLights()` (engine) e edite em `envProps()` (editor). Use `mutate()` para manter o desfazer funcionando.
- **Empacotar no app React Native CLI:** copie `public/` para `android/app/src/main/assets/www/` e sirva por
  `WebViewAssetLoader` (`https://appassets.androidplatform.net/`), para ter contexto seguro e giroscópio.
  Abra `index.html?modo=cardboard`. O editor e o `tools/` não precisam ir para o APK.

---

## 14. Limitações conhecidas

- **Iluminação:** é em tempo real, não reproduz os lightmaps do Unity.
- **Cardboard:** sem correção de distorção das lentes.
- **Áudio:** tocar um novo interrompe o anterior.
- **Cômodos gerados:** sempre retangulares, sem vãos de porta ou janela.
- **Áudio gravado:** `.webm` não toca no Safari do iOS.
- **Editor:** feito para PC (mouse e teclado). Não há controle de acesso nem edição simultânea.
- **Arquivos órfãos:** áudios e fotos substituídos ficam na pasta do ambiente até ele ser excluído.

# herdr-mod-manager

Fonte da verdade do mod `mod-manager`: uma tela **Mods** (estilo settings) que lista os mods instalados com um switch para ativar/desativar, navega os mods do herdr.dev (aba **Browse**) e atualiza os instalados de lá.

- `mods/mod-manager/main.js` — o diálogo (abre com `mod.open mod-manager`, atalho sugerido `cmd-shift-,`).
- `mods/mod-manager/manager.js` — lógica pura (sem imports `herdr`): referências de um mod em layouts, fallback, desativar e restaurar. Testada com `node --test test/`.
- `mods/mod-manager/catalog.js` — lógica pura do índice `https://assets.herdr.dev/mods/index.json`: validação das listagens, updates pendentes, nome livre, renomear paths/keys, merge de `keys.json`, notas de risco. Testada com `node --test test/`.

## Como desativar funciona

1. Nos layouts pessoais (`layouts/*.json`, nunca os shipped de `installed.json`) que usam o mod: o bloco troca para o `cloned_from` do `mod.json`, senão para o mod shipped com o nome do id do bloco, senão fica `hidden`; header de stack volta para `tabs`; header de pane é removido; `terminal_menu` é apagado (volta o `menu`).
2. A pasta vai para `~/.config/herdr-app/mods-disabled/<nome>` (o Herdr só carrega `mods/`).
3. As mudanças ficam em `mods-disabled/.mod-manager.json`; ativar move a pasta de volta e desfaz essas mudanças (localizando o nó pelo `id`), sem sobrescrever o que o usuário mudou depois.

## Browse, instalar e atualizar

- O índice fica em cache em `mods-disabled/.mod-manager-cache/index.json`; é buscado de novo ao abrir a tela, no botão refresh e uma vez por dia pelo `usage-status`.
- Instalar: baixa o tarball do repo no `headCommit` (`curl` + `tar`, em `.mod-manager-cache/dl-*`), mostra o que o código alcança (rede, programas, arquivos fora da pasta) e pergunta. Nome ocupado vira `nome-2` com paths renomeados. Keys são mescladas sem substituir as do usuário.
- A origem de cada instalação fica em `mods-disabled/.mod-manager-sources.json`: `key`, `modName`, `commit`, `tree` (hash git da pasta publicada, antes de renomear), `localTree` (hash da pasta instalada, para detectar edição local), `remoteCommit`/`remoteTree` (último commit consultado no GitHub).
- O `headCommit` do índice é do repo inteiro e muda por qualquer coisa. Se ele mudou, uma chamada por listagem a `api.github.com/repos/<repo>/contents/<path>/mods?ref=<commit>` dá o hash de cada pasta de mod. Só há update se o hash difere do `tree`; senão o `commit` avança. O hash local é calculado com `git` num repo temporário (`.mod-manager-cache/dl-git-*`) e bate com o do GitHub. Depois de um 403/429, espera 1 h. A lógica pura (`updateState`, `resolveSource`, `lookupsNeeded`) está em `catalog.js`. O update pergunta: **Replace** (backup em `mods-disabled/<nome>.old-<tempo>`, restaurado se o `herdr-app check` falhar), **Keep mine as a clone** (`herdr-app do mod.clone` para `<nome>-mine`, depois replace) ou **Cancel**.
- `mods-disabled/.mod-manager-updates.json` (`checkedAt`, `count`, `names`) é lido pelo `usage-status` para o badge do puzzle. O formato é compartilhado: mudou aqui, mude lá.
- Deletar (ícone de lixeira): tira dos layouts como o desativar, depois manda a pasta para a Lixeira (`mv` para `~/.Trash`, Finder via `osascript` se for negado; `gio trash`/`rm -rf` no Linux) e apaga os registros de disable e de origem.
- Não ligue (Link) mods mantidos por `sync.sh` de um repo local: update e sync se sobrescrevem.

Também abre pelo ícone de puzzle na status bar, que o `usage-status` (repo `herdr-usage-status`) mostra quando este mod está instalado, com a contagem de updates.

A tela de Settings nativa do Herdr não aceita seções de mods, por isso o mod é um diálogo próprio.

## Regra: sempre atualizar a pasta live do Herdr

Depois de **qualquer** mudança aqui:

```sh
./sync.sh
node --test test/
```

O `sync.sh` copia `mods/mod-manager` para `~/.config/herdr-app/mods/` e roda `herdr-app check`. Não edite a pasta live diretamente.

Atenção: o `sync.sh` de qualquer repo recoloca seus mods em `mods/`, ou seja, reativa um mod desativado.

## Skill

A skill `herdr-publish` está em `.agents/skills/herdr-publish/SKILL.md`.

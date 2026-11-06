# herdr-mod-manager

Fonte da verdade do mod `mod-manager`: uma tela **Mods** (estilo settings) que lista os mods instalados com um switch para ativar/desativar.

- `mods/mod-manager/main.js` — o diálogo (abre com `mod.open mod-manager`, atalho sugerido `cmd-shift-,`).
- `mods/mod-manager/manager.js` — lógica pura (sem imports `herdr`): referências de um mod em layouts, fallback, desativar e restaurar. Testada com `node --test test/`.

## Como desativar funciona

1. Nos layouts pessoais (`layouts/*.json`, nunca os shipped de `installed.json`) que usam o mod: o bloco troca para o `cloned_from` do `mod.json`, senão para o mod shipped com o nome do id do bloco, senão fica `hidden`; header de stack volta para `tabs`; header de pane é removido; `terminal_menu` é apagado (volta o `menu`).
2. A pasta vai para `~/.config/herdr-app/mods-disabled/<nome>` (o Herdr só carrega `mods/`).
3. As mudanças ficam em `mods-disabled/.mod-manager.json`; ativar move a pasta de volta e desfaz essas mudanças (localizando o nó pelo `id`), sem sobrescrever o que o usuário mudou depois.

Também abre pelo ícone de puzzle na status bar, que o `usage-status` (repo `herdr-usage-status`) mostra quando este mod está instalado.

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

# PrevQuedasRV — versão web (A-Frame)

Realidade virtual para **prevenção de quedas em casa**, recriada do app Unity original em A-Frame (three.js).
Roda no navegador do celular (com ou sem óculos Cardboard) e vem com um **editor de ambientes** para criar
cômodos novos, marcar riscos, gravar narrações e usar fotos 360° de casas reais. Tudo funciona localmente,
sem nuvem.

![App: placa de explicação ao olhar um risco](docs/img/app-placa.png)

## Documentação

| Documento | Para quem |
|---|---|
| **[Tutorial de uso](docs/TUTORIAL.md)** | Quem vai usar o app ou criar ambientes no editor, sem conhecimento técnico |
| **[Guia de desenvolvimento](docs/DESENVOLVIMENTO.md)** | Quem vai manter o código: arquitetura, pastas, telas, formato dos dados, salvamento, API |

## Início rápido

**Versão online:** https://manoeleric1212.github.io/PrevQuedasRV/ (app do visitante, publicado pelo GitHub Pages).

Para rodar localmente (necessário para usar o editor), basta ter Node 18+:

```bash
npm start           # http://localhost:8080
```

| Endereço | O que é |
|---|---|
| http://localhost:8080 | App do visitante |
| http://localhost:8080/editor.html | Editor de ambientes (PC) |

Para testar no Android com cabo USB, rode `npm run phone` e abra `http://localhost:8080` no Chrome do celular.

## Ambientes de exemplo

A pasta `public/ambientes/` vem com dois exemplos publicados, feitos no editor:

- **Quarto da Dona Maria**: cômodo 3D com riscos marcados.
- **Banheiro da Dona Maria (foto 360°)**: foto panorâmica com pontos marcados.

Eles aparecem no app em "Outros ambientes" e podem ser excluídos pelo editor.

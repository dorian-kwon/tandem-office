# Projetos de tradução

Um projeto de tradução reúne numa só pasta os documentos que você quer traduzir, seu material de referência e um glossário, e dá à IA as mesmas instruções todas as vezes. A IA ajuda a traduzir documentos do Word e de outros formatos, e pode traduzir um PDF de texto para um novo PDF.

## O que um projeto contém

- **Origem**: os documentos a traduzir. O app guarda uma cópia própria na pasta `source/` do projeto; o arquivo que você escolheu nunca é aberto nem alterado.
- **Referências**: material de apoio, como traduções anteriores ou guias de estilo.
- **Glossário**: os termos que devem ser sempre traduzidos da mesma forma.
- **Saída**: as traduções que você escreve, na pasta `output/` do projeto.

## As três telas

1. **Lista de projetos**: abra **Tradução** na barra lateral da Página inicial. Aqui você cria, abre e exclui projetos e escreve o prompt do sistema global, que vale para todos os projetos de tradução.
2. **Detalhes do projeto**: os idiomas, o prompt do projeto (instruções adicionais somente para este projeto), as listas de documentos a traduzir, referências e glossário, e a escolha para ler páginas digitalizadas (OCR). **Abrir tradução** em um documento inicia o trabalho.
3. **Visualização de tradução**: a cópia de origem à esquerda e a sua tradução à direita, lado a lado. O painel de origem é somente leitura. **Ocultar original** e **Ocultar tradução** dão a janela inteira ao outro painel, e o painel volta ao ponto em que estava.

## Glossário

- Adicione um arquivo `.csv`, `.xlsx` ou `.txt` (em `.txt` as colunas são separadas por tabulações). Cada linha é um termo.
- As colunas são o termo de origem, a tradução e, opcionalmente, uma observação. A primeira linha só é ignorada se nomear as duas primeiras colunas (por exemplo source e target, ou term e translation); qualquer outra primeira linha é lida como uma entrada do glossário.
- Os arquivos são lidos como UTF-8, e como CP949 quando não são UTF-8 válido, de modo que arquivos coreanos de programas antigos aparecem corretamente.
- Até 200 entradas são enviadas inteiras. Acima de 200, só são enviadas as entradas cujo termo de origem aparece no texto que está sendo traduzido.

## Arquivos de referência

- Com um pedido de tradução, só os nomes dos arquivos de referência são enviados, não o conteúdo deles.
- Quando precisa, a IA pode ler um arquivo de referência pelas ferramentas do projeto.

## PDFs digitalizados e imagens (OCR)

- Um PDF digitalizado ou uma imagem ainda não tem texto para traduzir, então a IA o lê primeiro. Nos detalhes do projeto, escolha qual IA lê: **IA (Claude)**, **IA (ChatGPT)** ou **Desativado**. Quando está desativado, digitalizações e imagens não podem ser abertas para tradução.
- Você escolhe as páginas a ler, uma a uma ou com **Selecionar tudo**. Só as páginas escolhidas são lidas.
- As imagens das páginas só são enviadas à IA depois que você confirma na tela de verificação, que mostra quantas páginas são enviadas e qual IA é usada. Isso pode usar a cota do seu plano, e uma conexão paga é identificada como paga antes de qualquer envio.
- O texto lido é salvo como documento do Word na pasta de saída. Traduza esse documento na visualização de tradução com o painel de IA.
- Imagens PNG e JPEG são aceitas. Imagens GIF, BMP, TIFF e WebP, imagens com mais de 20 MB e PDFs protegidos por senha não são.

## Tradução de PDF

- Um PDF de texto é traduzido para um novo PDF na pasta de saída. Você também pode escolher um PDF bilíngue, com a tradução ao lado de cada página original.
- A tela de verificação mostra o número de chamadas à IA e qual IA é usada antes de qualquer envio. A tradução de PDF de texto usa a **IA a usar** do app inteiro, nas Configurações, enquanto o OCR usa a IA escolhida no projeto.
- Se parar, **Gerar o que já está pronto** salva o que foi traduzido. Ao abrir o documento de novo, pressione **Continuar** para enviar apenas os blocos restantes.

## Limites

- Alterações no painel de origem não podem ser salvas. Em alguns editores é possível digitar na memória, mas o arquivo em `source/` não é gravado.
- **Traduzir novamente** traduz tudo desde o início, mas mantém os blocos que você mesmo editou na visualização bilíngue do editor de PDF.
- Árabe, hebraico e híndi não podem ser o idioma de destino de um PDF traduzido.
- Uma janela deixada aberta por muito tempo expira; abra-a novamente a partir do projeto.

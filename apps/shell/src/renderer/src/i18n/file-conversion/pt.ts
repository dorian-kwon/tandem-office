import type { zh } from './zh'

export const pt = {
  ocrLanguage: 'Idioma de reconhecimento',
  ocrLanguageDefault: 'Padrão do sistema',
  ocrLanguageUnavailable:
    'O idioma selecionado não está disponível. Escolha outro ou instale o idioma neste dispositivo.',
  ocrTitle: 'Executar OCR',
  ocrBatch: 'Iniciar OCR em lote',
  ocrPdf: 'PDF pesquisável',
  ocrWord: 'Word editável',
  ocrRunning: 'Reconhecendo texto…',
  ocrNoText: 'Nenhum texto legível encontrado.',
  ocrUnavailable: 'O OCR local não está disponível neste dispositivo.',
  title: 'Conversão de arquivos',
  chooseFiles: 'Escolher arquivos',
  outputFormat: 'Formato de saída',
  convert: 'Converter',
  converting: 'Convertendo…',
  destinationHint:
    'Cada arquivo convertido é salvo na pasta do original. Se o nome já estiver em uso, um número é acrescentado ao nome do novo arquivo.',
  noCommonFormat:
    'Os arquivos selecionados não têm um formato de saída em comum. Remova alguns da lista ou escolha outros.',
  chooseFailed: 'Não foi possível abrir a janela de seleção de arquivos.',
  convertFailed: 'Não foi possível concluir a conversão dos arquivos.',
  saved: 'Salvo',
  failed: 'Falha na conversão',
  removeFile: 'Remover {name} da lista',
  ocrRange: 'Páginas a reconhecer',
  ocrAllPages: 'Todas as páginas',
  ocrRangeInvalid: 'Verifique o intervalo de páginas deste arquivo. Exemplo: 1, 3–5',
} satisfies Record<keyof typeof zh, string>

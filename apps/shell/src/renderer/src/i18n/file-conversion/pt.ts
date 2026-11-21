import type { zh } from './zh'

export const pt = {
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
} satisfies Record<keyof typeof zh, string>

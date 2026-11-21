import type { zh } from './zh'

export const es = {
  title: 'Conversión de archivos',
  chooseFiles: 'Elegir archivos',
  outputFormat: 'Formato de salida',
  convert: 'Convertir',
  converting: 'Convirtiendo…',
  destinationHint:
    'Cada archivo convertido se guarda en la carpeta del original. Si ya existe un archivo con el mismo nombre, se añade un número al nombre nuevo.',
  noCommonFormat:
    'Estos archivos no tienen un formato de salida en común. Quita algunos de la lista o elige otros.',
  chooseFailed: 'No se pudo abrir el selector de archivos.',
  convertFailed: 'No se pudo completar la conversión de los archivos.',
  saved: 'Guardado',
  failed: 'Error de conversión',
  removeFile: 'Quitar {name} de la lista',
} satisfies Record<keyof typeof zh, string>

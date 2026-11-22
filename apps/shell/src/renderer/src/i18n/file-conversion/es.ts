import type { zh } from './zh'

export const es = {
  ocrLanguage: 'Idioma de reconocimiento',
  ocrLanguageDefault: 'Predeterminado del sistema',
  ocrLanguageUnavailable:
    'El idioma seleccionado no está disponible. Elige otro o instálalo en este dispositivo.',
  ocrTitle: 'Ejecutar OCR',
  ocrBatch: 'Iniciar OCR por lotes',
  ocrPdf: 'PDF con búsqueda',
  ocrWord: 'Word editable',
  ocrRunning: 'Reconociendo texto…',
  ocrNoText: 'No se encontró texto legible.',
  ocrUnavailable: 'El OCR local no está disponible en este dispositivo.',
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
  ocrRange: 'Páginas que se reconocerán',
  ocrAllPages: 'Todas las páginas',
  ocrRangeInvalid: 'Compruebe el intervalo de páginas de este archivo. Ejemplo: 1, 3–5',
} satisfies Record<keyof typeof zh, string>

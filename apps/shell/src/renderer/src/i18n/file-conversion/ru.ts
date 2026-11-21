import type { zh } from './zh'

export const ru = {
  title: 'Преобразование файлов',
  chooseFiles: 'Выбрать файлы',
  outputFormat: 'Выходной формат',
  convert: 'Преобразовать',
  converting: 'Преобразование…',
  destinationHint:
    'Каждый новый файл сохраняется в папке исходного файла. Если имя уже занято, к имени нового файла добавляется номер.',
  noCommonFormat:
    'У выбранных файлов нет общего выходного формата. Уберите часть файлов из списка или выберите другие.',
  chooseFailed: 'Не удалось открыть окно выбора файлов.',
  convertFailed: 'Не удалось завершить преобразование файлов.',
  saved: 'Сохранено',
  failed: 'Ошибка преобразования',
  removeFile: 'Убрать {name} из списка',
} satisfies Record<keyof typeof zh, string>

import type { zh } from './zh'

export const fr = {
  ocrLanguage: 'Langue de reconnaissance',
  ocrLanguageDefault: 'Langue par défaut du système',
  ocrLanguageUnavailable:
    'La langue sélectionnée est indisponible. Choisissez une autre langue ou installez-la sur cet appareil.',
  ocrTitle: 'Lancer l’OCR',
  ocrBatch: 'Lancer l’OCR par lot',
  ocrPdf: 'PDF avec recherche',
  ocrWord: 'Word modifiable',
  ocrRunning: 'Reconnaissance du texte…',
  ocrNoText: 'Aucun texte lisible détecté.',
  ocrUnavailable: 'L’OCR locale est indisponible sur cet appareil.',
  title: 'Conversion de fichiers',
  chooseFiles: 'Choisir des fichiers',
  outputFormat: 'Format de sortie',
  convert: 'Convertir',
  converting: 'Conversion en cours…',
  destinationHint:
    'Chaque fichier converti est enregistré dans le dossier de son original. Si le nom existe déjà, un numéro est ajouté au nouveau nom.',
  noCommonFormat:
    'Ces fichiers n’ont aucun format de sortie en commun. Retirez certains fichiers de la liste ou choisissez-en d’autres.',
  chooseFailed: 'Impossible d’ouvrir la fenêtre de sélection des fichiers.',
  convertFailed: 'Impossible de terminer la conversion des fichiers.',
  saved: 'Enregistré',
  failed: 'Échec de la conversion',
  removeFile: 'Retirer {name} de la liste',
  ocrRange: 'Pages à reconnaître',
  ocrAllPages: 'Toutes les pages',
  ocrRangeInvalid: 'Vérifiez la plage de pages de ce fichier. Exemple : 1, 3–5',
} satisfies Record<keyof typeof zh, string>

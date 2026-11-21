import type { zh } from './zh'

export const fr = {
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
} satisfies Record<keyof typeof zh, string>

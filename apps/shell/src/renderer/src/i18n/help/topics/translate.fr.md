# Projets de traduction

Un projet de traduction réunit dans un même dossier les documents que vous voulez traduire, vos documents de référence et un glossaire, et donne à l’IA les mêmes consignes à chaque fois. L’IA vous aide à traduire des documents Word et d’autres formats, et peut traduire un PDF texte en un nouveau PDF.

## Ce que contient un projet

- **Source** : les documents à traduire. L’application en garde une copie dans le dossier `source/` du projet ; le fichier que vous avez choisi n’est jamais ouvert ni modifié.
- **Références** : des documents de contexte, comme d’anciennes traductions ou des guides de style.
- **Glossaire** : les termes qui doivent toujours être traduits de la même façon.
- **Sortie** : les traductions que vous rédigez, dans le dossier `output/` du projet.

## Les trois écrans

1. **Liste des projets** : ouvrez **Traduction** dans la barre latérale de l’accueil. Vous y créez, ouvrez et supprimez des projets, et vous y écrivez le prompt système global, qui s’applique à tous les projets de traduction.
2. **Détail du projet** : les langues, le prompt du projet (consignes supplémentaires pour ce projet seulement), les listes de documents à traduire, de références et de glossaire, et le choix de lecture des pages numérisées (OCR). **Ouvrir la traduction** sur un document lance le travail.
3. **Vue de traduction** : la copie source à gauche et votre traduction à droite, côte à côte. Le volet source est en lecture seule. **Masquer la source** et **Masquer la traduction** donnent toute la fenêtre à l’autre volet, et le volet revient là où vous l’aviez laissé.

## Glossaire

- Ajoutez un fichier `.csv`, `.xlsx` ou `.txt` (dans un `.txt`, les colonnes sont séparées par des tabulations). Chaque ligne est un terme.
- Les colonnes sont le terme source, la traduction et, facultativement, une note. La première ligne n’est ignorée que si elle nomme les deux premières colonnes (par exemple source et target, ou term et translation) ; toute autre première ligne est lue comme une entrée du glossaire.
- Les fichiers enregistrés en UTF-16 (par exemple « Texte Unicode » d’Excel) sont reconnus. Les autres sont lus en UTF-8, et en CP949 s’ils ne sont pas de l’UTF-8 valide, de sorte que les fichiers coréens de programmes anciens s’affichent correctement.
- Jusqu’à 200 entrées sont envoyées en entier. Au-delà de 200, seules les entrées dont le terme source apparaît dans le texte à traduire sont envoyées.

## Fichiers de référence

- Quand vous ajoutez un fichier de référence, l’app le convertit en texte (gardé dans `references/.md/` ; le fichier lui-même n’est jamais modifié) et indexe ses mots. Les passages sont choisis d’après les mots de votre message et du texte sélectionné (dans le panneau IA, une fois à l’envoi) ou du lot en cours de traduction (dans la fenêtre PDF), et seuls les passages choisis sont envoyés, 6 000 caractères au plus, avec les noms des fichiers. Quand tout le texte de référence tient dans cette limite, il est envoyé en entier.
- Dans le détail du projet, chaque référence indique son état : **Converti en texte** (ouvrez-le avec **Voir le texte converti**, en lecture seule), **OCR nécessaire** (un scan ou une image : rien n’en est envoyé ; ajoutez-le comme document à traduire, lisez-le par OCR, puis ajoutez le document Word obtenu comme référence) ou **Lecture impossible**.
- Si besoin, l’IA peut lire un fichier de référence grâce aux outils du projet.

## PDF numérisés et images (OCR)

- Un PDF numérisé ou une image n’a pas encore de texte à traduire, donc l’IA le lit d’abord. Dans le détail du projet, choisissez quelle IA lit : **IA (Claude)**, **IA (ChatGPT)** ou **Désactivée**. Quand elle est désactivée, les numérisations et les images ne peuvent pas être ouvertes pour traduction.
- Vous choisissez les pages à lire, une par une ou avec **Tout sélectionner**. Seules les pages choisies sont lues.
- Les images des pages ne sont envoyées à l’IA qu’après votre confirmation sur l’écran de vérification, qui indique combien de pages sont envoyées et quelle IA est utilisée. Cela peut consommer le quota de votre abonnement, et une connexion payante est indiquée comme payante avant tout envoi.
- Le texte lu est enregistré dans un document Word dans le dossier de sortie. Traduisez ce document dans la vue de traduction avec le panneau IA.
- Les images PNG et JPEG sont prises en charge. Les images GIF, BMP, TIFF et WebP, les images de plus de 20 Mo et les PDF protégés par mot de passe ne le sont pas.
- Quand un document ou un fichier de référence contient des images (Word, PowerPoint, Excel, OpenDocument, HWPX ou EPUB), le détail du projet en indique le nombre à côté du fichier. Le texte de ces images ne fait pas partie du texte du document : il n’est ni traduit ni envoyé. Pour le lire, il faut l’OCR, mais l’OCR ne lit que les PDF numérisés et les fichiers image, pas les images contenues dans un autre fichier : exportez ou copiez les pages qui contiennent des images en image PNG ou JPEG ou en PDF numérisé, ajoutez-le comme document à traduire, puis lisez-le par OCR. Les très petites images (moins de 2 Ko, comme les puces) et les images des PDF ne sont pas comptées.

## Traduction de PDF

- Un PDF texte est traduit en un nouveau PDF dans le dossier de sortie. Vous pouvez aussi choisir un PDF bilingue, avec la traduction à côté de chaque page d’origine.
- L’écran de vérification indique le nombre d’appels à l’IA et l’IA utilisée avant tout envoi. La traduction des PDF texte utilise l’**IA à utiliser** de l’ensemble de l’application dans les Réglages, tandis que l’OCR utilise l’IA choisie dans le projet.
- En cas d’arrêt, **Écrire ce qui est fait** enregistre ce qui a été traduit. Rouvrez le document et appuyez sur **Continuer** pour n’envoyer que les blocs restants.

## Limites

- Les modifications faites dans le volet source ne peuvent pas être enregistrées. Dans certains éditeurs, vous pouvez saisir du texte en mémoire, mais le fichier dans `source/` n’est pas écrit.
- **Traduire de nouveau** retraduit tout depuis le début, mais conserve les blocs que vous avez modifiés vous-même dans la vue bilingue de l’éditeur PDF.
- L’arabe, l’hébreu et l’hindi ne peuvent pas être la langue cible d’un PDF traduit.
- Une fenêtre laissée ouverte longtemps expire ; rouvrez-la depuis le projet.

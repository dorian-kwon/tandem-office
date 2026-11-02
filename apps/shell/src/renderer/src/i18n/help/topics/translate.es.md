# Proyectos de traducción

Un proyecto de traducción reúne en una sola carpeta los documentos que quieres traducir, tu material de referencia y un glosario, y le da a la IA las mismas instrucciones cada vez. La IA te ayuda a traducir documentos de Word y de otros formatos, y puede traducir un PDF de texto a un PDF nuevo.

## Qué contiene un proyecto

- **Origen**: los documentos que se van a traducir. La aplicación guarda su propia copia en la carpeta `source/` del proyecto; el archivo que elegiste nunca se abre ni se modifica.
- **Referencias**: material de apoyo, como traducciones anteriores o guías de estilo.
- **Glosario**: los términos que siempre deben traducirse igual.
- **Salida**: las traducciones que escribes, en la carpeta `output/` del proyecto.

## Las tres pantallas

1. **Lista de proyectos**: abre **Traducción** en la barra lateral de Inicio. Aquí creas, abres y eliminas proyectos y escribes el prompt del sistema global, que se aplica a todos los proyectos de traducción.
2. **Detalle del proyecto**: los idiomas, el prompt del proyecto (instrucciones adicionales solo para este proyecto), las listas de documentos para traducir, referencias y glosario, y la elección para leer páginas escaneadas (OCR). **Abrir traducción** en un documento inicia el trabajo.
3. **Vista de traducción**: la copia de origen a la izquierda y tu traducción a la derecha, una junto a otra. El panel de origen es de solo lectura. **Ocultar original** y **Ocultar traducción** dan toda la ventana al otro panel, y el panel vuelve al punto donde lo dejaste.

## Glosario

- Añade un archivo `.csv`, `.xlsx` o `.txt` (en `.txt` las columnas se separan con tabuladores). Cada fila es un término.
- Las columnas son el término de origen, la traducción y, de forma opcional, una nota. Una primera fila con los nombres de las columnas se omite; es opcional.
- Los archivos se leen como UTF-8, y como CP949 cuando no son UTF-8 válido, de modo que los archivos coreanos de programas antiguos se ven bien.
- Hasta 200 entradas se envían completas. Con más de 200, solo se envían las entradas cuyo término de origen aparece en el texto que se traduce.

## Archivos de referencia

- Con una solicitud de traducción solo se envían los nombres de los archivos de referencia, no su contenido.
- Cuando lo necesita, la IA puede leer un archivo de referencia mediante las herramientas del proyecto.

## PDF escaneados e imágenes (OCR)

- Un PDF escaneado o una imagen todavía no tiene texto que traducir, así que la IA lo lee primero. En el detalle del proyecto, elige qué IA lo lee: **IA (Claude)**, **IA (ChatGPT)** o **Desactivado**. Si está desactivado, los escaneados y las imágenes no se pueden abrir para traducir.
- Eliges las páginas que se van a leer, una a una o con **Seleccionar todo**. Solo se leen las páginas elegidas.
- Las imágenes de las páginas se envían a la IA solo después de que confirmes en la pantalla de comprobación, que muestra cuántas páginas se envían y qué IA se usa. Puede consumir la cuota de tu plan, y una conexión de pago se marca como de pago antes de enviar nada.
- El texto leído se guarda como documento de Word en la carpeta de salida. Traduce ese documento en la vista de traducción con el panel de IA.
- Se admiten imágenes PNG y JPEG. No se admiten imágenes GIF, BMP, TIFF ni WebP, imágenes de más de 20 MB ni PDF con contraseña.

## Traducción de PDF

- Un PDF de texto se traduce a un PDF nuevo en la carpeta de salida. También puedes elegir un PDF bilingüe, con la traducción junto a cada página original.
- La pantalla de comprobación muestra el número de llamadas a la IA y qué IA se usa antes de enviar nada. La traducción de PDF de texto usa la **IA que se va a usar** de toda la aplicación, en Ajustes, mientras que el OCR usa la IA elegida en el proyecto.
- Si se detiene, **Generar lo ya hecho** guarda lo traducido, y **Continuar** enviará más tarde solo los bloques que faltan.

## Límites

- Los cambios en el panel de origen no se pueden guardar. En algunos editores puedes escribir en memoria, pero el archivo de `source/` no se modifica.
- **Traducir de nuevo** traduce todo desde el principio, pero conserva los bloques que editaste tú mismo en la vista bilingüe del editor de PDF.
- El árabe, el hebreo y el hindi no pueden ser el idioma de destino de un PDF traducido.
- Una ventana que se deja abierta mucho tiempo caduca; ábrela de nuevo desde el proyecto.

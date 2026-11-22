export async function searchablePageTexts(bytes: Buffer): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
  try {
    const doc = await task.promise
    const texts: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      const items: string[] = []
      for (const item of content.items) if ('str' in item) items.push(item.str)
      texts.push(items.join('').replace(/\s+/g, ''))
    }
    return texts
  } finally {
    await task.destroy()
  }
}

export async function searchableText(bytes: Buffer): Promise<string> {
  return (await searchablePageTexts(bytes)).join('')
}

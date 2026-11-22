import { escapeXmlText } from './xml-utils'

// These transient attributes exist only in the header/footer display parser input.
// Number the original text leaves before stripping field caches and alternate drawings.
export function indexHfTextNodes(xml: string): string {
  let index = 0,
    depth = 0
  return xml.replace(
    /<\/?w:fldSimple(?=[\s/>])[^>]*>|<w:fldChar(?=[\s/>])[^>]*>|<w:t(?=[\s/>])[^>]*>/g,
    (tag) => {
      if (tag.startsWith('</w:fldSimple')) depth = Math.max(0, depth - 1)
      else if (tag.startsWith('<w:fldSimple')) {
        if (!tag.endsWith('/>')) depth++
      } else if (tag.startsWith('<w:fldChar')) {
        const type = /\bw:fldCharType\s*=\s*["'](begin|end)["']/.exec(tag)?.[1]
        if (type === 'begin') depth++
        if (type === 'end') depth = Math.max(0, depth - 1)
      } else {
        const id = index++
        return tag.replace(/^<w:t/, `<w:t genofficeHfLeaf="${depth ? -1 : id}"`)
      }
      return tag
    },
  )
}

export function patchHfTextNodes(xml: string, values: Record<number, string>): string {
  let index = 0
  return xml.replace(
    /<w:t(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/w:t>)/g,
    (original, attrs: string) => {
      const id = index++
      if (!Object.hasOwn(values, id)) return original
      const a = attrs.replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
      return `<w:t${a} xml:space="preserve">${escapeXmlText(values[id]!)}</w:t>`
    },
  )
}

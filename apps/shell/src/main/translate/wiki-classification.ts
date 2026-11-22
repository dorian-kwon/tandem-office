import { LANGS, type Lang } from '@genoffice/i18n'
import { wikiCategoryLabel } from './wiki-classification-labels'

export { wikiCategoryLabel }

export interface WikiDocumentMetadata {
  title?: string
  documentType?: string
  industry?: string
  institution?: string
  style?: string
}

interface Rule {
  id: string
  /** A direct category name in the title or filename. */
  title: RegExp
  /** Two distinct kinds of evidence must agree to infer a category from prose. */
  evidence: readonly RegExp[]
}

const documentTypes = [
  {
    id: 'report',
    title: /보고서|결과보고|\breports?\b/i,
    evidence: [
      /조사\s*결과|평가\s*결과|\bfindings\b/i,
      /조사\s*방법|연구\s*방법|향후\s*과제|\bmethodology\b/i,
    ],
  },
  {
    id: 'guide',
    title: /안내서|가이드북|여행\s*가이드|\b(?:guidebooks?|guides?)\b/i,
    evidence: [
      /방문객\s*안내|이용\s*안내|\bvisitor information\b/i,
      /오시는\s*길|운영\s*시간|\b(?:getting here|opening hours)\b/i,
    ],
  },
  {
    id: 'contract',
    title: /계약서|협약서|\b(?:agreements?|contracts?)\b/i,
    evidence: [
      /계약\s*당사자|계약을\s*체결|\b(?:parties (?:hereby )?agree|this agreement is made)\b/i,
      /계약\s*기간|손해\s*배상|준거법|\b(?:governing law|term of (?:this|the) agreement)\b/i,
    ],
  },
  {
    id: 'proposal',
    title: /제안서|\bproposals?\b/i,
    evidence: [
      /사업\s*제안|제안\s*개요|\bproposed (?:activity|solution|approach)\b/i,
      /수행\s*계획|제안\s*예산|\b(?:proposed budget|implementation plan)\b/i,
    ],
  },
  {
    id: 'manual',
    title: /매뉴얼|설명서|\b(?:manuals?|handbooks?)\b/i,
    evidence: [
      /설치\s*방법|시스템\s*요구\s*사항|\bsystem requirements\b/i,
      /문제\s*해결|사용\s*방법|\btroubleshooting\b/i,
    ],
  },
  {
    id: 'press-release',
    title: /보도\s*자료|\bpress[ -]releases?\b/i,
    evidence: [
      /보도\s*시점|보도\s*일시|\bfor immediate release\b/i,
      /언론\s*문의|보도\s*문의|\b(?:media|press) contact\b/i,
    ],
  },
] as const satisfies readonly Rule[]

const industries = [
  {
    id: 'tourism',
    title: /관광|팸투어|여행|\b(?:tourism|travel|fam(?:iliarization)? tours?)\b/i,
    evidence: [
      /관광객|방문객|\b(?:tourists?|visitors?)\b/i,
      /관광지|여행\s*일정|숙박\s*시설|\b(?:itinerary|tourist attractions?|hotel accommodation)\b/i,
    ],
  },
  {
    id: 'healthcare',
    title: /보건|의료|신생아|\b(?:health\s?care|public health|maternal health|neonatal)\b/i,
    evidence: [
      /의료진|환자|\b(?:patients?|clinicians?)\b/i,
      /진료|병원|보건소|\b(?:clinical|hospital|health facilit(?:y|ies))\b/i,
    ],
  },
  {
    id: 'finance',
    title: /금융|재무제표|자산\s*운용|\b(?:banking|finance|financial|investment)\b/i,
    evidence: [
      /자산\s*운용|금융\s*상품|\b(?:asset management|financial instrument)\b/i,
      /투자\s*수익|투자자|\b(?:investors?|investment returns?)\b/i,
    ],
  },
  {
    id: 'technology',
    title:
      /소프트웨어|반도체|정보통신|정보\s*기술|\b(?:software|semiconductors?|information technology)\b/i,
    evidence: [
      /소프트웨어|애플리케이션|\bsoftware\b/i,
      /응용\s*프로그램\s*인터페이스|운영\s*체제|\b(?:API endpoint|operating system)\b/i,
    ],
  },
  {
    id: 'education',
    title: /교육과정|학교\s*교육|교육부|교과서|\b(?:education|curriculum)\b/i,
    evidence: [
      /학습자|학생|\b(?:students?|learners?)\b/i,
      /교과\s*과정|교과목|수업\s*목표|\b(?:curriculum|learning objectives?)\b/i,
    ],
  },
  {
    id: 'construction',
    title: /건설|건축|토목|\b(?:construction|civil engineering)\b/i,
    evidence: [
      /건축물|시공사|\b(?:construction site|general contractor)\b/i,
      /공정표|건축\s*허가|\b(?:building permit|construction schedule)\b/i,
    ],
  },
] as const satisfies readonly Rule[]

const styles = [
  {
    id: 'formal',
    title: /격식체|공문체|\bformal style\b/i,
    evidence: [
      /본\s*(?:계약|협약)|\bhereby\b/i,
      /하여야\s*한다|이행할\s*의무|\b(?:hereinafter|shall be binding)\b/i,
    ],
  },
  {
    id: 'instructional',
    title: /지시형\s*문체|\binstructional style\b/i,
    evidence: [
      /^\s*(?:단계\s*1|1\s*단계|step\s*1\b|1[.)]\s+(?:select|open|click|press)\b)(?=\s|[:.)]|$)/im,
      /(?:선택|입력|클릭|누르)(?:하세요|십시오)|\b(?:click|select|press) (?:the|a|an)\b/i,
    ],
  },
  {
    id: 'promotional',
    title: /홍보\s*문체|\bpromotional style\b/i,
    evidence: [
      /특별한\s*혜택|지금\s*바로|\b(?:exclusive offer|discover our|limited.time offer)\b/i,
      /놓치지\s*마세요|만나\s*보세요|예약하세요|\b(?:book now|don.t miss|sign up today)\b/i,
    ],
  },
] as const satisfies readonly Rule[]

export interface WikiClassification {
  documentType: string
  industry: string | null
  institution: string | null
  style: string | null
}

// The same category can arrive as an English ID, a localized Obsidian
// property or a label in the source. Give all of them the same graph identity.
const aliases = new Map<string, string>()
for (const [axis, rules] of Object.entries({
  documentType: documentTypes,
  industry: industries,
  style: styles,
})) {
  for (const id of rules.map((rule) => rule.id)) {
    aliases.set(axis + ':' + id, id)
    for (const lang of LANGS) {
      aliases.set(axis + ':' + wikiCategoryLabel(lang, id).toLowerCase(), id)
    }
  }
}

export function normalizeWikiCategory(
  axis: keyof WikiClassification,
  input: unknown,
): string | null {
  if (typeof input !== 'string' || input.length > 120) return null
  const name = input.normalize('NFC').trim().replace(/ +/g, ' ')
  const id = aliases.get(axis + ':' + name.toLowerCase())
  if (id) return id
  // Custom categories are literal names, never Markdown, URLs or file paths.
  if (!/\p{L}/u.test(name) || !/^[\p{L}\p{M}\p{N} ,.()&+'’·-]+$/u.test(name)) return null
  if (/^(?:unknown|unclassified|none|null|na|tbd|없음|미정|미상|미분류)$/i.test(name)) return null
  return name
}

export function displayWikiCategory(
  lang: Lang,
  axis: keyof WikiClassification,
  value: string,
): string {
  if ((value === 'unclassified' && axis === 'documentType') || aliases.has(axis + ':' + value))
    return wikiCategoryLabel(lang, value)
  return value
}

const fieldNames: Readonly<Record<string, keyof WikiDocumentMetadata>> = {
  제목: 'title',
  title: 'title',
  문서종류: 'documentType',
  문서유형: 'documentType',
  'document type': 'documentType',
  산업군: 'industry',
  업종: 'industry',
  industry: 'industry',
  sector: 'industry',
  기관명: 'institution',
  의뢰기관: 'institution',
  발주기관: 'institution',
  발행처: 'institution',
  발행기관: 'institution',
  주관기관: 'institution',
  기관: 'institution',
  의뢰처: 'institution',
  기관명칭: 'institution',
  고객사: 'institution',
  'issued by': 'institution',
  publisher: 'institution',
  institution: 'institution',
  'commissioned by': 'institution',
  client: 'institution',
  문체: 'style',
  'writing style': 'style',
  문체유형: 'style',
  style: 'style',
}

function distinct(values: readonly string[]): string | null {
  return values.length > 0 && values.every((v) => v === values[0]) ? values[0]! : null
}

function classify(
  axis: keyof WikiClassification,
  rules: readonly Rule[],
  explicit: readonly string[],
  titles: string,
  body: string,
): string | null {
  if (explicit.length) {
    const names = explicit.map((value) => normalizeWikiCategory(axis, value))
    return names[0] && names.every((value) => value === names[0]) ? names[0] : null
  }
  const headings = rules.filter((rule) => rule.title.test(titles))
  if (headings.length) return headings.length === 1 ? headings[0]!.id : null
  const matches = rules.filter((rule) => rule.evidence.every((marker) => marker.test(body)))
  return matches.length === 1 ? matches[0]!.id : null
}

/** Classify from a bounded sample; only explicitly attributed names become institutions. */
export function classifyWikiDocument(
  filename: string,
  body: string,
  metadata: WikiDocumentMetadata = {},
): WikiClassification {
  // Never manufacture a metadata field by cutting a label or a name in half.
  const partial = body.length > 10240
  const head = partial ? body.slice(0, 8192) : body
  const tail = partial ? body.slice(-2048) : ''
  const sample = (head + '\n' + tail).normalize('NFC')
  const lines = head.normalize('NFC').split(/\r\n?|\n/)
  if (partial) {
    lines.pop()
    lines.push(
      ...tail
        .normalize('NFC')
        .split(/\r\n?|\n/)
        .slice(1),
    )
  }
  const fields: Partial<Record<keyof WikiDocumentMetadata, string[]>> = {}
  for (const line of lines) {
    const match = /^\s*([\p{L} ]{2,32})\s*[:：]\s*(.{1,120}?)\s*$/u.exec(line)
    if (!match) continue
    const label = match[1]!.trim().toLowerCase()
    const normalized = /[가-힣]/.test(label) ? label.replace(/ +/g, '') : label
    const field = Object.hasOwn(fieldNames, normalized) ? fieldNames[normalized] : undefined
    if (field) (fields[field] ??= []).push(match[2]!.trim())
  }
  const values = (field: keyof WikiDocumentMetadata): string[] => {
    const trusted = metadata[field]?.normalize('NFC').trim()
    return trusted ? [trusted] : (fields[field] ?? [])
  }
  const filenameTitle = (filename.split(/[/\\]/).pop() ?? '')
    .slice(0, 260)
    .normalize('NFC')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]/g, ' ')
  const firstLine =
    lines
      .find((line) => line.trim())
      ?.trim()
      .replace(/^#{1,6}\s+/, '') ?? ''
  const heading =
    firstLine.length <= 100 &&
    !/[.:：!?。！？]/.test(firstLine) &&
    !/^(?:we|i|you|they|see|refer|please|this (?:is|was))\b/i.test(firstLine)
      ? firstLine
      : ''
  const titles = [filenameTitle, heading, ...values('title')].join('\n')
  const institution = distinct(values('institution'))
  return {
    documentType:
      classify('documentType', documentTypes, values('documentType'), titles, sample) ??
      'unclassified',
    industry: classify('industry', industries, values('industry'), titles, sample),
    institution: normalizeWikiCategory('institution', institution),
    style: classify('style', styles, values('style'), titles, sample),
  }
}

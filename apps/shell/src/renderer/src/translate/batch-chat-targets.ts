/** Resolve explicit references against this batch only. Ambiguous messages are kept
 * verbatim while the user identifies their intended documents in the dialog. */
export function batchChatTargets(
  prompt: string,
  files: readonly string[],
  current?: string,
  lastTargets?: readonly string[],
  labels?: { all: string; current: string },
): string[] | null {
  const text = prompt.normalize('NFC').toLowerCase()
  const mentioned = new Set<string>()
  const excluded = new Set<string>()
  const normal = (name: string) => name.normalize('NFC').toLowerCase()
  const beforeExclusion =
    /(?:except(?: for)?|excluding|apart from|instead of|other than|not(?: to)?)\s+["'“‘「]?$/u
  const afterExclusion =
    /^["'”’」]?(?:은|는|을|를|에는|에|만)?\s*(?:빼고|제외|말고|말구|아니라|아니고|아닌)/u
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = new Map<string, string[]>()
  for (const file of files) {
    const name = normal(file)
    const stem = name.replace(/\.[^.]+$/, '')
    // A one-character stem is too easily confused with a word or list marker.
    for (const key of new Set([name, ...(stem.length > 1 && stem !== name ? [stem] : [])]))
      names.set(key, [...(names.get(key) ?? []), file])
  }
  // Consume full names before overlapping stems, or "guide" would also select
  // guide.pdf when the user specified guide.docx.
  const aliases = [...names.keys()].sort((a, b) => b.length - a.length)
  let remaining = text
  for (const alias of aliases) {
    const pattern = new RegExp(
      '(?<![\\p{L}\\p{N}_])' +
        escape(alias) +
        '(?=$|[^\\p{L}\\p{N}_.]|(?:만|은|는|을|를|에|와|과|도|말고|제외|파일|문서)|\\.(?=\\s|$))',
      'gu',
    )
    const matches = Array.from(remaining.matchAll(pattern))
    if (!matches.length) continue
    const list = names.get(alias)!
    if (list.length !== 1) return null
    for (const match of matches) {
      const i = match.index!
      const negative =
        beforeExclusion.test(text.slice(Math.max(0, i - 35), i)) ||
        afterExclusion.test(text.slice(i + alias.length))
      const group = negative ? excluded : mentioned
      group.add(list[0]!)
    }
    remaining = remaining.replace(pattern, (name) => ' '.repeat(name.length))
  }
  // An unrecognized named file cannot safely be routed to a different file.
  if (
    /[\p{L}\p{N}_-]+\.(?:docx?|hwpx?|pdf|pptx?|xlsx?|xlsm|odt|odp|ods|epub|md|txt|rtf|csv|xmind|png|jpe?g|gif|tiff?|webp|bmp)\b/iu.test(
      remaining,
    )
  )
    return null

  // Ignore words the user quoted as replacement text.
  const scope = remaining.replace(/["“][^"”]*["”]|‘[^’]*’|「[^」]*」/gu, ' ')
  const negAll =
    /(?:전체|모두|전부|모든\s*(?:문서|파일))(?:\s*(?:문서|파일))?(?:에는|에|는|가|를|에서)?\s*(?:말고|말구|아니|빼고|제외)|(?:\bnot\s+(?:to\s+)?|\b(?:don['’]t|do not|never)\s+(?:apply|change|edit|translate)(?:\s+it)?\s+(?:to\s+)?)(?:all|every)\b/iu.test(
      scope,
    )
  // In a different UI language, accept the localized target labels. When
  // their sentence contains an exclusion, ask before applying to a group.
  const localizedAll = Boolean(labels && scope.includes(normal(labels.all)))
  const localizedCurrent = Boolean(labels && scope.includes(normal(labels.current)))
  const qualification =
    /(?:不|除外|一部|ではなく|除く|以外|ไม่|ยกเว้น|إلا|ليس|باستثناء|לא|למעט|חוץ|नहीं|छोड़कर)|(?<![\p{L}])(?:no|not|except|excepto|salvo|sans|sauf|pas|nicht|außer|ohne|não|exceto|non|tranne|nie|oprócz|ne|kromě|niet|behalve|tidak|kecuali|не|кроме|không|trừ)(?![\p{L}])/iu.test(
      scope,
    )
  const all =
    !negAll &&
    (/(?:모든|전체)\s*(?:번역\s*)?(?:대상|문서|파일)|(?:대상|문서들?|파일들?)(?:\s*(?:을|를|에))?\s*(?:전체|모두|전부)|(?:^\s*|[.!?]\s*)(?:전체|전부|모두)(?=\s|에|를|로|다|$)/u.test(
      scope,
    ) ||
      /\b(?:all (?:the |these |selected |of the |of these )?(?:documents?|files?|targets?)|every (?:document|file)|the whole batch|all of them)\b|^(?:apply (?:it )?to )?all[.!?]?$/iu.test(
        scope.trim(),
      ) ||
      (localizedAll && !qualification))
  const here =
    /(?:지금\s*)?(?:이|현재|지금|해당)\s*(?:작업\s*중인\s*|번역\s*중인\s*)?(?:문서|파일)|(?:번역|작업)\s*중인\s*(?:문서|파일)|\b(?:this|(?:the )?current|(?:the )?active) (?:document|file|one)\b/iu.test(
      scope,
    ) ||
    (localizedCurrent && !qualification)
  const currentOnlyNegated =
    /(?:이|현재|지금)\s*(?:문서|파일)(?:만\s*(?:이?\s*)?(?:아니라|말고)|(?:가|이)\s*아니라)|not (?:just|only) (?:this|the current) (?:document|file)/iu.test(
      scope,
    )
  const currentExcluded =
    !currentOnlyNegated &&
    /(?:이|현재|지금)\s*(?:문서|파일)(?:만|는|은|를|을|에)?\s*(?:빼고|제외|말고)|(?:except(?: for)?|excluding|other than) (?:this|(?:the )?current) (?:document|file|one)/iu.test(
      scope,
    )
  if (currentExcluded && current) excluded.add(current)
  if ([...mentioned].some((file) => excluded.has(file))) return null
  if (excluded.size && !mentioned.size && !all) return null
  if (all && here && !currentExcluded && !currentOnlyNegated) {
    // "이 문서 전체" / "all of this document" names one document.
    if (
      /(?:이|현재|지금|해당)\s*(?:문서|파일)(?:만|를|을|의)?\s*전체/u.test(scope) &&
      !/(?:모든|전체)\s*(?:문서|파일)/u.test(scope)
    )
      return current ? [current] : null
    return null
  }
  if (all && mentioned.size) return null
  if (all) {
    if (currentExcluded && !current) return null
    const chosen = files.filter((file) => !excluded.has(file))
    return chosen.length ? chosen : null
  }
  if (here && !currentExcluded && current) mentioned.add(current)
  if (mentioned.size) return files.filter((file) => mentioned.has(file))
  if (here || negAll || currentExcluded || excluded.size) return null
  if ((localizedAll || localizedCurrent) && qualification) return null
  if (
    lastTargets?.length &&
    /^(?:네[, ]*|응[, ]*)?(?:그렇게|그대로|아까처럼|계속해|이어서)|^(?:yes[, ]+)?(?:do that|continue|go ahead|same as before)\b/iu.test(
      scope.trim(),
    )
  ) {
    const previous = files.filter((file) => lastTargets.includes(file))
    return previous.length === lastTargets.length ? previous : null
  }
  return files.length === 1 ? [files[0]!] : null
}

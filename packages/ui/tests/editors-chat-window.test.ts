import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { CHAT_WINDOW_STRINGS } from '../src/strings-chat-window'

it.each(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'hwp', 'mindmap', 'epub'])(
  '%s renders the common chat window with original message indices',
  (editor) => {
    const file = editor === 'sheets' ? 'AiChatPanel.tsx' : 'AiPanel.tsx'
    const source = readFileSync(
      new URL(`../../../apps/${editor}/src/renderer/ai/${file}`, import.meta.url),
      'utf8',
    )
    expect(source).toContain('useChatWindow(chat,')
    expect(source).toContain('<EarlierChatMessages')
    expect(source).toContain('{chatWindow.chat.map(')
    if (['docs', 'sheets', 'slides'].includes(editor)) {
      expect(source).toContain('historicChat)')
      expect(source).toContain('{chatWindow.history.map(')
    }
  },
)
it('has a localized count label for every language', () => {
  for (const lang of LANGS) {
    expect(CHAT_WINDOW_STRINGS[lang]).toContain('{count}')
    if (lang !== 'en') expect(CHAT_WINDOW_STRINGS[lang]).not.toBe(CHAT_WINDOW_STRINGS.en)
  }
})

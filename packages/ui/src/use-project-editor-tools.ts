import { nativeDocumentTools, type DocumentToolEditor } from './project-document-tools'
import { createChoiceSkill } from './ai-choice'
import { useEffect, useRef } from 'react'
import type { AgentLoop } from '@genoffice/agent-core'
import {
  MAX_BOX_REVIEW_SAMPLES,
  type ProjectEditorToolBridge,
  type EditorBoxReview,
} from '@genoffice/project-store/editor-run'

type DocumentTools = NonNullable<ReturnType<AgentLoop['openDocumentTools']>>
export function useProjectEditorTools(options: {
  path?: string | null | undefined
  ready: boolean
  busy: boolean
  boxLayout?: {
    prepare(): boolean | Promise<boolean>
    review(): EditorBoxReview['samples'] | Promise<EditorBoxReview['samples']>
  }
  documentEditor?: DocumentToolEditor
  documentLoop?: () => Pick<AgentLoop, 'openDocumentTools'> | null
}) {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const api = (globalThis as { projectFolderApi?: ProjectEditorToolBridge }).projectFolderApi
    if (!api?.onEditorToolRequest) return
    let session:
      | {
          id: string
          path: string
          tools: DocumentTools
          running?: { id: string; controller: AbortController }
          closing?: boolean
        }
      | undefined
    const close = () => {
      if (!session) return
      session.closing = true
      session.running?.controller.abort()
      if (!session.running) {
        session.tools.close()
        session = undefined
      }
    }
    const off = api.onEditorToolRequest(async (message) => {
      const { id } = message
      const base = { id, session: message.session }
      const error = (reason: string) =>
        api.replyToEditorToolRequest({ ...base, kind: 'error', error: reason })
      if (message.kind === 'close' || message.kind === 'cancel') {
        if (session?.id === message.session && session.path === message.path) {
          if (message.kind === 'close') close()
          else if (session.running?.id === id) session.running.controller.abort()
        }
        return
      }
      const current = latest.current
      if (!current.ready || !current.path || current.path !== message.path) {
        if (message.kind !== 'describe') error('The requested document is no longer open.')
        return
      }
      if (message.kind === 'describe') {
        if ((session && session.id !== message.session) || current.busy)
          return error('The document editor is already busy.')
        if (!session) {
          const editor = current.documentEditor
          const tools =
            editor &&
            current
              .documentLoop?.()
              ?.openDocumentTools((skill, host) => nativeDocumentTools(editor, skill, host))
          if (!tools) return error('The document tools are not available.')
          const choice = createChoiceSkill({
            batchChoices: () => message.choices ?? {},
            ask: () => {
              throw new Error('This choice requires the project operator.')
            },
          })
          session = {
            id: message.session,
            path: message.path,
            tools: {
              ...tools,
              tools: [...tools.tools, ...choice.tools],
              executeTool: async (call, signal) =>
                call.name === 'ask_choice'
                  ? choice.executeTool(call, signal)
                  : tools.executeTool(call, signal),
            },
          }
        }
        api.replyToEditorToolRequest({
          ...base,
          kind: 'described',
          tools: session.tools.tools,
          systemPrompt: session.tools.systemPrompt,
        })
        return
      }
      if (
        message.kind !== 'execute' &&
        message.kind !== 'prepare-layout' &&
        message.kind !== 'review-layout'
      )
        return
      const active = session
      if (
        !active ||
        active.id !== message.session ||
        active.path !== message.path ||
        active.closing ||
        active.running
      )
        return error('The document tool session is unavailable.')
      const controller = new AbortController()
      active.running = { id, controller }
      try {
        if (message.kind === 'prepare-layout' || message.kind === 'review-layout') {
          if (!current.boxLayout) return error('Word layout diagnostics are unavailable.')
          if (message.kind === 'prepare-layout') {
            const needsSave = await current.boxLayout.prepare()
            controller.signal.throwIfAborted()
            api.replyToEditorToolRequest({ ...base, kind: 'layout-prepared', needsSave })
          } else {
            const boxes = await current.boxLayout.review()
            controller.signal.throwIfAborted()
            const samples = boxes
              .slice(0, MAX_BOX_REVIEW_SAMPLES)
              .map(({ location, text, target }) => ({
                ...(target ? { target } : {}),
                location: location.slice(0, 240),
                text: text.slice(0, 200),
              }))
            api.replyToEditorToolRequest({
              ...base,
              kind: 'layout-reviewed',
              review: { count: boxes.length, samples },
            })
          }
          return
        }
        const execution = await active.tools.executeTool(message.call, controller.signal)
        api.replyToEditorToolRequest({ ...base, kind: 'result', execution })
      } catch (cause) {
        error(String(cause))
      } finally {
        delete active.running
        if (active.closing) close()
      }
    })
    return () => {
      off()
      close()
    }
  }, [options.path])
}

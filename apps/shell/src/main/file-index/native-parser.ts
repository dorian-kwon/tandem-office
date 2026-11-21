import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, setPriority } from 'node:os'
import type { MessagePort } from 'node:worker_threads'
import {
  PARSE_SIDECAR_PROTOCOL_VERSION,
  ParseSidecarClient,
  SidecarInfraError,
} from '@genoffice/file-parse/sidecar-client'

type Reply = { bytes: Uint8Array } | { error: string }

/**
 * Main owns and reaps the native child even if V8 terminates its index worker.
 * Relay small stdout chunks without decoding or parsing document text on main.
 * A writer sends one request at a time and gets one newline-terminated reply.
 */
export function hostIndexParser(port: MessagePort, binary: string | null) {
  let child: ChildProcessWithoutNullStreams | null = null
  let idle: NodeJS.Timeout | undefined
  let pending = false

  function stopChild(): void {
    clearTimeout(idle)
    const old = child
    child = null
    if (old) old.kill()
  }

  port.on('message', (line: string) => {
    clearTimeout(idle)
    if (!binary) {
      port.postMessage({ error: 'Native parse helper is unavailable.' } satisfies Reply)
      return
    }
    try {
      if (!child) {
        const started = spawn(binary, ['--indexer'], { windowsHide: true, stdio: 'pipe' })
        child = started
        if (started.pid) {
          try {
            setPriority(started.pid, constants.priority.PRIORITY_BELOW_NORMAL)
          } catch {}
        }
        started.stderr.resume()
        const lost = (): void => {
          if (child !== started) return
          stopChild()
          if (pending) port.postMessage({ error: 'Native parse helper exited.' } satisfies Reply)
          pending = false
        }
        started.on('error', lost)
        started.stdin.on('error', lost)
        started.once('exit', lost)
        started.stdout.on('data', (buffer: Buffer) => {
          if (child !== started) return
          const bytes = new Uint8Array(buffer)
          port.postMessage({ bytes } satisfies Reply, [bytes.buffer])
          if (buffer.at(-1) === 10) {
            pending = false
            idle = setTimeout(stopChild, 120_000)
            idle.unref()
          }
        })
      }
      pending = true
      child.stdin.write(line)
    } catch {
      stopChild()
      pending = false
      port.postMessage({ error: 'Native parse helper could not start.' } satisfies Reply)
    }
  })
  port.on('close', stopChild)
  return {
    pid: () => child?.pid,
    stop: () => {
      stopChild()
      port.close()
    },
  }
}

/** Decode the streamed reply and validate the parser protocol in the writer. */
export class IndexParserClient extends ParseSidecarClient {
  constructor(private readonly port: MessagePort) {
    super()
  }

  protected override request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const requestId = randomUUID()
    const version = PARSE_SIDECAR_PROTOCOL_VERSION
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const cleanup = (): void => {
        this.port.off('message', receive)
        this.port.off('close', closed)
      }
      const closed = (): void => {
        cleanup()
        reject(new SidecarInfraError('Index parse connection closed.', 'stopped'))
      }
      const receive = (reply: Reply): void => {
        if ('error' in reply) {
          cleanup()
          reject(new SidecarInfraError(reply.error, 'process_exited'))
          return
        }
        chunks.push(Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength))
        if (reply.bytes.at(-1) !== 10) return
        cleanup()
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (
            response.version !== version ||
            response.requestId !== requestId ||
            typeof response.ok !== 'boolean'
          )
            throw new Error('Invalid native parse response.')
          if (!response.ok)
            throw new Error(response.error?.message ?? 'Native parse request failed.')
          resolve(response.result)
        } catch (error) {
          reject(
            new SidecarInfraError(
              error instanceof Error ? error.message : 'Invalid native parse response.',
              'malformed_response',
            ),
          )
        }
      }
      this.port.on('message', receive)
      this.port.once('close', closed)
      this.port.postMessage(JSON.stringify({ version, requestId, ...command }) + '\n')
    })
  }
}

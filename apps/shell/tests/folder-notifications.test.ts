import { describe, expect, it } from 'vitest'
import { notifyFolderChanged } from '../src/main/folder-notifications'
import { HOME_CHANNELS } from '../src/shared/home-api'

describe('folder change notifications', () => {
  it.each([
    'Render frame was disposed before WebFrameMain could be accessed',
    'Object has been destroyed',
  ])('still updates live views when a closing view throws: %s', (message) => {
    const received: unknown[] = []
    const closing = {
      isDestroyed: () => false,
      send: () => {
        throw new Error(message)
      },
    }
    const live = {
      isDestroyed: () => false,
      send: (channel: string, dirs: string[]) => received.push({ channel, dirs }),
    }
    expect(() => notifyFolderChanged([closing, live], ['/project'])).not.toThrow()
    expect(received).toEqual([{ channel: HOME_CHANNELS.folderChanged, dirs: ['/project'] }])
  })

  it('skips destroyed contents', () => {
    notifyFolderChanged(
      [
        {
          isDestroyed: () => true,
          send: () => {
            throw new Error('sent to dead contents')
          },
        },
      ],
      [],
    )
  })

  it('does not hide unexpected send failures', () => {
    const failure = new Error('Unexpected IPC serialization failure')
    expect(() =>
      notifyFolderChanged(
        [
          {
            isDestroyed: () => false,
            send: () => {
              throw failure
            },
          },
        ],
        ['/project'],
      ),
    ).toThrow(failure)
  })
})

import type { OutgoingHttpHeaders, RequestOptions } from 'node:http'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { parseUpdateInfo, Provider } from 'electron-updater/out/providers/Provider'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import {
  validatePinnedVersion,
  versionAssetUrl,
  type VersionCandidate,
} from './update-version-catalog'

export function pinnedVersionProvider(candidate: VersionCandidate, token: string | null) {
  return class PinnedVersionProvider extends Provider<UpdateInfo> {
    constructor(_options: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
      super({ ...runtime, isUseMultipleRangeRequest: false })
    }

    get fileExtraDownloadHeaders(): OutgoingHttpHeaders | null {
      return token ? { authorization: `token ${token}`, accept: 'application/octet-stream' } : null
    }

    protected createRequestOptions(url: URL, headers?: OutgoingHttpHeaders | null): RequestOptions {
      // The executor strips authorization from cross-origin redirects to the asset CDN.
      return { ...super.createRequestOptions(url, headers), redirect: 'manual' } as RequestOptions
    }

    async getLatestVersion(): Promise<UpdateInfo> {
      const { version, feed } = candidate
      if (!feed) throw new Error('No selected version feed')
      const url = versionAssetUrl(version, feed, token)
      const raw = await this.httpRequest(url, this.fileExtraDownloadHeaders)
      const info = parseUpdateInfo(raw, feed.name, url)
      validatePinnedVersion(candidate, info)
      return info
    }

    resolveFiles(info: UpdateInfo) {
      return [
        {
          url: versionAssetUrl(candidate.version, candidate.installer, token),
          info: validatePinnedVersion(candidate, info),
        },
      ]
    }
  }
}

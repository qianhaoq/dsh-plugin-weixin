/** Adapted from @tencent-weixin/openclaw-weixin 2.4.10; see SOURCES.md and LICENSE. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

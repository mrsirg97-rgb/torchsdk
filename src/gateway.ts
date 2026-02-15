/**
 * Gateway URL utilities for Irys content
 * Use uploader.irys.xyz as fallback when gateway.irys.xyz has issues
 */

const IRYS_GATEWAY = 'gateway.irys.xyz'
const IRYS_UPLOADER = 'uploader.irys.xyz'

/**
 * Convert an Irys gateway URL to uploader URL (fallback)
 */
export const irysToUploader = (url: string): string => url.replace(IRYS_GATEWAY, IRYS_UPLOADER)

/**
 * Check if URL is from Irys gateway
 */
export const isIrysUrl = (url: string): boolean => {
  try {
    return new URL(url).hostname === IRYS_GATEWAY
  } catch {
    return false
  }
}

/**
 * Fetch with automatic fallback from gateway.irys.xyz to uploader.irys.xyz
 */
export const fetchWithFallback = async (
  url: string,
  options?: RequestInit,
  timeoutMs: number = 10000,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const opts: RequestInit = { ...options, signal: controller.signal }

  try {
    // If it's an Irys gateway URL, use uploader directly (gateway has SSL issues)
    if (isIrysUrl(url)) {
      const uploaderUrl = irysToUploader(url)
      return await fetch(uploaderUrl, opts)
    }

    // For non-Irys URLs, fetch normally
    return await fetch(url, opts)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Normalize preferred publisher URLs to public hostnames.
 *
 * These values are later used only as `site:` search filters. No arbitrary
 * user-supplied URL is used as an HTTP request destination.
 */
export function normaliseResearchSources(values: string[]): string[] | null {
  const sources: string[] = [];
  for (const value of values) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(':')) return null;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) return null;
    if (!sources.includes(hostname)) sources.push(hostname);
  }
  return sources;
}

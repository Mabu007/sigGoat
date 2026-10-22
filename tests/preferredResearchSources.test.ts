import { describe, test, expect } from 'bun:test';
import { NewsService } from '../src/services/news/NewsService';
import { normaliseResearchSources } from '../src/services/news/researchSources';

function rss(title = 'Gold supply outlook') {
  return `<rss><channel><item><title>${title}</title><source>Reuters</source><pubDate>${new Date().toUTCString()}</pubDate><link>https://reuters.com/markets/gold</link></item></channel></rss>`;
}

describe('preferred research sources', () => {
  test('stores only normalized public HTTPS hostnames', () => {
    expect(normaliseResearchSources(['https://www.Reuters.com/markets', 'https://reuters.com/news/'])).toEqual(['reuters.com']);
    expect(normaliseResearchSources(['http://reuters.com'])).toBeNull();
    expect(normaliseResearchSources(['https://127.0.0.1/private'])).toBeNull();
    expect(normaliseResearchSources(['https://localhost/private'])).toBeNull();
    expect(normaliseResearchSources(['https://user:pass@reuters.com'])).toBeNull();
  });

  test('prioritises selected publisher domains in the cached search query', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return new Response(rss(), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }) as typeof fetch;
    try {
      const service = new NewsService(60_000);
      const first = await service.getNews('xyz:GOLD', false, ['reuters.com', 'coindesk.com']);
      const second = await service.getNews('XYZ:GOLD', false, ['reuters.com', 'coindesk.com']);
      expect(first.ok).toBe(true);
      expect(first.headlines[0]?.source).toBe('Reuters');
      expect(new URL(urls[0]).searchParams.get('q')).toContain('site:reuters.com');
      expect(new URL(urls[0]).searchParams.get('q')).toContain('site:coindesk.com');
      expect(urls.length).toBe(1);
      expect(second.headlines[0]?.link).toBe('https://reuters.com/markets/gold');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the configured domains are search filters, not outbound fetch destinations', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return new Response(rss(), { status: 200 });
    }) as typeof fetch;
    try {
      await new NewsService(60_000).getNews('BTC', false, ['https://localhost/private']);
      expect(urls).toHaveLength(1);
      expect(new URL(urls[0]).hostname).toBe('news.google.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { ShelfError } from './domain.mjs';

const origin = 'https://skills.sh';
const slug = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const sections = { all: '/', hot: '/hot', trending: '/trending', official: '/official', topics: '/topic' };
const fail = (message, status = 400) => { throw new ShelfError(status, message); };
const decode = text => text.replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => { const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ''; }).replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const clean = value => decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const heading = (html, level) => clean(html.match(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'i'))?.[1] ?? '');
const paragraphs = html => [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => clean(match[1]));
const attribute = (html, name) => decode(html.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] ?? '');
const count = value => {
  const match = value.replaceAll(',', '').match(/^(\d+(?:\.\d+)?)\s*([KMB])?$/i);
  return match ? Math.round(Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1)) : undefined;
};

function safePath(value, lengths) {
  if (typeof value !== 'string' || value.length > 600) fail('Invalid marketplace path.');
  let url;
  try { url = new URL(value, origin); } catch { fail('Invalid marketplace URL.'); }
  if (!['https://skills.sh', 'https://www.skills.sh'].includes(url.origin) || url.username || url.password || url.search || url.hash) fail('Only skills.sh marketplace URLs are supported.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (!lengths.includes(parts.length) || parts.some(part => !slug.test(part))) fail('Invalid marketplace path.');
  return { parts, path: `/${parts.join('/')}`, url: `${origin}/${parts.join('/')}` };
}

export function parseDiscoveryHtml(html, sourceUrl, section) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const entries = new Map();
  for (const match of main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attribute(match[1], 'href'), body = match[2];
    let target;
    try { target = safePath(href, [1, 2, 3]); } catch { continue; }
    const parts = target.parts;
    const h3 = heading(body, 3);
    if (parts.length === 3 && h3 && parts[0] !== 'topic') {
      const labels = [...body.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(item => clean(item[1]));
      const installLabel = labels.filter(label => count(label) !== undefined).at(-1);
      const texts = paragraphs(body);
      entries.set(target.path, { kind: 'skill', name: h3, repo: parts.slice(0, 2).join('/'), skill: parts[2], description: texts.length > 1 ? texts.at(-1) : '', url: target.url, installLabel, installCount: count(installLabel ?? '') });
    } else if (section === 'topics' && parts.length === 2 && parts[0] === 'topic' && heading(body, 2)) {
      const texts = paragraphs(body);
      entries.set(target.path, { kind: 'topic', name: heading(body, 2), description: texts[0] ?? '', url: target.url, path: target.path, countLabel: texts.at(-1) });
    } else if (section === 'official' && parts.length === 1 && !Object.values(sections).includes(target.path)) {
      const spans = [...body.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(item => clean(item[1]));
      if (spans[0]?.toLowerCase() === parts[0].toLowerCase()) entries.set(target.path, { kind: 'creator', name: spans[0], description: spans[1] ?? '', url: target.url, path: target.path });
    } else if (section === 'creator' && parts.length === 2 && h3) {
      entries.set(target.path, { kind: 'repository', name: h3, description: paragraphs(body)[0] ?? '', url: target.url, path: target.path });
    }
  }
  return { title: heading(main, 1), description: paragraphs(main)[0] ?? '', entries: [...entries.values()].slice(0, 600), sourceUrl };
}

export class DiscoveryService {
  constructor({ fetcher = fetch } = {}) { this.fetcher = fetcher; this.cache = new Map(); this.controller = new AbortController(); }
  close() { this.controller.abort(); }
  async fetchText(path, json = false) {
    let url = new URL(path, origin), response;
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await this.fetcher(url, { redirect: 'manual', headers: { Accept: json ? 'application/json' : 'text/html', 'User-Agent': 'Skill-Shelf-Magpie' }, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(25_000)]) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail('The marketplace returned an invalid redirect.', 502);
      url = new URL(location, url);
      if (!['https://skills.sh', 'https://www.skills.sh'].includes(url.origin) || url.username || url.password) fail('The marketplace redirected outside skills.sh.', 502);
    }
    if (!response.ok) fail(`skills.sh returned ${response.status}. Try again later.`, 502);
    if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) fail('The marketplace response is too large.', 502);
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 10 * 1024 * 1024) fail('The marketplace response is too large.', 502); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel(); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!json) return text;
    try { return JSON.parse(text); } catch { fail('The marketplace returned invalid search data.', 502); }
  }
  async cached(key, refresh, load) {
    const previous = this.cache.get(key);
    if (!refresh && previous && Date.now() - previous.time < 5 * 60_000) return previous.value;
    try {
      const value = { ...await load(), fetchedAt: new Date().toISOString(), stale: false };
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { value, time: Date.now() }); return value;
    } catch (error) { if (previous) return { ...previous.value, stale: true, warning: `Showing cached results. ${error.message}` }; throw error; }
  }
  async catalog({ section = 'all', query = '', path, refresh = false } = {}) {
    if (!Object.hasOwn(sections, section) && !['creator', 'repository', 'topic'].includes(section)) fail('Invalid marketplace section.');
    if (typeof query !== 'string' || query.length > 200) fail('Search is limited to 200 characters.');
    query = query.trim();
    if (query) return this.cached(`search:${query}`, refresh, async () => {
      const result = await this.fetchText(`/api/search?${new URLSearchParams({ q: query, limit: '100' })}`, true);
      if (!Array.isArray(result.skills)) fail('The marketplace search response changed. Open skills.sh to continue.', 502);
      const entries = [];
      for (const item of result.skills.slice(0, 100)) {
        const source = typeof item.source === 'string' ? item.source : '', parts = source.split('/');
        const skill = item.skillId ?? (typeof item.id === 'string' ? item.id.split('/').at(-1) : '');
        if (parts.length !== 2 || !parts.every(part => slug.test(part)) || typeof skill !== 'string' || !slug.test(skill)) continue;
        entries.push({ kind: 'skill', repo: source, skill, name: typeof item.name === 'string' ? item.name.slice(0, 200) : skill, description: '', installCount: Number.isSafeInteger(item.installs) ? item.installs : undefined, url: `${origin}/${source}/${skill}` });
      }
      return { section, title: 'Search', entries, sourceUrl: `${origin}/?q=${encodeURIComponent(query)}` };
    });
    let remotePath = sections[section];
    if (!remotePath) {
      const validated = safePath(path, section === 'creator' ? [1] : section === 'repository' ? [2] : [2]);
      if (section === 'topic' && validated.parts[0] !== 'topic') fail('Invalid topic.');
      if (section === 'repository' && validated.parts[0] === 'topic') fail('Invalid repository.');
      remotePath = validated.path;
    }
    return this.cached(remotePath, refresh, async () => {
      const html = await this.fetchText(remotePath);
      const parsed = parseDiscoveryHtml(html, `${origin}${remotePath}`, section);
      if (!parsed.entries.length) fail('The marketplace did not return readable entries. Retry or open skills.sh.', 502);
      return { ...parsed, section };
    });
  }
  async detail({ url, refresh = false }) {
    const page = safePath(url, [3]);
    if (page.parts[0] === 'topic') fail('Choose a Skill detail page.');
    return this.cached(`detail:${page.path}`, refresh, async () => {
      const html = await this.fetchText(page.path);
      const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
      const content = main.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? main.match(/<div\b[^>]*class="[^"]*prose[^\"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
      const description = [...html.matchAll(/<meta\b[^>]*>/gi)].find(match => attribute(match[0], 'name') === 'description');
      const document = content ? decode(content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<\/(?:p|div|li|h[1-6]|pre|blockquote)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim().slice(0, 80_000) : '';
      return { name: heading(main, 1) || page.parts[2], repo: page.parts.slice(0, 2).join('/'), skill: page.parts[2], url: page.url, description: description ? attribute(description[0], 'content') : '', document, sourceUrl: `https://github.com/${page.parts[0]}/${page.parts[1]}` };
    });
  }
}

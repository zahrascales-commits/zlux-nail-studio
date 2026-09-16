// Counts AI assistants and search engines reading the site.
//
// They never run JavaScript, so the page-view counter on every page cannot
// see them. This runs at the front door instead, looks at who is asking, and
// for a bot only, reports the visit. Everyone else passes straight through
// untouched: nothing is returned, so the page is served exactly as before.
//
// Nothing in here is allowed to fail a request. Every step is guarded, and
// the report is sent in the background where the platform supports it.
const BOTS = /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|GoogleOther|Google-CloudVertexBot|meta-externalagent|meta-externalfetcher|FacebookBot|Applebot|Amazonbot|Copilot|Bytespider|TikTokSpider|DuckAssistBot|MistralAI-User|YouBot|cohere-ai|CCBot|AI2Bot|Diffbot|Timpibot|ImagesiftBot|PetalBot|Googlebot|AdsBot-Google|bingbot|BingPreview|DuckDuckBot|Slurp|YandexBot|Baiduspider/i;

export const config = {
  // Pages only — not scripts, images or the API.
  matcher: ['/((?!api/|js/|css/|img/|images/|fonts/|photos/|data/|\\.well-known/).*)'],
};

export default async function middleware(request, context) {
  try {
    const ua = request.headers.get('user-agent') || '';
    if (!BOTS.test(ua)) return;
    const url = new URL(request.url);
    const report = fetch(new URL('/api/ai-visibility?action=crawl', url.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-crawl-key': (typeof process !== 'undefined' && process.env && process.env.CRAWL_KEY) || 'ZOLA-CRAWL-2026',
      },
      body: JSON.stringify({ ua: ua.slice(0, 300), path: url.pathname }),
    }).catch(() => {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(report);
    else await Promise.race([report, new Promise(r => setTimeout(r, 1500))]);
  } catch (_) {
    // Counting a bot is never worth an error page.
  }
}

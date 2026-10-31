// Service Worker der Einkaufsliste
// - HTML: zuerst aus dem Netz (max. 3 s), sonst aus dem Cache → nie veraltete Seiten
// - CSS/JS/Bilder: versioniert (?v=…) aus dem Cache
// - Firestore, Google-Fonts usw. werden nie abgefangen
// - Kein automatisches skipWaiting: die Seite zeigt „Neue Version – Neu laden“
const VERSION = '2.0.3';
const CACHE_NAME = 'einkaufsliste-v8-' + VERSION;
const CORE = [
    './',
    'index.html',
    'shopping-list.html',
    'auth.html',
    `style.css?v=${VERSION}`,
    `script.js?v=${VERSION}`,
    `voice.js?v=${VERSION}`,
    `voice-parser.js?v=${VERSION}`,
    `auth.js?v=${VERSION}`,
    'manifest.json',
    'apple-touch-icon.png',
    'icon-192.png',
    'favicon-32.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(CORE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})))
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(request) {
    return new Promise((resolve) => {
        let settled = false;
        const fromCache = () => caches.match(request, { ignoreSearch: true })
            .then(r => r || caches.match('index.html'));
        const timer = setTimeout(() => {
            fromCache().then(r => { if (r && !settled) { settled = true; resolve(r); } });
        }, 3000);
        fetch(request).then((response) => {
            clearTimeout(timer);
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(c => c.put(request, copy));
            }
            if (!settled) { settled = true; resolve(response); }
        }).catch(() => {
            clearTimeout(timer);
            fromCache().then(r => { if (!settled) { settled = true; resolve(r || Response.error()); } });
        });
    });
}

function cacheFirst(request) {
    return caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, copy));
        }
        return response;
    }));
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // Firestore, CDN, Fonts: nicht anfassen

    const isPage = request.mode === 'navigate' || request.destination === 'document' || url.pathname.endsWith('.html');
    event.respondWith(isPage ? networkFirst(request) : cacheFirst(request));
});

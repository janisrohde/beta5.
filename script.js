import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    where,
    serverTimestamp,
    enableNetwork,
    writeBatch,
    increment
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { initVoice } from "./voice.js?v=2.0.4";
import { photoKey } from "./photo-key.js?v=2.0.4";

export const APP_VERSION = '2.0.4';

// Alte, zwischengespeicherte HTML-Seite (vor Version 2) erkennen: Service Worker
// und Caches einmalig leeren und frisch laden, damit HTML und Skript zusammenpassen.
if (!document.querySelector('meta[name="app-version"]') && !sessionStorage.getItem('versionReload')) {
    sessionStorage.setItem('versionReload', '1');
    document.body.style.visibility = 'hidden';
    try {
        const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
        await Promise.all(regs.map(r => r.unregister()));
        const keys = await caches?.keys?.() || [];
        await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) {}
    location.reload();
    await new Promise(() => {});
}

const firebaseConfig = {
    apiKey: "AIzaSyDN17KahTrjPxIM2BfBSSJxou5y6U6PZHY",
    authDomain: "einkaufsliste-familie-69283.firebaseapp.com",
    projectId: "einkaufsliste-familie-69283",
    storageBucket: "einkaufsliste-familie-69283.firebasestorage.app",
    messagingSenderId: "748125742090",
    appId: "1:748125742090:web:2a03355797d48ae741ebf3"
};

const app = initializeApp(firebaseConfig);

// Offline-Cache: Listen und Produkte sind auch ohne Netz sofort da
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
} catch (e) {
    db = initializeFirestore(app, {});
}
try { navigator.storage?.persist?.(); } catch (e) {}

let currentFamilyId = null;
let currentUser = null;
let currentUsername = '';

// Einmalig: Speicher des entfernten KI-Chats aufräumen
try {
    Object.keys(localStorage)
        .filter(k => k === 'ki_chat_v1' || k === 'ki_sessions_v1' || k.startsWith('ki_sess_'))
        .forEach(k => localStorage.removeItem(k));
} catch (e) {}

// ===== DEBUG-PROTOKOLL (für das versteckte Debug-Panel) =====
const Debug = {
    errors: (() => { try { return JSON.parse(localStorage.getItem('debug_errors') || '[]'); } catch (e) { return []; } })(),
    listeners: {},
    log(label, err) {
        const entry = { at: new Date().toISOString(), label, msg: String(err?.code || err?.message || err) };
        this.errors.unshift(entry);
        this.errors = this.errors.slice(0, 25);
        try { localStorage.setItem('debug_errors', JSON.stringify(this.errors)); } catch (e) {}
        console.warn('[Einkaufsliste]', label, err);
    }
};
window.addEventListener('error', e => Debug.log('Fehler', e.message));
window.addEventListener('unhandledrejection', e => Debug.log('Promise', e.reason));

// Schreibvorgänge nie in der Oberfläche abwarten: offline bestätigt Firestore erst
// beim nächsten Kontakt mit dem Server. Fehler landen im Debug-Protokoll.
function commitQuietly(batch, label) {
    batch.commit().catch(e => Debug.log(label, e));
}

// ===== SELBSTHEILENDE LISTENER =====
// Ein onSnapshot-Listener meldet sich nach einem Fehler nie wieder. Deshalb wird er
// mit wachsender Wartezeit neu gestartet und beim Zurückkehren in die App geprüft.
const liveListeners = new Set();
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];

function liveListen(label, ref, onData) {
    let unsub = null;
    let attempt = 0;
    let timer = null;
    let stopped = false;

    function start() {
        if (stopped) return;
        clearTimeout(timer);
        try { unsub?.(); } catch (e) {}
        unsub = onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
            attempt = 0;
            Debug.listeners[label] = { ok: true, fromCache: snap.metadata.fromCache, at: Date.now() };
            onData(snap);
        }, (err) => {
            Debug.log(label, err);
            Debug.listeners[label] = { ok: false, error: err.code || err.message, at: Date.now() };
            unsub = null;
            timer = setTimeout(start, RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)]);
        });
    }

    const handle = {
        restart() { attempt = 0; start(); },
        stop() { stopped = true; clearTimeout(timer); try { unsub?.(); } catch (e) {} liveListeners.delete(handle); },
        get alive() { return !!unsub; }
    };
    liveListeners.add(handle);
    start();
    return handle;
}

function wakeUp() {
    enableNetwork(db).catch(() => {});
    liveListeners.forEach(h => { if (!h.alive) h.restart(); });
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeUp();
});
window.addEventListener('online', wakeUp);

// Dokument lesen; ausstehende Server-Zeitstempel (z. B. deletedAt direkt nach dem
// Abhaken) werden geschätzt statt null – sonst tauchen Produkte kurz wieder auf.
function docData(d) {
    return { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
}

function tsMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    return new Date(v).getTime() || 0;
}

// Hinweis „wird synchronisiert“ erst zeigen, wenn die Verbindung länger als 3 s hängt –
// sonst blitzt er bei jedem Öffnen kurz auf.
const hintTimers = new WeakMap();
function setSyncHint(el, show) {
    if (!el) return;
    clearTimeout(hintTimers.get(el));
    if (!show) { el.classList.remove('visible'); return; }
    hintTimers.set(el, setTimeout(() => el.classList.add('visible'), 3000));
}

// ===== LETZTER GUTER STAND (localStorage) =====
// Wird beim Start sofort angezeigt, bevor Firestore antwortet.
const Mirror = {
    get(key) {
        try { return JSON.parse(localStorage.getItem('mirror_' + key) || 'null'); } catch (e) { return null; }
    },
    set(key, value) {
        try { localStorage.setItem('mirror_' + key, JSON.stringify(value)); } catch (e) {}
    }
};

// Bilder (Base64) nie in den Spiegel schreiben – localStorage ist klein
function stripForMirror(p) {
    const { imageUrl, ...rest } = p;
    const keepUrl = imageUrl && !String(imageUrl).startsWith('data:');
    return { ...rest, imageUrl: keepUrl ? imageUrl : null, hasImage: !!(p.hasImage || imageUrl), addedAt: tsMillis(p.addedAt), deletedAt: tsMillis(p.deletedAt) || null };
}

// ===== GERÄTESICHERUNG (IndexedDB, letzte 7 Tagesstände) =====
const DeviceBackup = {
    _db: null,
    open() {
        if (this._db) return this._db;
        this._db = new Promise((resolve, reject) => {
            const req = indexedDB.open('einkaufsliste-sicherung', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('tage');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._db;
    },
    async saveList(list, products) {
        try {
            const idb = await this.open();
            const day = new Date().toISOString().slice(0, 10);
            const store = idb.transaction('tage', 'readwrite').objectStore('tage');
            const existing = await new Promise(r => { const g = store.get(day); g.onsuccess = () => r(g.result); g.onerror = () => r(null); });
            const entry = existing || { day, lists: {} };
            entry.lists[list.id] = { name: list.name, savedAt: Date.now(), products: products.map(stripForMirror) };
            store.put(entry, day);
            const keys = await new Promise(r => { const k = store.getAllKeys(); k.onsuccess = () => r(k.result); k.onerror = () => r([]); });
            keys.sort().slice(0, Math.max(0, keys.length - 7)).forEach(k => store.delete(k));
        } catch (e) { Debug.log('Gerätesicherung', e); }
    },
    async all() {
        const idb = await this.open();
        const store = idb.transaction('tage', 'readonly').objectStore('tage');
        return new Promise(r => { const g = store.getAll(); g.onsuccess = () => r(g.result); g.onerror = () => r([]); });
    }
};

// ===== STANDARD KATEGORIEN =====
const DEFAULT_CATEGORIES = [
    { id: 'sonstiges', name: 'Sonstiges',          emoji: '📦' },
    { id: 'obst',      name: 'Obst',               emoji: '🍎' },
    { id: 'gemuese',   name: 'Gemüse',             emoji: '🥦' },
    { id: 'milch',     name: 'Milchprodukte',       emoji: '🥛' },
    { id: 'kosmetik',  name: 'Kosmetik & Pflege',   emoji: '🧴' },
    { id: 'haushalt',  name: 'Haushaltsartikel',    emoji: '🧹' },
    { id: 'suessig',   name: 'Süßigkeiten/Snacks',  emoji: '🍬' }
];

// ===== AUTOMATISCHE KATEGORIE-ERKENNUNG =====
const categoryKeywords = {
    obst: [
        'apfel','äpfel','birne','birnen','banane','bananen','orange','orangen',
        'mandarine','mandarinen','zitrone','zitronen','limette','limetten',
        'erdbeere','erdbeeren','himbeere','himbeeren','blaubeere','blaubeeren',
        'heidelbeere','heidelbeeren','brombeere','brombeeren','johannisbeere',
        'kirsche','kirschen','pflaume','pflaumen','zwetschge','zwetschgen',
        'pfirsich','pfirsiche','nektarine','nektarinen','aprikose','aprikosen',
        'mango','mangos','ananas','melone','melonen','wassermelone','honigmelone',
        'weintraube','weintrauben','traube','trauben','kiwi','kiwis',
        'papaya','papayas','feige','feigen','dattel','datteln',
        'grapefruit','grapefruits','clementine','clementinen','granatapfel',
        'litschi','litschis','maracuja','kokosnuss','avocado','avocados',
        'quitte','quitten','stachelbeere','stachelbeeren','rhabarber',
        'physalis','drachenfrucht','sternfrucht','jackfrucht'
    ],
    gemuese: [
        'tomate','tomaten','gurke','gurken','paprika','zwiebel','zwiebeln',
        'knoblauch','karotte','karotten','möhre','möhren','zucchini',
        'aubergine','auberginen','brokkoli','blumenkohl','spinat','salat',
        'kopfsalat','eisbergsalat','rucola','feldsalat','endivie','radicchio',
        'sellerie','staudensellerie','lauch','porree','kohl','rotkohl',
        'weißkohl','spitzkohl','rosenkohl','wirsing','grünkohl','chinakohl',
        'erbse','erbsen','bohne','bohnen','grüne bohnen','mais','maiskolben',
        'kartoffel','kartoffeln','süßkartoffel','süßkartoffeln','rübe','rüben',
        'kohlrabi','radieschen','rettich','rote bete','rote beete',
        'champignon','champignons','pilz','pilze','steinpilz','pfifferling',
        'ingwer','chili','chilischote','peperoni','fenchel',
        'spargel','artischocke','artischocken','pak choi','mangold',
        'sprossen','bambussprossen','okra','pastinake','kürbis','hokkaido',
        'butternutkürbis','zuckerschote','schnittlauch','petersilie','basilikum',
        'minze','thymian','rosmarin','oregano','salbei','dill','koriander'
    ],
    milch: [
        'milch','vollmilch','fettarme milch','laktosefreie milch','hafermilch',
        'mandelmilch','sojamilch','reismilch','kokosmilch','butter','margarine',
        'käse','schmelzkäse','gouda','emmentaler','edamer','tilsiter','appenzeller',
        'brie','camembert','gorgonzola','roquefort','feta','hirtenkäse',
        'mozzarella','burrata','ricotta','mascarpone','parmesan','pecorino',
        'gruyère','raclettekäse','frischkäse','hüttenkäse','körniger frischkäse',
        'joghurt','naturjoghurt','fruchtjoghurt','griechischer joghurt',
        'skyr','quark','magerquark','speisequark','sahne','schlagsahne',
        'süße sahne','saure sahne','schmand','crème fraîche','creme fraiche',
        'kaffeesahne','kondensmilch','buttermilch','kefir','ayran',
        'ei','eier','hühnereier','freilandeier','bio eier','wachteleier'
    ],
    kosmetik: [
        // Haarpflege
        'shampoo','haarshampoo','conditioner','spülung','haarkur','haarbalsam',
        'haarpflege','haarmaske','haaröl','haarserum','haarspray','haargel',
        'haarmousse','haarwachs','haarpomade','haarfarbe','haarfärbemittel',
        'tönung','blondierung','hitzeschutz','trockenshampoo','trocken shampoo',
        'haarstyling','lockenspray','haarglanz','haarfestiger',
        // Körperpflege
        'duschgel','duschlotion','duschcreme','duschschaum','duschöl',
        'badesalz','badezusatz','schaumbad','badeschaum','badeöl',
        'bodylotion','körperlotion','körpercreme','körperöl','körperspray',
        'körperpflege','bodybutter','body butter','körperbutter',
        // Hand-, Fuß- & Nagelpflege
        'handcreme','handlotion','handpflege','handseife','flüssigseife',
        'fußcreme','fußpflege','fußbad','fußpeeling','fußspray',
        'nagelpflege','nagelcreme','nagellack','nagellackentferner','nagelfeile',
        'nagelpolitur','nagelöl','nagelstärkung','gel nägel',
        // Gesichtspflege
        'gesichtscreme','tagescreme','nachtcreme','augencreme','augenpflege',
        'gesichtspflege','gesichtsmaske','gesichtsserum','gesichtswasser',
        'gesichtsöl','serum','toner','reinigungsöl','reinigungsmilch',
        'reinigungsgel','gesichtsreinigung','mizellenwasser','mizellenreiniger',
        'peeling','gesichtspeeling','körperpeeling','abschminker',
        'make-up-entferner','makeup entferner','liftingcreme','antifaltencreme',
        'faltenglätter','antiaging','anti-aging','bb cream','cc cream',
        'gesichtsfluid','gesichtsgel','gesichtswasser',
        // Dekorative Kosmetik / Make-up
        'foundation','concealer','abdeckcreme','puder','loser puder',
        'rouge','highlighter','bronzer','contouring','primer','setting spray',
        'lippenstift','lipgloss','lipliner','lippenpflege','lip balm','chapstick',
        'mascara','wimperntusche','eyeliner','kajal','lidschatten','eyeshadow',
        'wimpernwelle','eyebrow','augenbraue','brow gel','make up','makeup',
        'schminke','schminkset','schminkpalette','concealer',
        // Sonnenpflege
        'sonnencreme','sonnenschutz','lichtschutz','sunscreen','sunblock',
        'after sun','aftersun','selbstbräuner','bräunungslotion','spf',
        // Deodorant & Parfum
        'deo','deodorant','antitranspirant','deoroller','deostick','deospray',
        'bodyspray','parfum','eau de toilette','eau de parfum','duftspray',
        'körperduft','parfüm',
        // Rasur & Epilation
        'aftershave','rasurwasser','rasierwasser','rasierschaum','rasiergel',
        'rasierseife','rasierer','rasierklinge','damenrasierer','nassrasierer',
        'epilierer','enthaarungscreme','enthaarung','wachsstreifen','waxstreifen',
        // Mundhygiene
        'zahnpasta','zahncreme','zahnbürste','elektrische zahnbürste','zahnseide',
        'mundspülung','mundwasser','mundgel','zungenreiniger','zahnweißung',
        'bleaching','fluorid','zahnspülung','zahnaufheller',
        // Watte & Pflegetools
        'wattestäbchen','wattepad','watte','wattebausch','abschminktuch',
        'reinigungsbürste','gesichtsroller','jade roller','gua sha',
        // Seife
        'seife','duschseife','stückseife','naturseife','kernseife',
        'glycerinseife','pflegeseife','körperseife',
        // Wirkstoffe & Inhaltsstoffe (häufig im Produktnamen)
        'hyaluron','hyaluronsäure','retinol','niacinamid','ceramid','keratin',
        'collagen','aloe vera','arganöl','jojobaöl','biotine','panthenol',
        'salicylsäure','vitamin c serum','vitamin e','peptide','probiotika',
        // Marken (DE-Markt, häufig im Produktnamen)
        'nivea','dove','garnier','loreal','l\'oreal','lancôme','lancome',
        'maybelline','revlon','essence cosmetics','catrice','isana','balea',
        'alverde','weleda','lavera','dr. hauschka','dr hauschka',
        'vichy','la roche-posay','la roche posay','cerave','neutrogena',
        'eucerin','beiersdorf','olaz','olay','palmolive',
        'head & shoulders','head and shoulders','pantene','herbal essences',
        'aussie','tresemmé','schwarzkopf','syoss','got2b','batiste',
        'elnett','wella','kerastase','kérastase',
        'gillette','venus','wilkinson','schick','bic flex',
        'lush','the ordinary','nyx','inisfree','cosrx','some by mi',
        'urban decay','fenty beauty','charlotte tilbury','mac cosmetics',
        'clinique','shiseido','biotherm','clarins','kiehl',
        // Sonstige Kosmetik
        'peeling','körperscrub','scrub','lashserum','wimperserum',
        'lippenserum','augenserum','pflegeserum','ampulle','pflegeampulle',
        'gesichtswasser','reinigungswasser','mizellenwasser'
    ],
    haushalt: [
        // Wäschepflege
        'waschmittel','flüssigwaschmittel','colorwaschmittel','weißwaschmittel',
        'weichspüler','fleckentferner','bleichmittel','wäschestärke',
        // Spülen & Geschirrspüler
        'spülmittel','geschirrspülmittel','spülmaschinentabs','spülmaschinenpulver',
        'spülmaschinenreiniger','entkalker','rohrreiniger','abflussreiniger',
        // Reinigungsmittel
        'putzmittel','allzweckreiniger','badreiniger','wcreiniger','toilettenreiniger',
        'glasreiniger','fensterreiniger','küchenreiniger','backofenreiniger',
        'sanitärreiniger','bodenreiniger','fliesenreiniger',
        'desinfektionsmittel','desinfektionsspray','flächendesinfektion',
        // Papierprodukte
        'toilettenpapier','klopapier','feuchtes toilettenpapier',
        'küchenpapier','küchenrolle','taschentuch','papiertaschentücher',
        // Müll & Frischhalte
        'müllbeutel','müllsäcke','biomüllbeutel','gefrierbeutel','zipbeutel',
        'frischhaltefolie','alufolie','backpapier','pergamentpapier',
        // Reinigungshelfer
        'schwamm','spülschwamm','scheuerschwamm','reinigungstuch','mikrofasertuch',
        'spülbürste','handfeger','kehrschaufel','mop','wischmopp','staubwedel',
        'staubsaugerbeutel','hepafilter',
        // Raumduft
        'lufterfrischer','raumspray','duftkerze','raumduft','wäscheduft',
        // Erste Hilfe
        'pflaster','verband','wunddesinfektion','wundpflaster','wundgel',
        'verbandmull','wundauflage','kühlpad','kühlkissen','schmerztabletten',
        // Elektro & Licht
        'batterien','aa batterien','aaa batterien','knopfzellen','akku','ladekabel',
        'glühbirne','led lampe','leuchtmittel','kerze','teelichter',
        // Büro & Sonstiges
        'streichhölzer','feuerzeug','klebeband','paketband','briefumschlag',
        'briefmarke','schreibblock','kugelschreiber','bleistift','tesa','pattafix',
        'haushaltsgummi','wäscheklammern','besen','kehrset'
    ],
    suessig: [
        'twix','snickers','bounty','mars','milky way','milkyway','kit kat','kitkat',
        'lion','lion bar','kinder bueno','kinder riegel','kinderschokolade',
        'kinder schokolade','kinder','hanuta','duplo','raffaello','ferrero rocher',
        'after eight','ritter sport','ritter','toblerone','lindt','milka',
        'nutella','nutoka','ovomaltine','cadbury','nestle','nestlé',
        'schokolade','vollmilchschokolade','zartbitterschokolade','weißeschokolade',
        'weiße schokolade','dunkle schokolade','praline','pralinen','konfekt',
        'trüffel','schokobons','m&m','m&ms','smarties','maltesers','toffifee',
        'rocher','merci','celebrations','schoko','schoki',
        'gummibärchen','gummibären','haribo','trolli','maoam','nimm2',
        'fruchtgummi','gummi','lakritz','lakritze','salzlakritz','weingummi',
        'fruchtschnecken','brause','brausebonbons','brausetabletten',
        'saure bärchen','saure äpfel','saure schnüre','sour patch','katjes','pistazien',
        'bonbon','bonbons','lutscher','karamell','karamellbonbons','toffee',
        'werther','werthers','nimm 2','mentos','tic tac','fisherman','halls',
        'hustenbonbon','drops','pfefferminz','pfefferminzbonbons','lotuscreame','pistaziencreame','honig',
        'keks','kekse','cookies','plätzchen','waffel','waffeln','leibniz','salted caramel',
        'butterkeks','butterkekse','oreo','oreos','prinzenrolle','prinzen rolle',
        'doppelkeks','mc vitie','chips ahoy','digestive','hobnob',
        'stroopwafel','spekulatius','zimtsterne','lebkuchen','dominosteine',
        'bethmännchen','springerle','makronen','amaretti','cantuccini',
        'kuchen','torte','muffin','muffins','cupcake','cupcakes','donut','donuts',
        'berliner','krapfen','windbeutel','eclair','croissant','brioche',
        'käsekuchen','schwarzwälder','sachertorte','tiramisu',
        'eis','speiseeis','eiscreme','magnum','cornetto','solero','calippo',
        'capri','häagen-dazs','häagen dazs','ben & jerry','ben and jerry',
        'langnese','walls','lusso','cremissimo','vanilleeis','schokoladeneis',
        'erdbeereis','sorbet','frozen yogurt',
        'chips','pringles','lays','doritos','tortilla chips','popcorn',
        'flips','erdnussflips','salzstangen','brezel','brezeln',
        'müsliriegel','riegel','balisto','knoppers','pick up','pickup',
        'leibniz milch','choco crossies','crossies','granola','müslibar',
        'marmelade','konfitüre','gelee','honig','sirup','ahornsirup',
        'nussnougatcreme','nuss nougat',
        'zucker','puderzucker','vanillezucker','schokotröpfchen','streusel',
        'zuckerperlen','vanille'
    ]
};

// Mappe Open Food Facts EN-Tags auf deutsche Konzeptwörter.
// Damit werden eigene Kategorien erkannt: "Getränke" passt zu "en:beverages" weil
// offTagConceptsDE['en:beverages'] das Wort "getränk" enthält.
const offTagConceptsDE = {
    'en:beverages': ['getränk', 'trinken', 'drink', 'saft', 'wasser', 'kaffee', 'tee', 'bier', 'wein'],
    'en:carbonated-beverages': ['getränk', 'limo', 'sprudel', 'cola', 'soda'],
    'en:waters': ['wasser', 'getränk'],
    'en:fruit-juices': ['saft', 'getränk', 'frucht'],
    'en:nectars': ['saft', 'nektar', 'getränk'],
    'en:coffees': ['kaffee', 'getränk'],
    'en:teas': ['tee', 'getränk'],
    'en:teas-and-herbal-teas': ['tee', 'kräuter', 'getränk'],
    'en:beers': ['bier', 'getränk', 'alkohol'],
    'en:wines': ['wein', 'getränk', 'alkohol'],
    'en:spirits': ['schnaps', 'alkohol', 'getränk', 'spirituos'],
    'en:plant-based-beverages': ['getränk', 'pflanzen', 'hafer', 'mandel', 'soja'],
    'en:energy-drinks': ['getränk', 'energie'],
    'en:dairy-products': ['milch', 'milchprodukt', 'molkerei'],
    'en:dairies': ['milch', 'milchprodukt'],
    'en:cheeses': ['käse', 'milch'],
    'en:yogurts': ['joghurt', 'milch'],
    'en:butters': ['butter', 'milch'],
    'en:creams': ['sahne', 'creme', 'milch'],
    'en:eggs': ['ei', 'eier', 'milch'],
    'en:fruits': ['obst', 'frucht'],
    'en:fresh-fruits': ['obst', 'frucht', 'frisch'],
    'en:dried-fruits': ['obst', 'frucht', 'trocken'],
    'en:vegetables': ['gemüse', 'gemuese', 'salat'],
    'en:fresh-vegetables': ['gemüse', 'gemuese', 'frisch'],
    'en:herbs': ['kräuter', 'gewürz'],
    'en:mushrooms': ['pilz', 'champignon'],
    'en:confectioneries': ['süß', 'suessig', 'süßigkeit', 'candy', 'bonbon'],
    'en:chocolates': ['schoko', 'schokolade', 'süß'],
    'en:sweet-snacks': ['süß', 'snack'],
    'en:candies': ['süß', 'bonbon', 'candy'],
    'en:snacks': ['snack', 'chips'],
    'en:biscuits-and-cakes': ['keks', 'kuchen', 'gebäck', 'süß'],
    'en:ice-creams': ['eis', 'süß', 'tiefkühl'],
    'en:cleaning-products': ['reinig', 'haushalt', 'putz'],
    'en:household-products': ['haushalt', 'haus'],
    // Kosmetik & Pflege
    'en:beauty-products': ['kosmetik', 'beauty', 'pflege', 'schminke'],
    'en:cosmetics': ['kosmetik', 'beauty', 'pflege', 'schminke'],
    'en:personal-care': ['kosmetik', 'pflege', 'körper', 'hygien'],
    'en:hygiene-products': ['kosmetik', 'hygien', 'pflege'],
    'en:skin-care': ['kosmetik', 'haut', 'creme', 'pflege', 'serum'],
    'en:face-care': ['kosmetik', 'gesicht', 'creme', 'pflege'],
    'en:body-care': ['kosmetik', 'körper', 'lotion', 'pflege'],
    'en:hair-care': ['kosmetik', 'haar', 'shampoo', 'pflege'],
    'en:lip-care': ['kosmetik', 'lippe', 'lip', 'pflege'],
    'en:nail-care': ['kosmetik', 'nagel', 'pflege'],
    'en:nail-polish': ['kosmetik', 'nagellack', 'nagel'],
    'en:makeup': ['kosmetik', 'makeup', 'make-up', 'schminke'],
    'en:face-makeup': ['kosmetik', 'makeup', 'gesicht', 'schminke'],
    'en:eye-makeup': ['kosmetik', 'makeup', 'augen', 'schminke'],
    'en:lip-makeup': ['kosmetik', 'lippenstift', 'lip', 'schminke'],
    'en:foundations': ['kosmetik', 'foundation', 'makeup', 'schminke'],
    'en:concealers': ['kosmetik', 'concealer', 'makeup'],
    'en:mascaras': ['kosmetik', 'mascara', 'wimpern', 'schminke'],
    'en:eyeliners': ['kosmetik', 'eyeliner', 'kajal', 'schminke'],
    'en:lipsticks': ['kosmetik', 'lippenstift', 'lip'],
    'en:blushers': ['kosmetik', 'rouge', 'makeup'],
    'en:powders': ['kosmetik', 'puder', 'makeup'],
    'en:perfumes': ['kosmetik', 'parfum', 'duft', 'fragrance'],
    'en:deodorants': ['kosmetik', 'deo', 'deodorant', 'antitranspirant'],
    'en:antiperspirants': ['kosmetik', 'deo', 'antitranspirant'],
    'en:shampoos': ['kosmetik', 'shampoo', 'haar'],
    'en:shower-gels': ['kosmetik', 'duschgel', 'körper'],
    'en:body-washes': ['kosmetik', 'duschgel', 'körper'],
    'en:sunscreens': ['kosmetik', 'sonnenschutz', 'sunscreen', 'spf'],
    'en:sun-care': ['kosmetik', 'sonnenpflege', 'spf', 'sonnenschutz'],
    'en:toothpastes': ['kosmetik', 'zahnpasta', 'zahn'],
    'en:toothbrushes': ['kosmetik', 'zahnbürste', 'zahn'],
    'en:mouthwashes': ['kosmetik', 'mundspülung', 'mundwasser'],
    'en:soaps': ['kosmetik', 'seife', 'handseife'],
    'en:hand-creams': ['kosmetik', 'handcreme', 'hand'],
    'en:foot-care': ['kosmetik', 'fußpflege', 'fußcreme'],
    'en:shaving-products': ['kosmetik', 'rasur', 'rasierer', 'rasierschaum'],
    'en:aftershaves': ['kosmetik', 'aftershave', 'rasur'],
    'en:hair-dyes': ['kosmetik', 'haarfarbe', 'färben', 'tönung'],
    'en:conditioners': ['kosmetik', 'conditioner', 'spülung', 'haar'],
    'en:hair-masks': ['kosmetik', 'haarkur', 'haarmaske'],
    'en:serums': ['kosmetik', 'serum', 'pflege'],
    'en:eye-care': ['kosmetik', 'augenpflege', 'auge'],
    'en:facial-cleansers': ['kosmetik', 'reinigung', 'gesicht', 'reinigungsgel'],
    'en:toners': ['kosmetik', 'toner', 'gesichtswasser'],
    'en:moisturizers': ['kosmetik', 'feuchtigkeitscreme', 'pflege', 'creme'],
    'en:baby-foods': ['baby', 'kind', 'kleinkind'],
    'en:cereals': ['müsli', 'getreide', 'frühstück', 'cornflakes'],
    'en:breads': ['brot', 'backwar', 'bäcker', 'toast'],
    'en:meats': ['fleisch', 'wurst', 'schinken'],
    'en:fish': ['fisch', 'meeresfrüchte'],
    'en:pasta': ['nudel', 'pasta', 'spaghetti'],
    'en:frozen-foods': ['tiefkühl', 'frozen', 'gefroren'],
    'en:sauces': ['soße', 'sauce', 'dressing', 'ketchup'],
    'en:spices': ['gewürz', 'würze'],
    'en:oils-and-fats': ['öl', 'fett'],
    'en:pet-foods': ['tier', 'hund', 'katze', 'haustier', 'pet'],
    'en:dog-foods': ['hund', 'hundefutter', 'tier'],
    'en:cat-foods': ['katze', 'katzenfutter', 'tier'],
};

// Mappe OF-Tags auf Standard-Kategorien (Fallback wenn keine eigene Kategorie passt)
const offToCategoryMap = {
    // Milch
    'en:dairy-products': 'milch', 'en:dairies': 'milch', 'en:cheeses': 'milch',
    'en:yogurts': 'milch', 'en:butters': 'milch', 'en:creams': 'milch', 'en:eggs': 'milch',
    // Obst
    'en:fruits': 'obst', 'en:fresh-fruits': 'obst', 'en:dried-fruits': 'obst',
    // Gemüse
    'en:vegetables': 'gemuese', 'en:fresh-vegetables': 'gemuese',
    'en:herbs': 'gemuese', 'en:mushrooms': 'gemuese',
    // Süßigkeiten
    'en:confectioneries': 'suessig', 'en:chocolates': 'suessig',
    'en:sweet-snacks': 'suessig', 'en:candies': 'suessig',
    'en:biscuits-and-cakes': 'suessig', 'en:ice-creams': 'suessig',
    'en:chips-and-fries': 'suessig', 'en:snacks': 'suessig',
    // Haushalt
    'en:cleaning-products': 'haushalt', 'en:household-products': 'haushalt',
    // Kosmetik & Pflege (vorher teilweise haushalt)
    'en:beauty-products': 'kosmetik', 'en:cosmetics': 'kosmetik',
    'en:personal-care': 'kosmetik', 'en:hygiene-products': 'kosmetik',
    'en:skin-care': 'kosmetik', 'en:face-care': 'kosmetik',
    'en:body-care': 'kosmetik', 'en:hair-care': 'kosmetik',
    'en:lip-care': 'kosmetik', 'en:nail-care': 'kosmetik',
    'en:nail-polish': 'kosmetik', 'en:makeup': 'kosmetik',
    'en:face-makeup': 'kosmetik', 'en:eye-makeup': 'kosmetik',
    'en:lip-makeup': 'kosmetik', 'en:foundations': 'kosmetik',
    'en:concealers': 'kosmetik', 'en:mascaras': 'kosmetik',
    'en:eyeliners': 'kosmetik', 'en:lipsticks': 'kosmetik',
    'en:blushers': 'kosmetik', 'en:powders': 'kosmetik',
    'en:perfumes': 'kosmetik', 'en:deodorants': 'kosmetik',
    'en:antiperspirants': 'kosmetik', 'en:shampoos': 'kosmetik',
    'en:shower-gels': 'kosmetik', 'en:body-washes': 'kosmetik',
    'en:sunscreens': 'kosmetik', 'en:sun-care': 'kosmetik',
    'en:toothpastes': 'kosmetik', 'en:toothbrushes': 'kosmetik',
    'en:mouthwashes': 'kosmetik', 'en:soaps': 'kosmetik',
    'en:hand-creams': 'kosmetik', 'en:foot-care': 'kosmetik',
    'en:shaving-products': 'kosmetik', 'en:aftershaves': 'kosmetik',
    'en:hair-dyes': 'kosmetik', 'en:conditioners': 'kosmetik',
    'en:hair-masks': 'kosmetik', 'en:serums': 'kosmetik',
    'en:eye-care': 'kosmetik', 'en:facial-cleansers': 'kosmetik',
    'en:toners': 'kosmetik', 'en:moisturizers': 'kosmetik',
};

function detectCategoryFromOFF(tags) {
    if (!tags || !tags.length) return null;
    for (const tag of tags) {
        const cat = offToCategoryMap[tag.toLowerCase()];
        if (cat) return cat;
    }
    return null;
}

// Haupt-Funktion: prüft zuerst eigene Kategorien semantisch via OFF-Tags,
// dann Standard-Mapping, dann lokale Keywords.
function detectCategoryWithOFF(productName, offTags) {
    if (offTags && offTags.length) {
        for (const cat of AppState.customCategories) {
            const catNameLower = cat.name.toLowerCase();
            for (const tag of offTags) {
                const concepts = offTagConceptsDE[tag.toLowerCase()] || [];
                if (concepts.some(concept => catNameLower.includes(concept))) return cat.id;
            }
        }
        const standard = detectCategoryFromOFF(offTags);
        if (standard) return standard;
    }
    return detectCategory(productName);
}

function detectCategory(productName) {
    const name = productName.toLowerCase().trim();

    // Eigene Kategorien: Kategoriename als Stichwort prüfen
    for (const cat of AppState.customCategories) {
        const words = cat.name.toLowerCase().split(/[\s\-\/,;+&]+/).filter(w => w.length > 2);
        for (const word of words) {
            if (name.includes(word)) return cat.id;
        }
    }

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
        for (const keyword of keywords) {
            if (name.includes(keyword)) return category;
        }
    }
    return 'sonstiges';
}

// Produktzähler am Listen-Dokument – bewusst getrennt vom Produkt-Schreibvorgang,
// damit ein Produkt nie verloren geht, nur weil der Zähler nicht passt.
// Falsche Zähler repariert die Listenseite selbst (siehe applyProducts).
function bumpCount(listId, n) {
    updateDoc(doc(db, "lists", listId), { productCount: increment(n) })
        .catch(e => Debug.log('Zähler', e));
}

const imageCache = new Map();

// ===== APP STATE =====
const PRODUCT_TRASH_DAYS = 7;
const LIST_TRASH_DAYS = 30;

const AppState = {
    lists: [],
    activeListId: null,
    activeList: null,
    customCategories: [],
    hiddenDefaultCategories: [],

    initLocalState() {
        const activeId = localStorage.getItem('activeListId');
        if (activeId) this.activeListId = activeId;
    },

    setActiveList(id) {
        this.activeListId = id;
        if (id) localStorage.setItem('activeListId', id);
    },

    // Gibt alle sichtbaren Kategorien zurück
    getCategories() {
        const visibleDefaults = DEFAULT_CATEGORIES.filter(
            c => !this.hiddenDefaultCategories.includes(c.id)
        );
        return [...visibleDefaults, ...this.customCategories];
    },

    getCategoryInfo(id) {
        const all = [...DEFAULT_CATEGORIES, ...this.customCategories];
        return all.find(c => c.id === id) || { id: 'sonstiges', name: 'Sonstiges', emoji: '📦' };
    },

    async hideDefaultCategory(listId, catId) {
        if (!this.hiddenDefaultCategories.includes(catId)) this.hiddenDefaultCategories.push(catId);
        setDoc(doc(db, "lists", listId, "hiddenCategories", catId), { hidden: true })
            .catch(e => Debug.log('Kategorie ausblenden', e));
    },

    async showDefaultCategory(listId, catId) {
        this.hiddenDefaultCategories = this.hiddenDefaultCategories.filter(id => id !== catId);
        deleteDoc(doc(db, "lists", listId, "hiddenCategories", catId))
            .catch(e => Debug.log('Kategorie einblenden', e));
    },

    async addCustomCategory(listId, name, emoji) {
        const id = 'custom_' + Date.now();
        const cat = { id, name: name.trim(), emoji: emoji || '🏷️' };
        this.customCategories.push(cat);
        setDoc(doc(db, "lists", listId, "categories", id), cat)
            .catch(e => Debug.log('Kategorie anlegen', e));
        return cat;
    },

    async deleteCustomCategory(listId, catId) {
        this.customCategories = this.customCategories.filter(c => c.id !== catId);
        deleteDoc(doc(db, "lists", listId, "categories", catId))
            .catch(e => Debug.log('Kategorie löschen', e));
    },

    createList(name) {
        const ref = doc(collection(db, "lists"));
        const list = {
            name: name.trim() || "Einkaufsliste",
            familyId: currentFamilyId,
            createdAt: serverTimestamp(),
            productCount: 0,
            deletedAt: null
        };
        const batch = writeBatch(db);
        batch.set(ref, list);
        const saved = batch.commit().catch(e => Debug.log('Liste anlegen', e));
        this.setActiveList(ref.id);
        return { id: ref.id, saved };
    },

    renameList(id, newName) {
        updateDoc(doc(db, "lists", id), { name: newName.trim() || "Einkaufsliste" })
            .catch(e => Debug.log('Liste umbenennen', e));
    },

    // Papierkorb statt Löschen: die Liste bekommt nur ein Datum, alle Produkte bleiben
    deleteList(id) {
        updateDoc(doc(db, "lists", id), { deletedAt: serverTimestamp(), deletedBy: currentUsername || null })
            .catch(e => Debug.log('Liste in Papierkorb', e));
        if (this.activeListId === id) {
            this.activeListId = null;
            localStorage.removeItem("activeListId");
        }
    },

    restoreList(id) {
        updateDoc(doc(db, "lists", id), { deletedAt: null })
            .catch(e => Debug.log('Liste wiederherstellen', e));
    },

    // Fügt ein Produkt hinzu (sofort, auch offline). Gibt die neue ID zurück.
    addProduct(listId, name, category, imageUrl = null, extra = {}) {
        if (!name || !name.trim()) return null;
        const autoCategory = category === 'sonstiges' ? detectCategory(name) : category;
        const ref = doc(collection(db, "lists", listId, "products"));
        const isDataImage = imageUrl && String(imageUrl).startsWith('data:');
        const key = photoKey(name);
        const batch = writeBatch(db);
        batch.set(ref, {
            name: name.trim(),
            photoKey: key,
            category: autoCategory,
            checked: false,
            imageUrl: isDataImage ? null : (imageUrl || null),
            hasImage: !!imageUrl,
            qty: extra.qty || null,
            source: extra.source || 'hand',
            addedBy: currentUsername || null,
            addedAt: serverTimestamp(),
            deletedAt: null
        });
        // Fotos liegen in einer eigenen Sammlung und werden nur beim Antippen geladen
        if (isDataImage) {
            batch.set(doc(db, "lists", listId, "productImages", ref.id), { data: imageUrl, createdAt: serverTimestamp() });
        }
        // Foto-Gedächtnis: neues Foto merken, sonst ein früheres Foto gleichen Namens zurückholen
        if (imageUrl) {
            batch.set(doc(db, "lists", listId, "photoMemory", key), { name: name.trim(), data: imageUrl, updatedAt: serverTimestamp() });
        }
        commitQuietly(batch, 'Produkt hinzufügen');
        bumpCount(listId, 1);
        if (!imageUrl) this.attachRememberedPhoto(listId, ref.id, name);
        return ref.id;
    },

    // Sucht im Foto-Gedächtnis dieser Liste (und der anderen Familienlisten) ein Foto
    // zum Produktnamen und hängt es an. Gibt true zurück, wenn eins gefunden wurde.
    async attachRememberedPhoto(listId, productId, name, { onlyThisList = false } = {}) {
        const key = photoKey(name);
        const others = onlyThisList ? [] : (Mirror.get('lists_' + currentFamilyId) || [])
            .filter(l => !l.deletedAt && l.id !== listId).map(l => l.id);
        for (const id of [listId, ...others].slice(0, 12)) {
            try {
                const snap = await getDoc(doc(db, "lists", id, "photoMemory", key));
                if (snap.exists()) {
                    this.updateProduct(listId, productId, { hasImage: true, photoKey: key, photoListId: id });
                    return true;
                }
            } catch (e) { /* offline: später erneut */ }
        }
        return false;
    },

    updateProduct(listId, productId, fields) {
        updateDoc(doc(db, "lists", listId, "products", productId), fields)
            .catch(e => Debug.log('Produkt ändern', e));
    },

    // Abhaken / Entfernen = in den Papierkorb (7 Tage), nie endgültig löschen
    removeProducts(listId, ids, reason = 'abgehakt') {
        if (!ids.length) return;
        const batch = writeBatch(db);
        ids.forEach(id => batch.update(doc(db, "lists", listId, "products", id), {
            deletedAt: serverTimestamp(),
            deletedReason: reason,
            deletedBy: currentUsername || null
        }));
        commitQuietly(batch, 'Produkte entfernen');
        bumpCount(listId, -ids.length);
    },

    restoreProducts(listId, ids) {
        if (!ids.length) return;
        const batch = writeBatch(db);
        ids.forEach(id => batch.update(doc(db, "lists", listId, "products", id), { deletedAt: null }));
        commitQuietly(batch, 'Produkte wiederherstellen');
        bumpCount(listId, ids.length);
    },

    async loadImage(listId, product) {
        if (product.imageUrl) return product.imageUrl;
        if (imageCache.has(product.id)) return imageCache.get(product.id);
        try {
            let src = null;
            if (!product.photoListId) {
                const snap = await getDoc(doc(db, "lists", listId, "productImages", product.id));
                src = snap.exists() ? snap.data().data : null;
            }
            if (!src) {
                const mem = await getDoc(doc(db, "lists", product.photoListId || listId, "photoMemory", product.photoKey || photoKey(product.name)));
                src = mem.exists() ? mem.data().data : null;
            }
            if (src) imageCache.set(product.id, src);
            return src;
        } catch (e) {
            Debug.log('Foto laden', e);
            return null;
        }
    }
};

// ===== HILFSFUNKTIONEN =====
function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('active');
    const input = modal.querySelector('input:not([readonly]):not([type="file"])');
    if (input) setTimeout(() => input.focus(), 100);
}

function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('active');
}

function hideAllModals() {
    document.querySelectorAll('.modal-overlay, .scanner-overlay').forEach(m => m.classList.remove('active'));
}

function formatDate(dateValue) {
    if (!dateValue) return 'Gerade eben';
    const date = new Date(tsMillis(dateValue));
    const days = Math.floor((new Date() - date) / 86400000);
    if (days === 0) return 'Heute';
    if (days === 1) return 'Gestern';
    if (days < 7) return `Vor ${days} Tagen`;
    return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

function formatAgo(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return 'gerade eben';
    if (mins < 60) return `vor ${mins} Min.`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `vor ${hours} Std.`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function resizeImage(base64, maxWidth = 800) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, maxWidth / img.width);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = base64;
    });
}

function showToast(message, duration = 3000) {
    document.getElementById('app-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// ===== RÜCKGÄNGIG-LEISTE (6 Sekunden) =====
let undoTimer = null;
function showUndo(message, onUndo, duration = 6000) {
    document.getElementById('undo-bar')?.remove();
    clearTimeout(undoTimer);
    const bar = document.createElement('div');
    bar.id = 'undo-bar';
    bar.className = 'undo-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span class="undo-text"></span><button class="undo-btn" type="button">Rückgängig</button>`;
    bar.querySelector('.undo-text').textContent = message;
    bar.querySelector('.undo-btn').addEventListener('click', () => {
        bar.remove();
        clearTimeout(undoTimer);
        onUndo();
    });
    document.body.appendChild(bar);
    requestAnimationFrame(() => bar.classList.add('visible'));
    undoTimer = setTimeout(() => {
        bar.classList.remove('visible');
        setTimeout(() => bar.remove(), 300);
    }, duration);
}

// ===== BESTÄTIGUNG (ersetzt confirm()) =====
function askConfirm({ title, message, confirmText = 'Löschen', danger = true }) {
    return new Promise((resolve) => {
        let overlay = document.getElementById('appConfirm');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'appConfirm';
            overlay.innerHTML = `
                <div class="modal" role="alertdialog" aria-modal="true">
                    <div class="modal-header"><h2 class="ac-title"></h2></div>
                    <div class="modal-body"><p class="ac-message confirm-text"></p></div>
                    <div class="modal-footer">
                        <button class="btn btn-cancel ac-cancel">Abbrechen</button>
                        <button class="btn ac-ok"></button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
        }
        overlay.querySelector('.ac-title').textContent = title;
        overlay.querySelector('.ac-message').textContent = message;
        const ok = overlay.querySelector('.ac-ok');
        ok.textContent = confirmText;
        ok.className = 'btn ac-ok ' + (danger ? 'btn-danger' : 'btn-confirm');
        const done = (value) => {
            overlay.classList.remove('active');
            ok.onclick = null;
            overlay.querySelector('.ac-cancel').onclick = null;
            overlay.onclick = null;
            resolve(value);
        };
        ok.onclick = () => done(true);
        overlay.querySelector('.ac-cancel').onclick = () => done(false);
        overlay.onclick = (e) => { if (e.target === overlay) done(false); };
        overlay.classList.add('active');
    });
}

// ===== SICHERUNG HERUNTERLADEN / EINSPIELEN =====
function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function plainValue(v) {
    if (v && typeof v.toMillis === 'function') return { __ms: v.toMillis() };
    if (Array.isArray(v)) return v.map(plainValue);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainValue(x)]));
    return v;
}

async function exportFamilyBackup() {
    const listsSnap = await getDocs(query(collection(db, "lists"), where("familyId", "==", currentFamilyId)));
    const lists = [];
    for (const l of listsSnap.docs) {
        const [products, categories, hidden] = await Promise.all([
            getDocs(collection(db, "lists", l.id, "products")),
            getDocs(collection(db, "lists", l.id, "categories")),
            getDocs(collection(db, "lists", l.id, "hiddenCategories"))
        ]);
        lists.push({
            id: l.id,
            data: plainValue(l.data()),
            products: products.docs.map(d => ({ id: d.id, data: plainValue(d.data()) })),
            categories: categories.docs.map(d => ({ id: d.id, data: plainValue(d.data()) })),
            hiddenCategories: hidden.docs.map(d => d.id)
        });
    }
    return { app: 'einkaufsliste', version: 1, exportedAt: new Date().toISOString(), familyId: currentFamilyId, lists };
}

function fromPlain(v) {
    if (v && typeof v === 'object' && '__ms' in v) return new Date(v.__ms);
    if (Array.isArray(v)) return v.map(fromPlain);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromPlain(x)]));
    return v;
}

// Spielt eine Sicherung additiv ein: fehlende Listen und Produkte werden angelegt,
// gelöschte wiederhergestellt. Es wird nichts überschrieben oder entfernt.
async function importFamilyBackup(backup) {
    if (!backup || backup.app !== 'einkaufsliste' || !Array.isArray(backup.lists)) {
        throw new Error('Das ist keine Sicherung dieser App.');
    }
    let batch = writeBatch(db);
    let ops = 0;
    let restoredLists = 0;
    let restoredProducts = 0;
    const flush = async () => { if (ops) { await batch.commit(); batch = writeBatch(db); ops = 0; } };
    const add = async (fn) => { fn(batch); ops++; if (ops >= 400) await flush(); };

    for (const l of backup.lists) {
        const listRef = doc(db, "lists", l.id);
        const existing = await getDoc(listRef);
        const products = l.products || [];
        if (!existing.exists()) {
            await add(b => b.set(listRef, { ...fromPlain(l.data), familyId: currentFamilyId, deletedAt: null }));
            restoredLists++;
        } else if (existing.data().deletedAt) {
            await add(b => b.update(listRef, { deletedAt: null }));
            restoredLists++;
        }
        const current = await getDocs(collection(db, "lists", l.id, "products"));
        const byId = new Map(current.docs.map(d => [d.id, d.data()]));
        for (const p of products) {
            const data = fromPlain(p.data);
            if (data.deletedAt) continue;
            const have = byId.get(p.id);
            if (!have) {
                await add(b => b.set(doc(db, "lists", l.id, "products", p.id), { ...data, deletedAt: null }));
                restoredProducts++;
            } else if (have.deletedAt) {
                await add(b => b.update(doc(db, "lists", l.id, "products", p.id), { deletedAt: null }));
                restoredProducts++;
            }
        }
        for (const c of l.categories || []) {
            await add(b => b.set(doc(db, "lists", l.id, "categories", c.id), fromPlain(c.data), { merge: true }));
        }
    }
    await flush();
    return { restoredLists, restoredProducts };
}

function pickJsonFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            try { resolve(JSON.parse(await file.text())); } catch (e) { resolve({ __error: true }); }
        };
        input.click();
    });
}

async function runBackupDownload() {
    showToast('Sicherung wird erstellt…');
    try {
        const data = await exportFamilyBackup();
        const count = data.lists.reduce((n, l) => n + l.products.filter(p => !p.data.deletedAt).length, 0);
        downloadJson(`einkaufsliste-sicherung-${new Date().toISOString().slice(0, 10)}.json`, data);
        showToast(`Gesichert: ${data.lists.length} Listen, ${count} Produkte`);
    } catch (e) {
        Debug.log('Sicherung', e);
        showToast('Sicherung ging nicht. Bitte mit Internet erneut versuchen.', 4000);
    }
}

async function runBackupImport() {
    const backup = await pickJsonFile();
    if (!backup) return;
    if (backup.__error || backup.app !== 'einkaufsliste') {
        showToast('Diese Datei ist keine Sicherung der Einkaufsliste.', 4000);
        return;
    }
    const n = backup.lists.reduce((s, l) => s + (l.products || []).filter(p => !p.data?.deletedAt).length, 0);
    const ok = await askConfirm({
        title: 'Sicherung einspielen?',
        message: `Sicherung vom ${new Date(backup.exportedAt).toLocaleDateString('de-DE')} mit ${backup.lists.length} Listen und ${n} Produkten. Fehlende Listen und Produkte werden wiederhergestellt, nichts wird gelöscht.`,
        confirmText: 'Einspielen',
        danger: false
    });
    if (!ok) return;
    try {
        const r = await importFamilyBackup(backup);
        showToast(`Fertig: ${r.restoredLists} Listen und ${r.restoredProducts} Produkte wiederhergestellt`, 4500);
    } catch (e) {
        Debug.log('Einspielen', e);
        showToast('Einspielen fehlgeschlagen: ' + (e.message || e), 4500);
    }
}

async function runDeviceBackupDownload() {
    try {
        const days = await DeviceBackup.all();
        downloadJson(`einkaufsliste-geraetesicherung-${new Date().toISOString().slice(0, 10)}.json`, { app: 'einkaufsliste-geraet', days });
    } catch (e) {
        showToast('Keine Gerätesicherung vorhanden.');
    }
}

// ===== DEBUG-PANEL (5× schnell auf den Titel tippen) =====
function attachDebugTrigger(el) {
    if (!el) return;
    let taps = [];
    el.addEventListener('click', () => {
        const now = Date.now();
        taps = taps.filter(t => now - t < 2500);
        taps.push(now);
        if (taps.length >= 5) { taps = []; openDebugPanel(); }
    });
}

async function openDebugPanel() {
    let persisted = 'unbekannt';
    try { persisted = (await navigator.storage?.persisted?.()) ? 'ja' : 'nein'; } catch (e) {}
    const listeners = Object.entries(Debug.listeners).map(([k, v]) =>
        `${v.ok ? '🟢' : '🔴'} ${k}: ${v.ok ? (v.fromCache ? 'aus Cache' : 'live vom Server') : v.error} (${formatAgo(v.at)})`
    ).join('\n') || '–';
    const errors = Debug.errors.slice(0, 10).map(e => `${e.at.slice(5, 16).replace('T', ' ')} ${e.label}: ${e.msg}`).join('\n') || 'keine';
    const text = [
        `Version: ${APP_VERSION}`,
        `Internet: ${navigator.onLine ? 'online' : 'OFFLINE'}`,
        `Benutzer: ${currentUsername} (Familie ${String(currentFamilyId).slice(0, 8)}…)`,
        `Speicher dauerhaft: ${persisted}`,
        `Service Worker: ${navigator.serviceWorker?.controller ? 'aktiv' : 'keiner'}`,
        '', 'Verbindungen:', listeners, '', 'Letzte Fehler:', errors
    ].join('\n');

    let overlay = document.getElementById('debugPanel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'debugPanel';
        overlay.innerHTML = `
            <div class="modal">
                <div class="modal-header"><h2>Diagnose</h2></div>
                <div class="modal-body"><pre class="debug-text"></pre></div>
                <div class="modal-footer debug-actions">
                    <button class="btn btn-cancel" data-act="copy">Kopieren</button>
                    <button class="btn btn-cancel" data-act="device">Gerätesicherung</button>
                    <button class="btn btn-cancel" data-act="reload">Neu laden</button>
                    <button class="btn btn-confirm" data-act="close">Schließen</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (e.target === overlay || act === 'close') overlay.classList.remove('active');
            if (act === 'copy') {
                try { await navigator.clipboard.writeText(overlay.querySelector('.debug-text').textContent); showToast('Kopiert'); } catch (err) {}
            }
            if (act === 'device') runDeviceBackupDownload();
            if (act === 'reload') { wakeUp(); location.reload(); }
        });
    }
    overlay.querySelector('.debug-text').textContent = text;
    overlay.classList.add('active');
}

// ===== FIREBASE-ANMELDUNG (Gast-Konto + Familien-Mitgliedschaft) =====
// Vorbereitung für sichere Regeln: Jedes Gerät meldet sich still als Gast an und
// trägt sich als Mitglied seiner Familie ein. Niemand muss sich neu anmelden.
// Ist die Gast-Anmeldung in Firebase (noch) nicht eingeschaltet, passiert nichts.
let authReady = null;
function getAuthUser() {
    if (!authReady) {
        authReady = (async () => {
            const { getAuth, signInAnonymously, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js");
            const auth = getAuth(app);
            const existing = await new Promise((resolve) => {
                const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
            });
            return existing || (await signInAnonymously(auth)).user;
        })().catch((e) => { authReady = null; throw e; });
    }
    return authReady;
}

async function getIdToken() {
    try { return await (await getAuthUser()).getIdToken(); } catch (e) { return null; }
}

async function ensureMembership() {
    if (Number(localStorage.getItem('auth_off_until') || 0) > Date.now()) return;
    try {
        const user = await getAuthUser();
        const flag = `member_${user.uid}_${currentFamilyId}`;
        if (localStorage.getItem(flag)) return;
        const data = {
            userId: currentUser.uid || null,
            username: currentUser.username || null,
            joinedAt: serverTimestamp(),
            device: navigator.userAgent.slice(0, 120)
        };
        if (currentUser.passwordHash) data.proof = currentUser.passwordHash;
        await setDoc(doc(db, "families", currentFamilyId, "members", user.uid), data, { merge: true });
        localStorage.setItem(flag, '1');
    } catch (e) {
        // Gast-Anmeldung in Firebase noch nicht eingeschaltet → 12 Stunden nicht erneut versuchen
        if (/configuration-not-found|operation-not-allowed|admin-restricted/.test(e?.code || '')) {
            localStorage.setItem('auth_off_until', String(Date.now() + 12 * 3600 * 1000));
        }
        Debug.log('Anmeldung', e);
    }
}

// ===== NEUE VERSION – NEU LADEN =====
// ===== AUTOMATISCHE UPDATES (wie Streak-App) =====
// Die App fragt beim Start, alle 3 Minuten und beim Zurückkehren nach version.json.
// Gibt es eine neue Version und ist gerade kein Fenster offen, lädt sie sich mit
// kurzem Ladebildschirm selbst neu. Während einer Eingabe wird gewartet.
let lastUpdateCheck = 0;
async function checkForUpdate() {
    lastUpdateCheck = Date.now();
    try {
        const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { version } = await res.json();
        if (!version || version === APP_VERSION) return;
        const busy = document.querySelector('.modal-overlay.active, .voice-panel.active, .scanner-overlay.active, #undo-bar')
            || (document.activeElement?.tagName === 'INPUT' && document.activeElement.value);
        if (busy) { setTimeout(checkForUpdate, 20000); return; }
        showUpdateScreen();
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
            const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
            await Promise.all(regs.map(r => r.update().catch(() => {})));
        } catch (e) {}
        const url = new URL(location.href);
        url.searchParams.set('v', version);
        location.replace(url.toString());
    } catch (e) { /* offline – später erneut */ }
}

function showUpdateScreen() {
    if (document.getElementById('update-screen')) return;
    const el = document.createElement('div');
    el.id = 'update-screen';
    el.className = 'update-screen';
    el.innerHTML = `<img src="apple-touch-icon.png" alt=""><div class="update-spinner"></div><p>Neue Version wird geladen …</p>`;
    document.body.appendChild(el);
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(e => Debug.log('Service Worker', e));
    }
    setTimeout(checkForUpdate, 4000);
    setInterval(checkForUpdate, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > 20000) checkForUpdate();
    });
}

const isHomePage = !!document.getElementById('newListBtn');
const isListPage = !!document.getElementById('addProductBtn');

const _session = JSON.parse(localStorage.getItem('auth_session') || 'null');
const _expired = _session && _session.expiresAt && Date.now() > _session.expiresAt;
if (!_session || !_session.familyId || _expired) {
    if (_expired) localStorage.removeItem('auth_session');
    document.body.style.visibility = 'hidden';
    window.location.href = 'auth.html';
} else {
    // Session-Ablauf bei jedem Öffnen um 30 Tage verlängern (Sliding Expiry)
    _session.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem('auth_session', JSON.stringify(_session));
currentFamilyId = _session.familyId;
currentUsername = _session.displayName || _session.username || '';
currentUser = _session;

AppState.initLocalState();
registerServiceWorker();
ensureMembership();

// ===== STARTSEITE =====
if (isHomePage) {
    // Benutzernamen in Untertitel anzeigen
    if (currentUsername) {
        const subtitleEl = document.querySelector('.subtitle');
        if (subtitleEl) subtitleEl.textContent = `Hallo, ${currentUsername}!`;
    }
    attachDebugTrigger(document.querySelector('.header h1') || document.querySelector('h1'));

    const logout = () => {
        localStorage.removeItem('auth_session');
        window.location.href = 'auth.html';
    };
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    const listsContainer = document.getElementById('listsContainer');
    const recentLists = document.getElementById('recentLists');
    const listNameInput = document.getElementById('listNameInput');
    const homeStatus = document.getElementById('homeStatus');
    let allLists = [];
    let menuListId = null;
    let serverConfirmed = false;

    const openList = (id) => {
        AppState.setActiveList(id);
        window.location.href = `shopping-list.html?list=${encodeURIComponent(id)}`;
    };

    function countLabel(list) {
        return typeof list.productCount === 'number' ? `${Math.max(0, list.productCount)} Produkte · ` : '';
    }

    function renderRecentLists() {
        const visible = AppState.lists;
        if (visible.length === 0) {
            listsContainer.innerHTML = serverConfirmed
                ? ''
                : `<div class="skeleton-card"></div><div class="skeleton-card"></div>`;
            recentLists.classList.toggle('has-lists', !serverConfirmed);
            return;
        }
        recentLists.classList.add('has-lists');
        // Diff-Rendering: vorhandene Karten wiederverwenden
        const existing = new Map([...listsContainer.querySelectorAll('.list-card')].map(el => [el.dataset.listId, el]));
        listsContainer.querySelectorAll('.skeleton-card').forEach(el => el.remove());
        visible.forEach((list, index) => {
            const sig = `${list.name}|${list.productCount}|${tsMillis(list.createdAt)}`;
            let card = existing.get(list.id);
            if (!card) {
                card = document.createElement('div');
                card.className = 'list-card';
                card.dataset.listId = list.id;
                card.innerHTML = `
                    <button class="list-card-open" type="button">
                        <span class="list-card-info"><h3></h3><span class="list-card-meta"></span></span>
                        <span class="list-card-arrow" aria-hidden="true">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </span>
                    </button>
                    <button class="list-card-more" type="button" aria-label="Mehr Optionen">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                    </button>`;
            }
            existing.delete(list.id);
            if (card.dataset.sig !== sig) {
                card.dataset.sig = sig;
                card.querySelector('h3').textContent = list.name || 'Einkaufsliste';
                card.querySelector('.list-card-meta').textContent = `${countLabel(list)}${formatDate(list.createdAt)}`;
                card.querySelector('.list-card-open').setAttribute('aria-label', `Liste ${list.name} öffnen`);
                card.querySelector('.list-card-more').setAttribute('aria-label', `Optionen für ${list.name}`);
            }
            if (listsContainer.children[index] !== card) listsContainer.insertBefore(card, listsContainer.children[index] || null);
        });
        existing.forEach(el => el.remove());
    }

    listsContainer.addEventListener('click', (e) => {
        const card = e.target.closest('.list-card');
        if (!card) return;
        if (e.target.closest('.list-card-more')) {
            menuListId = card.dataset.listId;
            const list = allLists.find(l => l.id === menuListId);
            document.getElementById('listMenuTitle').textContent = list?.name || 'Liste';
            showModal('listMenuModal');
            return;
        }
        openList(card.dataset.listId);
    });

    function applyLists(lists, confirmed) {
        allLists = lists;
        AppState.lists = lists
            .filter(l => !l.deletedAt)
            .sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
        if (confirmed) serverConfirmed = true;
        renderRecentLists();
    }

    // Sofort-Anzeige aus dem letzten guten Stand
    const mirrored = Mirror.get('lists_' + currentFamilyId);
    if (mirrored?.length) applyLists(mirrored, false);
    else renderRecentLists();

    liveListen('Listen', query(collection(db, "lists"), where("familyId", "==", currentFamilyId)), (snap) => {
        const lists = snap.docs.map(docData);
        const fromCache = snap.metadata.fromCache;
        // Leerer Cache-Stand ersetzt nie eine bereits angezeigte Übersicht
        if (fromCache && lists.length === 0 && allLists.length > 0) return;
        applyLists(lists, !fromCache);
        setSyncHint(homeStatus, fromCache);
        if (!fromCache || lists.length) {
            Mirror.set('lists_' + currentFamilyId, lists.map(l => ({
                ...l, createdAt: tsMillis(l.createdAt), deletedAt: tsMillis(l.deletedAt) || null
            })));
        }
    });

    // ── Listen-Menü (⋯ auf der Karte) ──────────────────────────────
    document.getElementById('listMenuOpen')?.addEventListener('click', () => {
        hideModal('listMenuModal');
        if (menuListId) openList(menuListId);
    });
    document.getElementById('listMenuRename')?.addEventListener('click', () => {
        hideModal('listMenuModal');
        const list = allLists.find(l => l.id === menuListId);
        document.getElementById('homeRenameInput').value = list?.name || '';
        showModal('homeRenameModal');
    });
    document.getElementById('homeRenameCancel')?.addEventListener('click', () => hideModal('homeRenameModal'));
    document.getElementById('homeRenameConfirm')?.addEventListener('click', () => {
        const name = document.getElementById('homeRenameInput').value.trim();
        if (menuListId && name) AppState.renameList(menuListId, name);
        hideModal('homeRenameModal');
    });
    document.getElementById('homeRenameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('homeRenameConfirm').click();
    });
    document.getElementById('listMenuDelete')?.addEventListener('click', async () => {
        hideModal('listMenuModal');
        const list = allLists.find(l => l.id === menuListId);
        if (!list) return;
        const count = typeof list.productCount === 'number' ? list.productCount : null;
        const ok = await askConfirm({
            title: 'Liste löschen?',
            message: `„${list.name}“${count !== null ? ` mit ${count} Produkten` : ''} kommt in den Papierkorb und kann ${LIST_TRASH_DAYS} Tage lang wiederhergestellt werden.`,
            confirmText: 'In den Papierkorb'
        });
        if (!ok) return;
        AppState.deleteList(list.id);
        showUndo(`„${list.name}“ gelöscht`, () => AppState.restoreList(list.id));
    });
    document.getElementById('listMenuCancel')?.addEventListener('click', () => hideModal('listMenuModal'));

    // ── Mehr-Menü (Papierkorb, Sicherung) ──────────────────────────
    document.getElementById('homeMoreBtn')?.addEventListener('click', () => showModal('homeMenuModal'));
    document.getElementById('homeMenuCancel')?.addEventListener('click', () => hideModal('homeMenuModal'));
    document.getElementById('homeMenuBackup')?.addEventListener('click', () => { hideModal('homeMenuModal'); runBackupDownload(); });
    document.getElementById('homeMenuImport')?.addEventListener('click', () => { hideModal('homeMenuModal'); runBackupImport(); });
    document.getElementById('homeMenuLogout')?.addEventListener('click', () => { hideModal('homeMenuModal'); logout(); });
    document.getElementById('homeMenuTrash')?.addEventListener('click', () => {
        hideModal('homeMenuModal');
        renderListTrash();
        showModal('listTrashModal');
    });
    document.getElementById('closeListTrash')?.addEventListener('click', () => hideModal('listTrashModal'));

    function renderListTrash() {
        const body = document.getElementById('listTrashBody');
        const cutoff = Date.now() - LIST_TRASH_DAYS * 86400000;
        const items = allLists
            .filter(l => l.deletedAt && tsMillis(l.deletedAt) > cutoff)
            .sort((a, b) => tsMillis(b.deletedAt) - tsMillis(a.deletedAt));
        if (!items.length) {
            body.innerHTML = `<div class="deleted-empty-state">Der Papierkorb ist leer</div>`;
            return;
        }
        body.innerHTML = `<div class="deleted-product-list">${items.map(l => `
            <div class="deleted-product-item">
                <div class="deleted-product-item-info">
                    <span class="deleted-product-item-name">${escapeHtml(l.name)}</span>
                    <span class="deleted-product-item-meta">${typeof l.productCount === 'number' ? l.productCount + ' Produkte · ' : ''}gelöscht ${formatAgo(tsMillis(l.deletedAt))}</span>
                </div>
                <button class="restore-btn" data-list-id="${l.id}">Wiederherstellen</button>
            </div>`).join('')}</div>`;
    }
    document.getElementById('listTrashBody')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.restore-btn');
        if (!btn) return;
        AppState.restoreList(btn.dataset.listId);
        btn.closest('.deleted-product-item').remove();
        showToast('Liste ist wieder da');
        if (!document.querySelector('#listTrashBody .deleted-product-item')) renderListTrash();
    });

    // Liste wurde auf der Listenseite gelöscht → hier Rückgängig anbieten
    const justDeleted = sessionStorage.getItem('undoListDelete');
    if (justDeleted) {
        sessionStorage.removeItem('undoListDelete');
        try {
            const { id, name } = JSON.parse(justDeleted);
            showUndo(`„${name}“ gelöscht`, () => AppState.restoreList(id));
        } catch (e) {}
    }

    // ── Konto teilen ──────────────────────────────────────────────
    function buildShareMessage(password) {
        const uname = currentUsername || currentUser?.username || '';
        const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
        const appUrl = base + 'auth.html';
        const pw = password || '••••••';
        return `Ich lade dich zu meiner Einkaufsliste ein! 🛒\n\nÖffne den Link und gib diese Daten ein:\n👤 Benutzername: ${uname}\n🔑 Passwort: ${pw}\n\n🔗 ${appUrl}`;
    }

    document.getElementById('shareAccountBtn')?.addEventListener('click', () => {
        document.getElementById('sharePasswordInput').value = '';
        document.getElementById('sharePasswordError').style.display = 'none';
        document.getElementById('sharePreviewText').textContent = buildShareMessage('');
        showModal('shareAccountModal');
    });

    document.getElementById('sharePasswordInput')?.addEventListener('input', () => {
        const pw = document.getElementById('sharePasswordInput').value;
        document.getElementById('sharePreviewText').textContent = buildShareMessage(pw);
        document.getElementById('sharePasswordError').style.display = 'none';
    });

    document.getElementById('closeShareAccount')?.addEventListener('click', () => hideModal('shareAccountModal'));

    document.getElementById('doShareAccount')?.addEventListener('click', async () => {
        const pw = document.getElementById('sharePasswordInput').value;
        if (!pw) {
            document.getElementById('sharePasswordError').style.display = 'block';
            document.getElementById('sharePasswordInput').focus();
            return;
        }
        const message = buildShareMessage(pw);
        const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
        const appUrl = base + 'auth.html';

        if (navigator.share) {
            try {
                await navigator.share({ title: 'Einkaufsliste – Einladung', text: message, url: appUrl });
                hideModal('shareAccountModal');
            } catch (_) { /* Nutzer hat Teilen abgebrochen */ }
        } else {
            try { await navigator.clipboard.writeText(message); }
            catch (_) {
                const ta = document.createElement('textarea');
                ta.value = message; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
            }
            const btn = document.getElementById('doShareAccount');
            const orig = btn.innerHTML;
            btn.innerHTML = '✓ Kopiert!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
        }
    });

    document.getElementById('newListBtn').addEventListener('click', () => {
        listNameInput.value = '';
        showModal('newListModal');
    });

    document.getElementById('cancelNewList').addEventListener('click', () => hideModal('newListModal'));

    document.getElementById('confirmNewList').addEventListener('click', async () => {
        const name = listNameInput.value.trim() || 'Einkaufsliste';
        const { id, saved } = AppState.createList(name);
        hideModal('newListModal');
        // Kurz warten, bis der Server die neue Liste hat (offline höchstens 2 s)
        await Promise.race([saved, new Promise(r => setTimeout(r, 2000))]);
        window.location.href = `shopping-list.html?list=${encodeURIComponent(id)}&new=1`;
    });

    listNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmNewList').click();
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hideAllModals();
        });
    });
}

// ===== LISTENSEITE =====
if (isListPage) {
    let selectedCategory = 'sonstiges';
    let userManuallySelectedCategory = false;
    let currentListId = null;
    let allProducts = [];        // inkl. Papierkorb
    let currentProducts = [];    // nur aktive
    let serverConfirmed = false; // mindestens ein Stand direkt vom Server
    let pendingImageBase64 = null;

    const listTitle = document.getElementById('listTitle');
    const productInput = document.getElementById('productInput');
    const productsContainer = document.getElementById('productsContainer');
    const emptyState = document.getElementById('emptyState');
    const syncHint = document.getElementById('syncHint');
    const fileInput = document.getElementById('fileInput');
    const cameraInput = document.getElementById('cameraInput');
    const categorySelector = document.getElementById('categorySelector');

    attachDebugTrigger(listTitle);

    // ===== KATEGORIE CHIPS RENDERN =====
    function renderCategoryChips() {
        const cats = AppState.getCategories();
        if (!cats.find(c => c.id === selectedCategory)) {
            selectedCategory = 'sonstiges';
        }
        categorySelector.innerHTML = cats.map(cat => `
            <button class="category-chip ${cat.id === selectedCategory ? 'active' : ''}" data-category="${cat.id}">
                ${cat.emoji} ${escapeHtml(cat.name)}
            </button>
        `).join('');
    }

    categorySelector.addEventListener('click', (e) => {
        const chip = e.target.closest('.category-chip');
        if (!chip) return;
        categorySelector.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectedCategory = chip.dataset.category;
        userManuallySelectedCategory = true;
    });

    // ===== PAPIERKORB (ZULETZT GELÖSCHT, 7 TAGE) =====
    function trashItems() {
        const cutoff = Date.now() - PRODUCT_TRASH_DAYS * 86400000;
        return allProducts
            .filter(p => p.deletedAt && tsMillis(p.deletedAt) > cutoff)
            .sort((a, b) => tsMillis(b.deletedAt) - tsMillis(a.deletedAt));
    }

    function renderRecentlyDeleted() {
        const body = document.getElementById('recentlyDeletedBody');
        const items = trashItems();
        if (items.length === 0) {
            body.innerHTML = `<div class="deleted-empty-state">Keine gelöschten Produkte der letzten ${PRODUCT_TRASH_DAYS} Tage</div>`;
            return;
        }
        const rows = items.map(item => {
            const catInfo = AppState.getCategoryInfo(item.category || 'sonstiges');
            return `<div class="deleted-product-item">
                <div class="deleted-product-item-info">
                    <span class="deleted-product-item-name">${escapeHtml(item.name)}</span>
                    <span class="deleted-product-item-meta">${catInfo.emoji} ${escapeHtml(catInfo.name)} · ${formatAgo(tsMillis(item.deletedAt))}</span>
                </div>
                <button class="restore-btn" data-product-id="${item.id}">Wiederherstellen</button>
            </div>`;
        }).join('');
        body.innerHTML = `<div class="deleted-product-list">${rows}</div>`;
    }

    document.getElementById('recentlyDeletedBody').addEventListener('click', (e) => {
        const btn = e.target.closest('.restore-btn');
        if (!btn) return;
        AppState.restoreProducts(currentListId, [btn.dataset.productId]);
        btn.closest('.deleted-product-item').remove();
        if (!document.querySelector('#recentlyDeletedBody .deleted-product-item')) renderRecentlyDeleted();
    });

    // ===== KATEGORIEN BEARBEITEN MODAL =====
    function renderEditCategories() {
        const listEl = document.getElementById('categoriesList');

        // Standard-Kategorien
        const defaultHtml = DEFAULT_CATEGORIES.map(cat => {
            const isHidden = AppState.hiddenDefaultCategories.includes(cat.id);
            return `
                <div class="cat-edit-row">
                    <span class="cat-edit-name ${isHidden ? 'is-hidden' : ''}">${cat.emoji} ${cat.name}</span>
                    <button class="cat-edit-btn ${isHidden ? 'show' : 'hide'}" data-act="toggle" data-cat-id="${cat.id}" data-hidden="${isHidden}">
                        ${isHidden ? 'Einblenden' : 'Ausblenden'}
                    </button>
                </div>
            `;
        }).join('');

        // Eigene Kategorien
        const customHtml = AppState.customCategories.length > 0
            ? `<div class="cat-edit-section">Eigene Kategorien</div>`
            + AppState.customCategories.map(cat => `
                <div class="cat-edit-row">
                    <span class="cat-edit-name">${cat.emoji} ${escapeHtml(cat.name)}</span>
                    <button class="cat-edit-btn hide" data-act="delete" data-cat-id="${cat.id}">Löschen</button>
                </div>
            `).join('')
            : '';

        listEl.innerHTML = `
            <div class="cat-edit-section">Standard-Kategorien</div>
            ${defaultHtml}
            ${customHtml}
        `;
    }

    document.getElementById('categoriesList').addEventListener('click', (e) => {
        const btn = e.target.closest('.cat-edit-btn');
        if (!btn) return;
        const catId = btn.dataset.catId;
        if (btn.dataset.act === 'toggle') {
            if (btn.dataset.hidden === 'true') {
                AppState.showDefaultCategory(currentListId, catId);
            } else {
                AppState.hideDefaultCategory(currentListId, catId);
                if (selectedCategory === catId) selectedCategory = 'sonstiges';
            }
        } else {
            AppState.deleteCustomCategory(currentListId, catId);
            if (selectedCategory === catId) selectedCategory = 'sonstiges';
        }
        renderCategoryChips();
        renderEditCategories();
        renderList();
    });

    // ===== LISTE RENDERN (Diff: nur Geändertes anfassen) =====
    function setTitle() {
        const name = AppState.activeList?.name || 'Einkaufsliste';
        if (listTitle.textContent !== name) listTitle.textContent = name;
        document.title = name + ' - Einkaufsliste';
    }

    function productRowHtml() {
        return `
            <span class="checkbox pcheck" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            <span class="product-name pname"></span>
            <span class="product-qty"></span>
            <button class="photo-link-btn photo-thumb" type="button" hidden aria-label="Foto ansehen">
                <img alt="" hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>`;
    }

    function renderSkeleton() {
        productsContainer.innerHTML = `
            <div class="skeleton-group" aria-label="Liste wird geladen">
                <div class="skeleton-line short"></div>
                <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
            </div>`;
        emptyState.classList.remove('visible');
    }

    function renderList() {
        setTitle();
        const products = currentProducts;
        productsContainer.querySelectorAll('.skeleton-group').forEach(el => el.remove());

        if (products.length === 0) {
            productsContainer.querySelectorAll('.category-section').forEach(el => el.remove());
            // „Leer“ nur, wenn der Server es bestätigt hat – sonst Ladeanzeige
            if (serverConfirmed) emptyState.classList.add('visible');
            else { emptyState.classList.remove('visible'); renderSkeleton(); }
            updateProgress();
            return;
        }
        emptyState.classList.remove('visible');

        const allCats = [...DEFAULT_CATEGORIES, ...AppState.customCategories];
        const order = allCats.map(c => c.id);
        const grouped = {};
        products.forEach(p => {
            const cat = (p.category && order.includes(p.category)) ? p.category : 'sonstiges';
            (grouped[cat] = grouped[cat] || []).push(p);
        });

        const sections = new Map([...productsContainer.querySelectorAll('.category-section')].map(el => [el.dataset.cat, el]));
        const rows = new Map([...productsContainer.querySelectorAll('.product-item')].map(el => [el.dataset.productId, el]));
        let sectionIndex = 0;

        order.forEach(catKey => {
            const items = grouped[catKey];
            if (!items?.length) return;
            let section = sections.get(catKey);
            if (!section) {
                section = document.createElement('div');
                section.className = 'category-section';
                section.dataset.cat = catKey;
                section.innerHTML = `<div class="category-header group-head"><h3></h3><span class="count"></span></div><div class="products-list"></div>`;
            }
            sections.delete(catKey);
            const info = AppState.getCategoryInfo(catKey);
            section.querySelector('h3').textContent = info.name;
            section.querySelector('.count').textContent = items.length;
            if (productsContainer.children[sectionIndex] !== section) {
                productsContainer.insertBefore(section, productsContainer.children[sectionIndex] || null);
            }
            sectionIndex++;

            const listEl = section.querySelector('.products-list');
            items.forEach((p, i) => {
                let row = rows.get(p.id);
                if (!row) {
                    row = document.createElement('div');
                    row.className = 'product-item pitem';
                    row.dataset.productId = p.id;
                    row.setAttribute('role', 'button');
                    row.setAttribute('tabindex', '0');
                    row.setAttribute('aria-pressed', 'false');
                    row.innerHTML = productRowHtml();
                }
                rows.delete(p.id);
                const hasImage = !!(p.hasImage || p.imageUrl);
                const sig = `${p.name}|${p.qty || ''}|${hasImage}`;
                if (row.dataset.sig !== sig) {
                    row.dataset.sig = sig;
                    row.querySelector('.pname').textContent = p.name;
                    row.querySelector('.product-qty').textContent = p.qty || '';
                    row.querySelector('.photo-link-btn').hidden = !hasImage;
                    row.setAttribute('aria-label', `${p.name}${p.qty ? ' ' + p.qty : ''} abhaken`);
                }
                if (hasImage) loadThumb(row, p);
                if (listEl.children[i] !== row) listEl.insertBefore(row, listEl.children[i] || null);
            });
        });

        sections.forEach(el => el.remove());
        // Zeilen, die gerade abgehakt animiert werden, dürfen zu Ende laufen
        rows.forEach(el => { if (!el.classList.contains('checking')) el.remove(); });
        updateProgress();
    }

    // Vorschaubild in der Zeile nachladen (einmal pro Produkt, danach aus dem Zwischenspeicher)
    function loadThumb(row, product) {
        const img = row.querySelector('.photo-thumb img');
        const marker = product.id + '|' + (product.photoKey || '') + '|' + (product.photoListId || '');
        if (!img || img.dataset.for === marker) return;
        img.dataset.for = marker;
        AppState.loadImage(currentListId, product).then((src) => {
            if (!src) { img.dataset.for = ''; return; }
            img.src = src;
            img.hidden = false;
            row.querySelector('.photo-thumb svg')?.setAttribute('hidden', '');
        });
    }

    // Einmal am Tag: Produkte ohne Foto bekommen ihr früheres Foto aus dem Gedächtnis zurück
    let photosRestored = false;
    function restoreRememberedPhotos() {
        if (photosRestored) return;
        photosRestored = true;
        const today = new Date().toISOString().slice(0, 10);
        const flag = 'photos_checked_' + currentListId;
        if (localStorage.getItem(flag) === today) return;
        localStorage.setItem(flag, today);
        currentProducts
            .filter(p => !p.hasImage && !p.imageUrl)
            .slice(0, 40)
            .forEach(p => AppState.attachRememberedPhoto(currentListId, p.id, p.name, { onlyThisList: true }));
    }

    function updateProgress() {
        const label = document.getElementById('progressLabel');
        if (label) label.textContent = currentProducts.length ? `${currentProducts.length} offen` : '';
    }

    // ===== ABHAKEN + FOTO (Event-Delegation) =====
    function checkOff(row) {
        if (row.classList.contains('checking')) return;
        const id = row.dataset.productId;
        const product = currentProducts.find(p => p.id === id);
        row.classList.remove('pop');
        void row.offsetWidth;
        row.classList.add('checking', 'pop');
        row.setAttribute('aria-pressed', 'true');
        setTimeout(() => {
            row.classList.add('checked');
            setTimeout(() => {
                AppState.removeProducts(currentListId, [id], 'abgehakt');
                setTimeout(() => row.remove(), 50);
                if (product) showUndo(`„${product.name}“ abgehakt`, () => AppState.restoreProducts(currentListId, [id]));
            }, 300);
        }, 450);
    }

    productsContainer.addEventListener('click', async (e) => {
        const photoBtn = e.target.closest('.photo-link-btn');
        const row = e.target.closest('.product-item');
        if (!row) return;
        if (photoBtn) {
            e.stopPropagation();
            const product = allProducts.find(p => p.id === row.dataset.productId);
            if (!product) return;
            const img = document.getElementById('photoViewImg');
            img.removeAttribute('src');
            document.getElementById('photoViewTitle').textContent = product.name;
            showModal('photoViewModal');
            const src = await AppState.loadImage(currentListId, product);
            if (src) img.src = src;
            else showToast('Foto ist offline nicht verfügbar');
            return;
        }
        checkOff(row);
    });

    productsContainer.addEventListener('keydown', (e) => {
        const row = e.target.closest('.product-item');
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); checkOff(row); }
    });

    // ===== PRODUKT HINZUFÜGEN =====
    // Gleicher Name schon auf der Liste → nicht doppelt anlegen
    function findActiveByName(name) {
        const n = name.trim().toLocaleLowerCase('de');
        return currentProducts.find(p => (p.name || '').trim().toLocaleLowerCase('de') === n);
    }

    function addProduct() {
        const name = productInput.value.trim();
        if (!name || !currentListId) return;
        if (findActiveByName(name)) {
            showToast(`„${name}“ steht schon auf der Liste`);
        } else {
            AppState.addProduct(currentListId, name, selectedCategory);
        }
        productInput.value = '';
        productInput.focus();
        userManuallySelectedCategory = false;
    }

    function applyDetectedCategory(catId) {
        if (userManuallySelectedCategory) return;
        const visibleCats = AppState.getCategories();
        if (!visibleCats.find(c => c.id === catId)) return;
        categorySelector.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
        const chip = categorySelector.querySelector(`.category-chip[data-category="${catId}"]`);
        if (chip) { chip.classList.add('active'); selectedCategory = catId; }
    }

    let categorySearchTimeout = null;

    productInput.addEventListener('input', () => {
        const name = productInput.value.trim();
        if (name.length < 2) {
            clearTimeout(categorySearchTimeout);
            if (name.length === 0) userManuallySelectedCategory = false;
            return;
        }

        // Sofortige lokale Erkennung
        const detected = detectCategory(name);
        if (detected !== 'sonstiges') applyDetectedCategory(detected);

        // Asynchrone Suche via Open Food Facts (mit Debounce, 700ms)
        // liefert bessere Ergebnisse für eigene Kategorien wie "Getränke"
        clearTimeout(categorySearchTimeout);
        if (name.length >= 3) {
            categorySearchTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(name)}&search_simple=1&action=process&json=1&page_size=1&fields=categories_tags`);
                    const data = await res.json();
                    const tags = data.products?.[0]?.categories_tags;
                    if (tags && productInput.value.trim() === name) {
                        const cat = detectCategoryWithOFF(name, tags);
                        if (cat && cat !== 'sonstiges') applyDetectedCategory(cat);
                    }
                } catch (e) {}
            }, 700);
        }
    });

    // ===== DATEN ABONNIEREN =====
    function applyProducts(products, { fromCache, pending }) {
        const active = products
            .filter(p => !p.deletedAt)
            .sort((a, b) => tsMillis(a.addedAt) - tsMillis(b.addedAt));
        // Letzten guten Stand behalten: ein leerer Cache-Stand leert nie die Anzeige
        if (fromCache && active.length === 0 && currentProducts.length > 0) {
            setSyncHint(syncHint, true);
            return;
        }
        allProducts = products;
        currentProducts = active;
        if (!fromCache) { serverConfirmed = true; restoreRememberedPhotos(); }
        setSyncHint(syncHint, fromCache);
        renderList();

        if (!fromCache || active.length) {
            Mirror.set('products_' + currentListId, products.filter(p => !p.deletedAt || trashItems().includes(p)).map(stripForMirror));
            if (AppState.activeList) DeviceBackup.saveList(AppState.activeList, active);
        }
        // Zähler am Listen-Dokument selbst reparieren (nur mit bestätigtem Server-Stand)
        if (!fromCache && !pending && AppState.activeList && AppState.activeList.productCount !== active.length) {
            AppState.activeList.productCount = active.length;
            updateDoc(doc(db, "lists", currentListId), { productCount: active.length })
                .catch(e => Debug.log('Zähler', e));
        }
    }

    function subscribeToList(listId) {
        // Sofort-Anzeige aus dem letzten guten Stand
        const mirroredList = (Mirror.get('lists_' + currentFamilyId) || []).find(l => l.id === listId);
        if (mirroredList) AppState.activeList = mirroredList;
        const mirroredProducts = Mirror.get('products_' + listId);
        if (mirroredProducts?.length) {
            allProducts = mirroredProducts;
            currentProducts = mirroredProducts.filter(p => !p.deletedAt).sort((a, b) => tsMillis(a.addedAt) - tsMillis(b.addedAt));
            setSyncHint(syncHint, true);
            renderList();
        } else {
            setTitle();
            renderSkeleton();
        }

        liveListen('Liste', doc(db, "lists", listId), (snap) => {
            if (!snap.exists()) {
                // Nur nach Server-Bestätigung zurück zur Übersicht (neue Listen sind offline schon da)
                if (!snap.metadata.fromCache && !new URLSearchParams(location.search).has('new')) window.location.href = 'index.html';
                return;
            }
            const data = docData(snap);
            if (data.familyId && data.familyId !== currentFamilyId) { window.location.href = 'index.html'; return; }
            if (data.deletedAt && !snap.metadata.hasPendingWrites) {
                window.location.href = 'index.html';
                return;
            }
            AppState.activeList = data;
            setTitle();
        });

        // Produkte SOFORT abonnieren – Kategorien laufen parallel
        liveListen('Produkte', collection(db, "lists", listId, "products"), (snap) => {
            applyProducts(snap.docs.map(docData), {
                fromCache: snap.metadata.fromCache,
                pending: snap.metadata.hasPendingWrites
            });
        });

        liveListen('Kategorien', collection(db, "lists", listId, "categories"), (snap) => {
            AppState.customCategories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderCategoryChips();
            renderList();
        });
        liveListen('Ausgeblendet', collection(db, "lists", listId, "hiddenCategories"), (snap) => {
            AppState.hiddenDefaultCategories = snap.docs.map(d => d.id);
            renderCategoryChips();
        });
    }

    const urlParams = new URLSearchParams(window.location.search);
    const listParam = urlParams.get('list');

    if (listParam) {
        currentListId = listParam;
        AppState.setActiveList(listParam);
    } else if (AppState.activeListId) {
        currentListId = AppState.activeListId;
    } else {
        window.location.href = 'index.html';
    }

    if (currentListId) {
        renderCategoryChips();
        subscribeToList(currentListId);
    }

    // ===== SPRACHEINGABE =====
    initVoice({
        getListId: () => currentListId,
        getProducts: () => currentProducts,
        getCategories: () => AppState.getCategories(),
        getKnownNames: () => [...new Set(allProducts.map(p => p.name).filter(Boolean))].slice(-150),
        getFamilyId: () => currentFamilyId,
        detectCategory,
        addProduct: (name, category, qty) => AppState.addProduct(currentListId, name, category || 'sonstiges', null, { qty, source: 'sprache' }),
        updateProduct: (id, fields) => AppState.updateProduct(currentListId, id, fields),
        removeProducts: (ids) => AppState.removeProducts(currentListId, ids, 'sprache'),
        restoreProducts: (ids) => AppState.restoreProducts(currentListId, ids),
        showUndo,
        showToast,
        askConfirm,
        getIdToken,
        log: (label, e) => Debug.log(label, e)
    });

    document.getElementById('addProductBtn').addEventListener('click', addProduct);
    productInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addProduct(); });
    document.getElementById('backBtn').addEventListener('click', () => { window.location.href = 'index.html'; });
    document.getElementById('menuBtn').addEventListener('click', () => showModal('menuModal'));
    document.getElementById('cancelMenu').addEventListener('click', () => hideModal('menuModal'));

    document.getElementById('logoutAction').addEventListener('click', () => {
        hideModal('menuModal');
        localStorage.removeItem('auth_session');
        window.location.href = 'auth.html';
    });

    document.getElementById('editCategoriesAction').addEventListener('click', () => {
        hideModal('menuModal');
        renderEditCategories();
        showModal('editCategoriesModal');
    });

    document.getElementById('categoryEditBtn').addEventListener('click', () => {
        renderEditCategories();
        showModal('editCategoriesModal');
    });

    document.getElementById('recentlyDeletedAction').addEventListener('click', () => {
        hideModal('menuModal');
        renderRecentlyDeleted();
        showModal('recentlyDeletedModal');
    });

    document.getElementById('closeRecentlyDeleted').addEventListener('click', () => {
        hideModal('recentlyDeletedModal');
    });

    document.getElementById('backupAction')?.addEventListener('click', () => { hideModal('menuModal'); runBackupDownload(); });

    document.getElementById('addCategoryBtn').addEventListener('click', () => {
        const input = document.getElementById('newCategoryName');
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        AppState.addCustomCategory(currentListId, name, '🏷️');
        input.value = '';
        renderCategoryChips();
        renderEditCategories();
    });

    document.getElementById('newCategoryName').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('addCategoryBtn').click();
    });

    document.getElementById('closeEditCategories').addEventListener('click', () => hideModal('editCategoriesModal'));

    document.getElementById('cameraBtn').addEventListener('click', () => {
        const existingName = productInput.value.trim();
        if (existingName) document.getElementById('imageProductName').value = existingName;
        showModal('cameraModal');
    });

    document.getElementById('cancelCamera').addEventListener('click', () => hideModal('cameraModal'));
    document.getElementById('galleryAction').addEventListener('click', () => { hideModal('cameraModal'); fileInput.click(); });
    document.getElementById('photoAction').addEventListener('click', () => { hideModal('cameraModal'); cameraInput.click(); });

    // ===== BARCODE SCANNER =====
    // ZXing (~300 kB) nur nachladen, wenn der native BarcodeDetector fehlt
    // und tatsächlich gescannt wird – spart Bandbreite beim Seitenstart.
    let zxingLoadPromise = null;
    function loadZXing() {
        if (typeof ZXing !== 'undefined') return Promise.resolve();
        if (!zxingLoadPromise) {
            zxingLoadPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://unpkg.com/@zxing/library@0.18.6/umd/index.min.js';
                s.onload = resolve;
                s.onerror = () => { zxingLoadPromise = null; reject(new Error('ZXing konnte nicht geladen werden')); };
                document.head.appendChild(s);
            });
        }
        return zxingLoadPromise;
    }

    let zxingReader = null;
    let scannerStream = null;
    let scannerAnimFrame = null;
    let scannerActive = false;

    function setScannerStatus(text) {
        const el = document.getElementById('barcodeStatus');
        if (el) el.textContent = text;
    }

    async function startBarcodeScanner() {
        hideModal('cameraModal');
        showModal('barcodeModal');
        document.getElementById('barcodeModal').classList.remove('fallback-mode');
        setScannerStatus('Kamera wird gestartet…');
        scannerActive = true;
        if ('BarcodeDetector' in window) {
            await startNativeScanner();
        } else {
            await startFallbackScanner();
        }
    }

    async function startNativeScanner() {
        const video = document.getElementById('scannerVideo');
        try {
            let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
            try {
                const supported = await BarcodeDetector.getSupportedFormats();
                formats = formats.filter(f => supported.includes(f));
            } catch (e) {}
            const detector = new BarcodeDetector({ formats: formats.length ? formats : ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
            scannerStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
            });
            video.srcObject = scannerStream;
            await new Promise(resolve => { video.onloadedmetadata = resolve; });
            await video.play();
            setScannerStatus('Halte den Barcode in den Rahmen');
            const detect = async () => {
                if (!scannerActive) return;
                try {
                    if (video.readyState >= 2) {
                        const codes = await detector.detect(video);
                        if (codes.length > 0) {
                            if (navigator.vibrate) navigator.vibrate(60);
                            const code = codes[0].rawValue;
                            await stopBarcodeScanner();
                            hideModal('barcodeModal');
                            productInput.placeholder = 'Produkt wird gesucht…';
                            await lookupBarcode(code);
                            productInput.placeholder = 'Produkt tippen oder scannen…';
                            return;
                        }
                    }
                } catch (e) {}
                scannerAnimFrame = requestAnimationFrame(detect);
            };
            scannerAnimFrame = requestAnimationFrame(detect);
        } catch (err) {
            setScannerStatus('Kamera konnte nicht gestartet werden.');
        }
    }

    async function startFallbackScanner() {
        const video = document.getElementById('scannerVideo');
        if (typeof ZXing === 'undefined') {
            setScannerStatus('Scanner wird geladen…');
            try {
                await loadZXing();
            } catch (e) {
                setScannerStatus('Scanner nicht verfügbar. Bitte Internetverbindung prüfen.');
                return;
            }
            if (!scannerActive) return;
            setScannerStatus('Kamera wird gestartet…');
        }
        try {
            zxingReader = new ZXing.BrowserMultiFormatReader();
            await zxingReader.decodeFromConstraints(
                { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
                video,
                async (result, err) => {
                    if (!scannerActive || !result) return;
                    const code = result.getText();
                    scannerActive = false;
                    if (navigator.vibrate) navigator.vibrate(60);
                    await stopBarcodeScanner();
                    hideModal('barcodeModal');
                    productInput.placeholder = 'Produkt wird gesucht…';
                    await lookupBarcode(code);
                    productInput.placeholder = 'Produkt tippen oder scannen…';
                }
            );
            setScannerStatus('Halte den Barcode in den Rahmen');
        } catch (err) {
            setScannerStatus('Kamera konnte nicht gestartet werden.');
        }
    }

    async function stopBarcodeScanner() {
        scannerActive = false;
        if (scannerAnimFrame) { cancelAnimationFrame(scannerAnimFrame); scannerAnimFrame = null; }
        if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
        const video = document.getElementById('scannerVideo');
        if (video) video.srcObject = null;
        if (zxingReader) {
            try { zxingReader.reset(); } catch (e) {}
            zxingReader = null;
        }
        document.getElementById('barcodeModal').classList.remove('fallback-mode');
    }

    const BARCODE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

    function getCachedBarcode(barcode) {
        try {
            const raw = localStorage.getItem('bc_' + barcode);
            if (!raw) return null;
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts > BARCODE_CACHE_TTL) { localStorage.removeItem('bc_' + barcode); return null; }
            return data;
        } catch { return null; }
    }

    function setCachedBarcode(barcode, product) {
        try { localStorage.setItem('bc_' + barcode, JSON.stringify({ data: product, ts: Date.now() })); } catch {}
    }

    async function lookupBarcode(barcode) {
        let found = getCachedBarcode(barcode);
        if (!found) {
            // Alle 4 Open-Datenbanken parallel anfragen:
            // Open Food Facts (~3.2M), Open Beauty Facts (~200k),
            // Open Products Facts (~400k), Open Pet Food Facts (~100k)
            const fields = 'product_name,product_name_de,image_front_url,categories_tags,brands,quantity';
            const sources = [
                `https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=${fields}`,
                `https://world.openbeautyfacts.org/api/v2/product/${barcode}?fields=${fields}`,
                `https://world.openproductsfacts.org/api/v2/product/${barcode}?fields=${fields}`,
                `https://world.openpetfoodfacts.org/api/v2/product/${barcode}?fields=${fields}`,
            ];

            // Bewertet die Vollständigkeit eines Produkteintrags
            const scoreProduct = p => !p ? 0 :
                (p.product_name_de ? 3 : p.product_name ? 1 : 0) +
                ((p.categories_tags?.length ?? 0) > 0 ? 3 : 0) +
                (p.image_front_url ? 1 : 0) +
                (p.brands ? 1 : 0);

            found = await new Promise(resolve => {
                let settled = 0, best = null, done = false, pickTimer = null;
                const total = sources.length;

                const finish = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(pickTimer);
                    resolve(best);
                };

                const onResult = product => {
                    settled++;
                    if (product && scoreProduct(product) > scoreProduct(best)) {
                        best = product;
                        // Bei neuem Bestwert: Timer zurücksetzen und anderen DBs
                        // noch kurz Zeit geben (kürzer wenn Ergebnis bereits gut)
                        clearTimeout(pickTimer);
                        if (settled < total) {
                            const wait = (best.categories_tags?.length ?? 0) > 0 ? 600 : 1200;
                            pickTimer = setTimeout(finish, wait);
                        }
                    }
                    if (settled === total) finish();
                };

                const abortOpt = typeof AbortSignal?.timeout === 'function'
                    ? { signal: AbortSignal.timeout(5000) } : {};

                for (const url of sources) {
                    fetch(url, abortOpt)
                        .then(r => r.json())
                        .then(d => onResult(d.status === 1 && d.product ? d.product : null))
                        .catch(() => onResult(null));
                }

                // Sicherheits-Timeout: nach 7 s auf jeden Fall beenden
                setTimeout(finish, 7000);
            });

            if (found) setCachedBarcode(barcode, found);
        }

        if (found) {
            const name = found.product_name_de || found.product_name || '';
            if (!name) { productInput.focus(); showToast('Kein Name gefunden. Bitte manuell eingeben.'); return; }
            const imageUrl = found.image_front_url || null;
            const detectedCat = detectCategoryWithOFF(name, found.categories_tags);
            selectedCategory = detectedCat;
            await AppState.addProduct(currentListId, name, selectedCategory, imageUrl);
            renderCategoryChips();
            showToast(`"${name}" wurde hinzugefügt`);
        } else {
            productInput.focus();
            showToast('Produkt nicht gefunden. Bitte manuell eingeben.');
        }
    }

    document.getElementById('barcodeScanBtn').addEventListener('click', startBarcodeScanner);
    document.getElementById('cancelBarcode').addEventListener('click', async () => {
        await stopBarcodeScanner();
        hideModal('barcodeModal');
    });
    document.getElementById('barcodeModal').addEventListener('click', async (e) => {
        if (e.target === document.getElementById('barcodeModal')) {
            await stopBarcodeScanner();
            hideModal('barcodeModal');
        }
    });

    async function handleImageSelected(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            // Klein halten: Fotos liegen in Firestore (Spark-Tarif, kein Storage)
            const resized = await resizeImage(e.target.result, 640);
            pendingImageBase64 = resized;
            document.getElementById('previewImg').src = resized;
            showModal('imagePreviewModal');
        };
        reader.readAsDataURL(file);
    }

    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleImageSelected(e.target.files[0]); });
    cameraInput.addEventListener('change', (e) => { if (e.target.files[0]) handleImageSelected(e.target.files[0]); });

    document.getElementById('cancelImagePreview').addEventListener('click', () => {
        hideModal('imagePreviewModal');
        pendingImageBase64 = null;
        fileInput.value = '';
        cameraInput.value = '';
    });

    document.getElementById('confirmImageProduct').addEventListener('click', () => {
        const name = document.getElementById('imageProductName').value.trim();
        if (!name) { document.getElementById('imageProductName').focus(); return; }
        AppState.addProduct(currentListId, name, selectedCategory, pendingImageBase64);
        hideModal('imagePreviewModal');
        pendingImageBase64 = null;
        fileInput.value = '';
        cameraInput.value = '';
        document.getElementById('imageProductName').value = '';
    });

    document.getElementById('imageProductName').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmImageProduct').click();
    });

    document.getElementById('closePhotoView').addEventListener('click', () => hideModal('photoViewModal'));

    document.getElementById('renameListAction').addEventListener('click', () => {
        hideModal('menuModal');
        document.getElementById('renameInput').value = AppState.activeList?.name || '';
        showModal('renameModal');
    });

    document.getElementById('cancelRename').addEventListener('click', () => hideModal('renameModal'));

    document.getElementById('confirmRename').addEventListener('click', () => {
        const newName = document.getElementById('renameInput').value.trim();
        if (currentListId && newName) {
            AppState.renameList(currentListId, newName);
            if (AppState.activeList) AppState.activeList.name = newName;
            setTitle();
        }
        hideModal('renameModal');
    });

    document.getElementById('renameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmRename').click();
    });

    document.getElementById('clearListAction').addEventListener('click', async () => {
        hideModal('menuModal');
        const ids = currentProducts.map(p => p.id);
        const listName = AppState.activeList?.name || 'Einkaufsliste';
        if (!ids.length) { showToast('Die Liste ist schon leer'); return; }
        const ok = await askConfirm({
            title: 'Alle Produkte entfernen?',
            message: `${ids.length} ${ids.length === 1 ? 'Produkt' : 'Produkte'} aus „${listName}“ entfernen? Sie bleiben ${PRODUCT_TRASH_DAYS} Tage unter „Zuletzt gelöscht“.`,
            confirmText: 'Alle entfernen'
        });
        if (!ok) return;
        AppState.removeProducts(currentListId, ids, 'alle-loeschen');
        showUndo(`${ids.length} Produkte entfernt`, () => AppState.restoreProducts(currentListId, ids));
    });

    document.getElementById('deleteListAction').addEventListener('click', async () => {
        hideModal('menuModal');
        const listName = AppState.activeList?.name || 'Einkaufsliste';
        const ok = await askConfirm({
            title: 'Liste löschen?',
            message: `„${listName}“ mit ${currentProducts.length} Produkten kommt in den Papierkorb und kann ${LIST_TRASH_DAYS} Tage lang wiederhergestellt werden.`,
            confirmText: 'In den Papierkorb'
        });
        if (!ok || !currentListId) return;
        AppState.deleteList(currentListId);
        sessionStorage.setItem('undoListDelete', JSON.stringify({ id: currentListId, name: listName }));
        window.location.href = 'index.html';
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hideAllModals();
        });
    });
}

} // end auth check

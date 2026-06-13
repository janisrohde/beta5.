import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    orderBy,
    where,
    serverTimestamp,
    Timestamp,
    enableNetwork
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDN17KahTrjPxIM2BfBSSJxou5y6U6PZHY",
    authDomain: "einkaufsliste-familie-69283.firebaseapp.com",
    projectId: "einkaufsliste-familie-69283",
    storageBucket: "einkaufsliste-familie-69283.firebasestorage.app",
    messagingSenderId: "748125742090",
    appId: "1:748125742090:web:2a03355797d48ae741ebf3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let currentFamilyId = null;
let currentUser = null;
let currentUsername = '';

// ===== GLOBALE KI-KONSTANTEN =====
const GROQ_PROXY = 'https://plain-wind-217b.tillrohde.workers.dev';

// ===== KI-KATEGORISIERUNGS-QUEUE =====
let _catQueue  = [];
let _catTimer  = null;

function queueForAICategory(listId, name, docId) {
    _catQueue.push({ listId, name, docId });
    clearTimeout(_catTimer);
    _catTimer = setTimeout(runAICategorization, 700);
}

async function runAICategorization() {
    if (!_catQueue.length) return;
    const batch = _catQueue.splice(0);
    const categories = AppState.getCategories().filter(c => c.id !== 'sonstiges');
    if (!categories.length) return;

    // Kategorien mit Beispielen für die KI
    const catExamples = {
        'Obst':              'Äpfel, Bananen, Orangen, Erdbeeren, Trauben',
        'Gemüse':            'Tomaten, Karotten, Zwiebeln, Paprika, Gurken, Salat',
        'Milchprodukte':     'Milch, Käse, Joghurt, Butter, Sahne, Quark, Eier',
        'Kosmetik & Pflege': 'Shampoo, Seife, Duschgel, Zahnpasta, Deo, Creme, Parfum, Wattestäbchen',
        'Haushaltsartikel':  'Waschmittel, Spülmittel, Putzmittel, Müllbeutel, Toilettenpapier, Schwämme',
        'Süßigkeiten/Snacks':'Schokolade, Chips, Kekse, Gummibärchen, Bonbons',
        'Fleisch & Wurst':   'Hähnchen, Rind, Schweinefleisch, Salami, Schinken, Hackfleisch',
        'Backwaren':         'Brot, Brötchen, Toastbrot, Mehl, Hefe',
        'Getränke':          'Wasser, Saft, Cola, Bier, Wein, Kaffee, Tee',
        'Tiefkühlprodukte':  'Tiefkühlpizza, Eis, gefrorenes Gemüse',
        'Konserven':         'Tomaten aus der Dose, Bohnen, Thunfisch, Fertigsuppe',
    };
    const catDescriptions = categories.map(c => {
        const ex = catExamples[c.name];
        return ex ? `"${c.name}" (z.B. ${ex})` : `"${c.name}"`;
    }).join('\n');

    const lines = batch.map(b => `"${b.name}"`).join(', ');

    try {
        const res = await fetch(GROQ_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content:
`Du bist ein Kategorisierungs-Experte für Supermarkt-Produkte. Weise jedem Produkt die logisch passendste Kategorie zu. Antworte AUSSCHLIESSLICH mit gültigem JSON, kein Text davor oder danach.` },
                    { role: 'user', content:
`Verfügbare Kategorien:
${catDescriptions}

Produkte zum Kategorisieren: ${lines}

WICHTIG:
- Seife, Duschgel, Shampoo → "Kosmetik & Pflege"
- Waschmittel, Spülmittel, Putzmittel → "Haushaltsartikel"
- Milch, Käse, Joghurt, Eier, Butter → "Milchprodukte"
- Fleisch, Wurst, Fisch → "Fleisch & Wurst"
- Wenn keine passende Kategorie: "Sonstiges"

Antworte NUR mit JSON:
{"Produktname": "exakter Kategoriename"}`
                    }
                ],
                max_tokens: 400,
                temperature: 0
            })
        });
        if (!res.ok) return;
        const data = await res.json();
        const text = (data.choices[0]?.message?.content || '').trim();
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return;
        const result = JSON.parse(m[0]);

        for (const item of batch) {
            const catName = result[item.name];
            if (!catName || catName.toLowerCase() === 'sonstiges') continue;
            // Exakter Match zuerst, dann Teilmatch nur wenn eindeutig
            const cat = categories.find(c => c.name.toLowerCase() === catName.toLowerCase())
                || categories.find(c => c.name.toLowerCase().replace(/[&\/\s]+/g,'').includes(catName.toLowerCase().replace(/[&\/\s]+/g,'')));
            if (!cat) continue;
            try {
                await updateDoc(doc(db, 'lists', item.listId, 'products', item.docId), { category: cat.id });
            } catch(e) {}
        }
    } catch(e) {}
}

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

// ===== APP STATE =====
const AppState = {
    lists: [],
    activeListId: null,
    activeList: null,
    unsubscribeProducts: null,
    customCategories: [],
    hiddenDefaultCategories: [],

    initLocalState() {
        const activeId = localStorage.getItem('activeListId');
        if (activeId) this.activeListId = activeId;
    },

    saveActiveListId() {
        if (this.activeListId) localStorage.setItem('activeListId', this.activeListId);
    },

    setActiveList(id) {
        this.activeListId = id;
        this.saveActiveListId();
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

    async loadCategorySettings(listId) {
        // Eigene Kategorien laden
        try {
            const snap = await getDocs(collection(db, "lists", listId, "categories"));
            this.customCategories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            this.customCategories = [];
        }

        // Ausgeblendete Standard-Kategorien laden
        try {
            const snap = await getDocs(collection(db, "lists", listId, "hiddenCategories"));
            this.hiddenDefaultCategories = snap.docs.map(d => d.id);
        } catch (e) {
            this.hiddenDefaultCategories = [];
        }
    },

    async hideDefaultCategory(listId, catId) {
        await setDoc(doc(db, "lists", listId, "hiddenCategories", catId), { hidden: true });
        if (!this.hiddenDefaultCategories.includes(catId)) {
            this.hiddenDefaultCategories.push(catId);
        }
    },

    async showDefaultCategory(listId, catId) {
        await deleteDoc(doc(db, "lists", listId, "hiddenCategories", catId));
        this.hiddenDefaultCategories = this.hiddenDefaultCategories.filter(id => id !== catId);
    },

    async addCustomCategory(listId, name, emoji) {
        const id = 'custom_' + Date.now();
        const cat = { id, name: name.trim(), emoji: emoji || '🏷️' };
        await setDoc(doc(db, "lists", listId, "categories", id), cat);
        this.customCategories.push(cat);
        return cat;
    },

    async deleteCustomCategory(listId, catId) {
        await deleteDoc(doc(db, "lists", listId, "categories", catId));
        this.customCategories = this.customCategories.filter(c => c.id !== catId);
    },

    async createList(name) {
        const newDocRef = doc(collection(db, "lists"));
        const list = {
            id: newDocRef.id,
            name: name.trim() || "Einkaufsliste",
            familyId: currentFamilyId,
            createdAt: serverTimestamp()
        };
        await setDoc(newDocRef, list);
        this.setActiveList(newDocRef.id);
        return { id: newDocRef.id, ...list };
    },

    async renameList(id, newName) {
        await updateDoc(doc(db, "lists", id), {
            name: newName.trim() || "Einkaufsliste"
        });
    },

    async deleteList(id) {
        try {
            const productsSnapshot = await getDocs(collection(db, "lists", id, "products"));
            for (const p of productsSnapshot.docs) {
                await deleteDoc(doc(db, "lists", id, "products", p.id));
            }
        } catch (e) {}
        try {
            const categoriesSnapshot = await getDocs(collection(db, "lists", id, "categories"));
            for (const c of categoriesSnapshot.docs) {
                await deleteDoc(doc(db, "lists", id, "categories", c.id));
            }
        } catch (e) {}
        try {
            const hiddenSnapshot = await getDocs(collection(db, "lists", id, "hiddenCategories"));
            for (const h of hiddenSnapshot.docs) {
                await deleteDoc(doc(db, "lists", id, "hiddenCategories", h.id));
            }
        } catch (e) {}
        try {
            const deletedSnap = await getDocs(collection(db, "lists", id, "deletedProducts"));
            for (const d of deletedSnap.docs) {
                await deleteDoc(doc(db, "lists", id, "deletedProducts", d.id));
            }
        } catch (e) {}
        await deleteDoc(doc(db, "lists", id));
        this.lists = this.lists.filter(l => l.id !== id);
        if (this.activeListId === id) {
            this.activeListId = null;
            localStorage.removeItem("activeListId");
        }
    },

    async addProduct(listId, name, category, imageUrl = null) {
        if (!name.trim()) return false;
        const autoCategory = category === 'sonstiges' ? detectCategory(name) : category;
        const docRef = await addDoc(collection(db, "lists", listId, "products"), {
            name: name.trim(),
            category: autoCategory,
            checked: false,
            imageUrl: imageUrl || null,
            addedAt: serverTimestamp()
        });
        // KI-Kategorisierung im Hintergrund wenn noch 'sonstiges'
        if (autoCategory === 'sonstiges') {
            queueForAICategory(listId, name.trim(), docRef.id);
        }
        return true;
    },

    async removeProduct(listId, productId) {
        const productRef = doc(db, "lists", listId, "products", productId);
        const snap = await getDoc(productRef);
        if (snap.exists()) {
            await setDoc(
                doc(db, "lists", listId, "deletedProducts", productId),
                { ...snap.data(), deletedAt: serverTimestamp() }
            );
        }
        await deleteDoc(productRef);
    },

    async getRecentlyDeletedProducts(listId) {
        const cutoff = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
        const q = query(
            collection(db, "lists", listId, "deletedProducts"),
            where("deletedAt", ">=", cutoff),
            orderBy("deletedAt", "desc")
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async cleanExpiredDeletedProducts(listId) {
        const cutoff = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
        const q = query(
            collection(db, "lists", listId, "deletedProducts"),
            where("deletedAt", "<", cutoff)
        );
        const snap = await getDocs(q);
        for (const d of snap.docs) {
            await deleteDoc(doc(db, "lists", listId, "deletedProducts", d.id));
        }
    },

    async restoreProduct(listId, productId) {
        const deletedRef = doc(db, "lists", listId, "deletedProducts", productId);
        const snap = await getDoc(deletedRef);
        if (!snap.exists()) return;
        const { deletedAt, ...productData } = snap.data();
        await setDoc(doc(db, "lists", listId, "products", productId), {
            ...productData,
            addedAt: serverTimestamp()
        });
        await deleteDoc(deletedRef);
    },

    async clearProducts(listId) {
        const productsSnapshot = await getDocs(collection(db, "lists", listId, "products"));
        for (const p of productsSnapshot.docs) {
            await deleteDoc(doc(db, "lists", listId, "products", p.id));
        }
    }
};

// ===== HILFSFUNKTIONEN =====
function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('active');
    const input = modal.querySelector('input:not([readonly])');
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
    const date = dateValue.seconds ? new Date(dateValue.seconds * 1000) : new Date(dateValue);
    const days = Math.floor((new Date() - date) / 86400000);
    if (days === 0) return 'Heute';
    if (days === 1) return 'Gestern';
    if (days < 7) return `Vor ${days} Tagen`;
    return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
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

// Firestore-Verbindung wiederherstellen wenn App aus dem Hintergrund kommt
// (iOS/Android pausieren die WebSocket-Verbindung → Sync stagniert)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        enableNetwork(db).catch(() => {});
    }
});

// ===== STARTSEITE =====
if (isHomePage) {
    // Benutzernamen in Untertitel anzeigen
    if (currentUsername) {
        const subtitleEl = document.querySelector('.subtitle');
        if (subtitleEl) subtitleEl.textContent = `Hallo, ${currentUsername}!`;
    }

    // Logout
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            localStorage.removeItem('auth_session');
            window.location.href = 'auth.html';
        });
    }

    const listsContainer = document.getElementById('listsContainer');
    const recentLists = document.getElementById('recentLists');
    const listNameInput = document.getElementById('listNameInput');
    let pendingDeleteListId = null;

    function renderRecentLists() {
        if (AppState.lists.length === 0) {
            recentLists.classList.remove('has-lists');
            listsContainer.innerHTML = '';
            return;
        }
        recentLists.classList.add('has-lists');
        listsContainer.innerHTML = AppState.lists.map(list => `
            <div class="list-card" data-list-id="${list.id}" role="button" tabindex="0" aria-label="Liste ${escapeHtml(list.name)} öffnen">
                <div class="list-card-info">
                    <h3>${escapeHtml(list.name)}</h3>
                    <span>${list.productCount || 0} Produkte · ${formatDate(list.createdAt)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <div class="list-card-arrow">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                    <button class="list-card-delete-btn" data-list-id="${list.id}" aria-label="Liste löschen">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');

        listsContainer.querySelectorAll('.list-card').forEach(card => {
            card.addEventListener('click', () => {
                AppState.setActiveList(card.dataset.listId);
                window.location.href = `shopping-list.html?list=${encodeURIComponent(card.dataset.listId)}`;
            });
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
            });
        });

        listsContainer.querySelectorAll('.list-card-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                pendingDeleteListId = btn.dataset.listId;
                showModal('homeDeleteModal');
            });
        });
    }

    let snapshotCallVersion = 0;
    onSnapshot(query(collection(db, "lists"), where("familyId", "==", currentFamilyId)), async (snapshot) => {
        const thisVersion = ++snapshotCallVersion;
        const raw = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const withCounts = await Promise.all(raw.map(async list => {
            const snap = await getDocs(collection(db, "lists", list.id, "products"));
            return { ...list, productCount: snap.size };
        }));
        if (thisVersion !== snapshotCallVersion) return;
        AppState.lists = withCounts.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        renderRecentLists();
    });

    // ── Konto teilen ──────────────────────────────────────────────
    function buildShareMessage(password) {
        const uname = currentUsername || currentUser?.username || '';
        const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
        const appUrl = base + 'auth.html';
        const pw = password || '••••••';
        return `Ich lade dich zu meiner Einkaufsliste ein! 🛒\n\nÖffne den Link und gib diese Daten ein:\n👤 Benutzername: ${uname}\n🔑 Passwort: ${pw}\n\n🔗 ${appUrl}`;
    }

    document.getElementById('shareAccountBtn').addEventListener('click', () => {
        document.getElementById('sharePasswordInput').value = '';
        document.getElementById('sharePasswordError').style.display = 'none';
        document.getElementById('sharePreviewText').textContent = buildShareMessage('');
        showModal('shareAccountModal');
    });

    document.getElementById('sharePasswordInput').addEventListener('input', () => {
        const pw = document.getElementById('sharePasswordInput').value;
        document.getElementById('sharePreviewText').textContent = buildShareMessage(pw);
        document.getElementById('sharePasswordError').style.display = 'none';
    });

    document.getElementById('closeShareAccount').addEventListener('click', () => hideModal('shareAccountModal'));

    document.getElementById('doShareAccount').addEventListener('click', async () => {
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
        const newList = await AppState.createList(name);
        hideModal('newListModal');
        window.location.href = `shopping-list.html?list=${encodeURIComponent(newList.id)}`;
    });

    listNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmNewList').click();
    });

    document.getElementById('homeDeleteCancel').addEventListener('click', () => {
        pendingDeleteListId = null;
        hideModal('homeDeleteModal');
    });

    document.getElementById('homeDeleteConfirm').addEventListener('click', async () => {
        if (pendingDeleteListId) {
            await AppState.deleteList(pendingDeleteListId);
            pendingDeleteListId = null;
        }
        hideModal('homeDeleteModal');
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { pendingDeleteListId = null; hideAllModals(); }
        });
    });

    // ===== KI-ASSISTENT =====
    function buildSystemPrompt() {
        const lists = AppState.lists || [];
        const defaultList = lists[0]?.name || 'Einkauf';
        const listsStr = lists.map(l => `"${l.name}"`).join(', ') || `"${defaultList}"`;
        return `Du bist ein hilfreicher, freundlicher KI-Assistent in einer deutschen Familien-Einkaufslisten-App – wie ChatGPT. Antworte IMMER auf Deutsch. Antworte auf ALLES was der Nutzer fragt.

LISTEN-VERWALTUNG: Du kannst Produkte zu Einkaufslisten hinzufügen. Wenn der Nutzer Produkte hinzufügen möchte, schreibe ZUERST diesen Block:
<action>{"type":"add","ops":[{"list":"Listenname","items":["Produkt1","Produkt2"]}]}</action>
Danach eine kurze Bestätigungsnachricht.

Verfügbare Listen: ${listsStr}
Standard-Liste (wenn keine Liste genannt): "${defaultList}"

KRITISCH: Füge AUSSCHLIESSLICH Produkte hinzu die der Nutzer EXPLIZIT genannt hat. Erfinde NIE eigene Produkte dazu.
FALSCH: Nutzer sagt "Briefmarken" → du fügst ["Briefmarken","Eier","Milch"] hinzu ← VERBOTEN
RICHTIG: Nutzer sagt "Briefmarken" → du fügst ["Briefmarken"] hinzu

Wenn du ein Rezept gibst, nutze dieses Format:
## [Rezeptname]
[1-2 Sätze]

## Zutaten (für [N] Personen)
- [Menge] [Zutat]

## Zubereitung
1. [Schritt]

Regeln: Nur ganze Zahlen ("1 Zwiebel", "3 EL Öl"), realistische Familienrezepte.
Bei anderen Fragen: freundlich und hilfreich, ohne Rezeptformat.`;
    }

    const CHAT_STORE  = 'ki_chat_v1';
    let aiHistory     = [];
    let chatLoaded    = false;

    const aiFab      = document.getElementById('aiFab');
    const aiDrawer   = document.getElementById('aiDrawer');
    const aiOverlay  = document.getElementById('aiDrawerOverlay');
    const aiMessages = document.getElementById('aiMessages');
    const aiInput    = document.getElementById('aiInput');
    const aiSendBtn  = document.getElementById('aiSendBtn');
    const aiStatus   = document.getElementById('aiStatus');

    // ===== CHAT VERLAUF =====
    function saveChatHistory() {
        const msgs = [];
        aiMessages.querySelectorAll('.ai-msg').forEach(el => {
            if (el.classList.contains('user')) {
                msgs.push({ t: 'u', text: el.querySelector('.ai-bubble').textContent });
            } else {
                const ing = [...el.querySelectorAll('.ai-ingredient-name')].map(e => e.textContent);
                msgs.push({ t: 'b', html: el.querySelector('.ai-bubble').innerHTML, ing });
            }
        });
        try { localStorage.setItem(CHAT_STORE, JSON.stringify({ msgs, history: aiHistory, at: Date.now() })); } catch(e) {}
    }

    function loadChatHistory() {
        try {
            const raw = localStorage.getItem(CHAT_STORE);
            if (!raw) return;
            const { msgs, history, at } = JSON.parse(raw);
            if (!msgs || msgs.length === 0) return;
            if (Date.now() - at > 7 * 24 * 60 * 60 * 1000) { localStorage.removeItem(CHAT_STORE); return; }
            document.querySelector('.ai-welcome')?.remove();
            renderMsgsInto(msgs, history);
        } catch(e) { localStorage.removeItem(CHAT_STORE); }
    }

    function clearChat() {
        localStorage.removeItem(CHAT_STORE);
        aiHistory = [];
        aiMessages.innerHTML = `
            <div class="ai-welcome">
                <p>Hallo! Ich bin dein KI-Koch-Assistent.</p>
                <p>Frag mich nach Rezepten oder was du kochen kannst!</p>
                <div class="ai-suggestions">
                    <button class="ai-suggestion-chip" data-msg="Was kann ich heute Abend kochen?">Was kann ich heute kochen?</button>
                    <button class="ai-suggestion-chip" data-msg="Schlage mir ein einfaches Rezept vor">Einfaches Rezept vorschlagen</button>
                    <button class="ai-suggestion-chip" data-msg="Was kann ich mit Hackfleisch kochen?">Rezept mit Hackfleisch</button>
                    <button class="ai-suggestion-chip" data-msg="Gesundes Abendessen für die Familie">Gesundes Familienessen</button>
                </div>
            </div>`;
        aiMessages.querySelectorAll('.ai-suggestion-chip').forEach(c =>
            c.addEventListener('click', () => { aiInput.value = c.dataset.msg; sendMessage(); })
        );
    }

    // Drawer
    const openAi  = () => {
        if (!chatLoaded) { chatLoaded = true; loadChatHistory(); }
        aiDrawer.classList.add('active');
        aiOverlay.classList.add('active');
        setTimeout(() => aiInput.focus(), 300);
    };
    const closeAi = () => { aiDrawer.classList.remove('active'); aiOverlay.classList.remove('active'); };
    aiFab.addEventListener('click', openAi);
    document.getElementById('aiDrawerClose').addEventListener('click', closeAi);
    aiOverlay.addEventListener('click', closeAi);
    document.querySelectorAll('.ai-suggestion-chip').forEach(c =>
        c.addEventListener('click', () => { aiInput.value = c.dataset.msg; sendMessage(); })
    );
    document.getElementById('aiListSelectCancel').addEventListener('click', () => hideModal('aiListSelectModal'));
    document.getElementById('aiListSelectModal').addEventListener('click', e => { if (e.target.id === 'aiListSelectModal') hideModal('aiListSelectModal'); });

    // Hilfsfunktionen
    const esc      = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const scrollDown = () => requestAnimationFrame(() => { aiMessages.scrollTop = aiMessages.scrollHeight; });

    // Markdown → HTML
    function toHtml(text) {
        let html = '', ul = false, ol = false;
        const close = () => { if(ul){html+='</ul>';ul=false;} if(ol){html+='</ol>';ol=false;} };
        const safe  = s => esc(s).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>');
        for (const line of text.split('\n')) {
            const h  = line.match(/^#{1,3} (.+)/);
            const li = line.match(/^[-•*] (.+)/);
            const lo = line.match(/^\d+\. (.+)/);
            if      (h)          { close(); html += `<h3>${safe(h[1])}</h3>`; }
            else if (li)         { if(ol){html+='</ol>';ol=false;} if(!ul){html+='<ul>';ul=true;} html+=`<li>${safe(li[1])}</li>`; }
            else if (lo)         { if(ul){html+='</ul>';ul=false;} if(!ol){html+='<ol>';ol=true;} html+=`<li>${safe(lo[1])}</li>`; }
            else if (line.trim()){ close(); html += `<p>${safe(line)}</p>`; }
            else                 { close(); }
        }
        close();
        return html;
    }

    // Zutaten aus Rezeptantwort extrahieren
    function parseIngredients(text) {
        const m = text.match(/##\s*Zutaten[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
        if (!m) return [];
        return m[1].split('\n').map(l => l.trim().replace(/^[-•*]\s+/,'').trim()).filter(l => l.length > 1 && l.length < 100 && !/^#/.test(l));
    }

    // Bubbles
    function addUserBubble(text) {
        document.querySelector('.ai-welcome')?.remove();
        aiMessages.insertAdjacentHTML('beforeend', `<div class="ai-msg user"><div class="ai-bubble">${esc(text)}</div></div>`);
        scrollDown();
    }

    function addBotBubble() {
        document.querySelector('.ai-welcome')?.remove();
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg bot';
        wrap.innerHTML = '<div class="ai-bubble"><div class="ai-thinking-dots"><span></span><span></span><span></span></div></div>';
        aiMessages.appendChild(wrap);
        scrollDown();
        return { msgDiv: wrap, bubble: wrap.querySelector('.ai-bubble') };
    }

    // Zutaten-Karte (ein-/ausklappbar)
    function addIngredientCard(msgDiv, ingredients) {
        if (!ingredients.length) return;
        const items = ingredients.map(name => ({ name, owned: false }));
        let expanded = false;

        const card = document.createElement('div');
        card.className = 'ai-ingredients-card';
        card.innerHTML = `
            <div class="ai-ingredients-header ai-ingredients-toggle" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
                <div style="display:flex;align-items:center;gap:6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                    Zutaten
                    <span style="background:var(--primary);color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:20px;line-height:1.6;">${items.length}</span>
                </div>
                <svg class="ai-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.2s ease;flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="ai-ingredient-list" style="display:none;"></div>
            <button class="ai-add-btn" style="display:none;"></button>`;

        const list    = card.querySelector('.ai-ingredient-list');
        const btn     = card.querySelector('.ai-add-btn');
        const header  = card.querySelector('.ai-ingredients-toggle');
        const chevron = card.querySelector('.ai-chevron');

        const refresh = () => {
            const n = items.filter(i => !i.owned).length;
            btn.disabled = n === 0;
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Zur Einkaufsliste <span class="ai-add-count">${n}</span>`;
        };

        header.addEventListener('click', () => {
            expanded = !expanded;
            list.style.display = expanded ? '' : 'none';
            btn.style.display  = expanded ? '' : 'none';
            chevron.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';
        });

        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'ai-ingredient-row';
            row.innerHTML = `<div class="ai-ingredient-check"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><span class="ai-ingredient-name">${esc(item.name)}</span>`;
            row.addEventListener('click', () => { item.owned = !item.owned; row.classList.toggle('owned', item.owned); refresh(); });
            list.appendChild(row);
        });

        refresh();
        btn.addEventListener('click', () => {
            const toAdd = items.filter(i => !i.owned).map(i => i.name);
            if (toAdd.length) showListPicker(toAdd);
        });
        msgDiv.appendChild(card);
    }

    // Listen-Auswahl
    function showListPicker(itemNames) {
        const container = document.getElementById('aiListSelectContainer');
        const noMsg     = document.getElementById('aiNoListsMsg');
        container.innerHTML = '';
        if (!AppState.lists.length) {
            noMsg.style.display = 'block'; container.style.display = 'none';
        } else {
            noMsg.style.display = 'none'; container.style.display = 'flex';
            AppState.lists.forEach(list => {
                const el = document.createElement('button');
                el.type = 'button';
                el.className = 'select-list-item';
                el.innerHTML = `<strong style="font-size:16px">${escapeHtml(list.name)}</strong><span>${list.productCount || 0} Produkte</span>`;
                el.addEventListener('click', async () => {
                    hideModal('aiListSelectModal');
                    for (const name of itemNames) await AppState.addProduct(list.id, name, 'sonstiges');
                    const toast = document.createElement('div');
                    toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:12px 20px;border-radius:20px;font-size:14px;z-index:9999;pointer-events:none;white-space:nowrap;';
                    toast.textContent = `${itemNames.length} Zutat${itemNames.length !== 1 ? 'en' : ''} zu „${list.name}" hinzugefügt ✓`;
                    document.body.appendChild(toast);
                    setTimeout(() => toast.remove(), 3000);
                });
                container.appendChild(el);
            });
        }
        showModal('aiListSelectModal');
    }

    // Nachricht senden
    async function sendMessage() {
        const text = aiInput.value.trim();
        if (!text || aiSendBtn.disabled) return;

        aiInput.value        = '';
        aiSendBtn.disabled   = true;
        aiStatus.textContent = 'Denkt nach…';
        aiStatus.className   = 'ai-drawer-status thinking';

        addUserBubble(text);
        aiHistory.push({ role: 'user', content: text });
        const { msgDiv, bubble } = addBotBubble();

        try {
            const res = await fetch(GROQ_PROXY, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [
                        { role: 'system', content: buildSystemPrompt() },
                        ...aiHistory
                    ],
                    max_tokens: 800,
                    temperature: 0.7
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error?.message || 'HTTP ' + res.status);
            }

            const data = await res.json();
            const full = data.choices[0]?.message?.content?.trim() || '';
            if (!full) throw new Error('Keine Antwort erhalten');

            // <action>-Blöcke ausführen (Produkte hinzufügen)
            const actionMatch = full.match(/<action>([\s\S]*?)<\/action>/);
            if (actionMatch) {
                try {
                    const cmd = JSON.parse(actionMatch[1]);
                    if (cmd.type === 'add' && Array.isArray(cmd.ops)) {
                        for (const op of cmd.ops) {
                            const list = resolveList(op.list);
                            if (!list) continue;
                            const items = cleanItems(op.items);
                            if (items.length) {
                                await Promise.all(items.map(it => AppState.addProduct(list.id, it, 'sonstiges')));
                            }
                        }
                    }
                } catch(e) {}
            }
            const displayText = full.replace(/<action>[\s\S]*?<\/action>/g, '').trim();

            bubble.innerHTML = toHtml(displayText || full);
            requestAnimationFrame(() => {
                aiMessages.scrollTo({ top: msgDiv.offsetTop - 12, behavior: 'smooth' });
            });
            aiHistory.push({ role: 'assistant', content: full });
            addIngredientCard(msgDiv, parseIngredients(displayText));
            saveChatHistory();

        } catch (err) {
            console.error('KI-Fehler:', err);
            aiHistory.pop();
            bubble.innerHTML = `<p style="color:#FF3B30;font-size:13px;font-weight:600">Fehler: ${esc(err.message)}</p><p style="font-size:12px;color:#8E8E93;margin-top:4px">Nochmal senden.</p>`;
        }

        aiStatus.textContent = 'Online';
        aiStatus.className   = 'ai-drawer-status';
        aiSendBtn.disabled   = false;
        aiInput.focus();
    }

    aiSendBtn.addEventListener('click', sendMessage);
    aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    document.getElementById('aiClearBtn').addEventListener('click', () => { archiveCurrentChat(); clearChat(); });

    // ===== CHAT-VERLAUF PANEL =====
    const SESSIONS_STORE = 'ki_sessions_v1';
    const MAX_SESSIONS   = 15;
    const historyPanel   = document.getElementById('aiHistoryPanel');
    const historyList    = document.getElementById('aiHistoryList');

    function getSessions() {
        try { return JSON.parse(localStorage.getItem(SESSIONS_STORE) || '[]'); }
        catch { return []; }
    }

    function archiveCurrentChat() {
        try {
            const raw = localStorage.getItem(CHAT_STORE);
            if (!raw) return;
            const { msgs, history, at } = JSON.parse(raw);
            if (!msgs || msgs.length === 0) return;
            const preview = msgs.find(m => m.t === 'u')?.text || '…';
            const userCount = msgs.filter(m => m.t === 'u').length;
            const id = (at || Date.now()).toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            localStorage.setItem('ki_sess_' + id, JSON.stringify({ msgs, history }));
            const sessions = getSessions();
            // avoid duplicate (same timestamp)
            if (!sessions.find(s => s.id === id)) {
                sessions.unshift({ id, at: at || Date.now(), preview, userCount });
                const removed = sessions.splice(MAX_SESSIONS);
                removed.forEach(s => { try { localStorage.removeItem('ki_sess_' + s.id); } catch(e){} });
                localStorage.setItem(SESSIONS_STORE, JSON.stringify(sessions));
            }
        } catch(e) {}
    }

    function fmtDate(ts) {
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now - d;
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffDays === 0) return 'Heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        if (diffDays === 1) return 'Gestern, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    function renderMsgsInto(msgs, history) {
        aiMessages.innerHTML = '';
        aiHistory = history || [];
        msgs.forEach(m => {
            const wrap = document.createElement('div');
            if (m.t === 'u') {
                wrap.className = 'ai-msg user';
                wrap.innerHTML = `<div class="ai-bubble">${esc(m.text)}</div>`;
                aiMessages.appendChild(wrap);
            } else {
                wrap.className = 'ai-msg bot';
                const bubble = document.createElement('div');
                bubble.className = 'ai-bubble';
                bubble.innerHTML = m.html;
                wrap.appendChild(bubble);
                aiMessages.appendChild(wrap);
                if (m.ing && m.ing.length > 0) addIngredientCard(wrap, m.ing);
            }
        });
        aiMessages.scrollTop = aiMessages.scrollHeight;
    }

    function deleteSession(id) {
        try {
            localStorage.removeItem('ki_sess_' + id);
            const updated = getSessions().filter(s => s.id !== id);
            localStorage.setItem(SESSIONS_STORE, JSON.stringify(updated));
        } catch(e) {}
    }

    function showHistoryPanel() {
        const sessions = getSessions();
        historyList.innerHTML = '';
        if (sessions.length === 0) {
            historyList.innerHTML = `<div class="ai-history-empty">Noch keine alten Chats gespeichert.<br><br>Starte ein Gespräch — es wird hier automatisch gespeichert.</div>`;
        } else {
            sessions.forEach(s => {
                const card = document.createElement('div');
                card.className = 'ai-history-card';
                const n = s.userCount || 1;
                card.innerHTML = `
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                        <div style="min-width:0;flex:1;">
                            <div class="ai-history-card-date">${fmtDate(s.at)}</div>
                            <div class="ai-history-card-preview">${esc(s.preview)}</div>
                            <div class="ai-history-card-count">${n} Nachricht${n !== 1 ? 'en' : ''}</div>
                        </div>
                        <button class="ai-history-delete" title="Chat löschen" style="flex-shrink:0;width:32px;height:32px;border:none;background:none;cursor:pointer;color:var(--text-secondary);border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </button>
                    </div>`;
                card.querySelector('.ai-history-delete').addEventListener('click', e => {
                    e.stopPropagation();
                    deleteSession(s.id);
                    card.remove();
                    if (!historyList.querySelector('.ai-history-card')) {
                        historyList.innerHTML = `<div class="ai-history-empty">Noch keine alten Chats gespeichert.<br><br>Starte ein Gespräch — es wird hier automatisch gespeichert.</div>`;
                    }
                });
                card.addEventListener('click', () => {
                    try {
                        const raw = localStorage.getItem('ki_sess_' + s.id);
                        if (!raw) return;
                        const { msgs, history } = JSON.parse(raw);
                        renderMsgsInto(msgs, history);
                        saveChatHistory();
                    } catch(e) {}
                    historyPanel.classList.remove('open');
                });
                historyList.appendChild(card);
            });
        }
        historyPanel.classList.add('open');
    }

    document.getElementById('aiHistoryBtn').addEventListener('click', showHistoryPanel);
    document.getElementById('aiHistoryBack').addEventListener('click', () => historyPanel.classList.remove('open'));

    // ===== SPRACHSTEUERUNG =====
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const voiceFab = document.getElementById('voiceFab');
    if (!SpeechRecognition) {
        if (voiceFab) voiceFab.style.display = 'none';
    } else {
        const rec = new SpeechRecognition();
        rec.lang = 'de-DE';
        rec.interimResults = false;
        rec.maxAlternatives = 3;
        let isRecording = false;

        // Normalize: lowercase, remove umlauts for fuzzy matching, strip fillers
        function normVoice(s) {
            return s.toLowerCase()
                .replace(/[äÄ]/g,'a').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/ß/g,'ss')
                .replace(/\b(ahm|ahh|ah|äh|ähm|ähh|halt|mal|bitte|einfach|irgendwie|so|da|noch|doch|und|die|der|das|ein|eine|einen)\b/g,' ')
                .replace(/\s+/g,' ').trim();
        }

        // Find the best matching list by fuzzy search in text
        function findListIn(text) {
            const norm = normVoice(text);
            if (!AppState.lists.length) return null;
            // 1. full name contained
            for (const l of AppState.lists) {
                if (norm.includes(normVoice(l.name))) return l;
            }
            // 2. any word of list name (len > 2) found in text
            for (const l of AppState.lists) {
                const words = normVoice(l.name).split(/\s+/).filter(w => w.length > 2);
                if (words.some(w => norm.includes(w))) return l;
            }
            // 3. text starts with part of a list name
            for (const l of AppState.lists) {
                const ln = normVoice(l.name);
                if (ln.length > 2 && norm.startsWith(ln.slice(0, Math.min(4, ln.length)))) return l;
            }
            return null;
        }

        // Remove the list reference from text to isolate the item
        function stripListRef(text, list) {
            let s = normVoice(text);
            const ln = normVoice(list.name);
            // remove keywords + list name
            s = s.replace(new RegExp('(?:auf|zur?|in\\s+die|in|an)?\\s*(?:die\\s+)?liste\\s+' + ln.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi'), '');
            s = s.replace(new RegExp(ln, 'gi'), '');
            // remove trailing/leading action words
            s = s.replace(/\b(f[üu]ge?|hinzu|auf|zur?|in|liste|mach|schreib|notier|add|trag|ein)\b/gi, '');
            return s.replace(/\s+/g,' ').trim();
        }

        function isQuestion(text) {
            return /\b(was\s+ist|was\s+sind|was\s+bedeutet|wie\s+macht|wie\s+geht|wie\s+viel|warum|wann\s+ist|wer\s+ist|wo\s+ist|woher|wohin|kannst\s+du|kann\s+ich|k[öo]nntest\s+du|hilf\s+mir|erkl[äa]r|sag\s+mir|zeig\s+mir|empfiehl|erz[äa]hl|berechne|rechne|[üu]bersetze|schreib\s+mir\s+(?:ein|eine)|was\s+kann\s+ich|was\s+soll\s+ich|was\s+wei[ßs]t)\b/i.test(text)
                || text.trim().endsWith('?');
        }

        // Wörter die niemals ein Artikel sein können
        const FORBIDDEN_ITEM = /^(zur?|auf|in|an|die|der|das|ein|eine|einen|liste|hinzu|f[üu]ge?|mach|schreib|add|trag|notier|und|oder|mit|von|nach|bei|für|um|aus|über|unter|neben|zwischen)$/i;

        function isValidItem(s) {
            if (!s || s.length < 2) return false;
            // Alle Wörter müssen erlaubt sein
            return s.split(/\s+/).every(w => !FORBIDDEN_ITEM.test(w));
        }

        function tryAddCommand(transcript) {
            if (isQuestion(transcript)) return false;

            // Filler-Wörter entfernen
            let clean = transcript
                .replace(/\b(ahm|ahh|ah|[äa]hm|[äa]hh|halt|eben|quasi|sozusagen|eigentlich|irgendwie)\b/gi, ' ')
                .replace(/\s+/g, ' ').trim();

            // Muss mindestens ein Einkaufs-Signal ODER bekannte Liste ODER sehr kurz sein
            const hasSignal = /\b(f[üu]ge?|hinzu|kauf|hol|pack|schreib|notier|brauch|vergiss|vergessen|besorg|bestell|trag|setz|stell|merk|liste|einpack|besorgen|kaufen|holen|bestellen|m[öo]chte|wollen|brauchen)\b/i.test(clean);
            const hasListRef = findListIn(clean) !== null;
            if (!hasSignal && !hasListRef && clean.split(/\s+/).length > 4) return false;

            // --- Schritt 1: Listenverweis isolieren und entfernen ---
            let list = null;
            const listMatch = clean.match(/\b(?:auf\s+(?:die\s+)?|zur?\s+(?:die\s+)?|in\s+(?:die\s+)?)liste\s+(\S+(?:\s+\S+)?)(?=\s*(?:hinzu|ein|auf|$))/i)
                || clean.match(/\bliste\s+(\S+(?:\s+\S+)?)(?:\s|$)/i);
            if (listMatch) {
                list = findListIn(listMatch[1]);
                clean = clean.replace(listMatch[0], ' ').replace(/\s+/g, ' ').trim();
            }
            if (!list) {
                const found = findListIn(clean);
                if (found) { list = found; clean = stripListRef(clean, found); }
            }

            // --- Schritt 2: Aktionswörter (Präfix + Suffix) abstreifen ---
            let item = clean
                // Präfixe — alle Arten wie man "hinzufügen" ausdrücken kann
                .replace(/^f[üu]ge?\s+/i, '')
                .replace(/^(?:kauf(?:e)?|besorg(?:e)?|bestell(?:e)?)\s+(?:noch\s+|bitte\s+|mir\s+|uns\s+|dir\s+)*/i, '')
                .replace(/^(?:hol(?:e)?)\s+(?:noch\s+|bitte\s+|mir\s+|uns\s+)*/i, '')
                .replace(/^(?:pack(?:e)?)\s+(?:noch\s+)?/i, '')
                .replace(/^(?:schreib(?:e)?)\s+(?:noch\s+|bitte\s+)*/i, '')
                .replace(/^(?:notier(?:e)?|trag\s+ein|trage\s+ein)\s+/i, '')
                .replace(/^(?:wir\s+brauchen|ich\s+brauche)\s+(?:noch\s+|dringend\s+|unbedingt\s+)*/i, '')
                .replace(/^(?:wir\s+(?:m[öo]chten|wollen|h[äa]tten\s+gern)|ich\s+(?:m[öo]chte|will|h[äa]tte\s+gern))\s+/i, '')
                .replace(/^(?:merk\s+(?:dir|euch|uns)|merke\s+(?:dir|euch|uns))\s+/i, '')
                .replace(/^(?:tu(?:e)?|tus|leg(?:e)?|setz(?:e)?|stell(?:e)?)\s+/i, '')
                .replace(/^(?:vergiss\s+nicht|nicht\s+vergessen)\s*[:,]?\s*/i, '')
                .replace(/^(?:ich\s+brauche\s+noch|wir\s+brauchen\s+noch)\s+/i, '')
                // Suffixe
                .replace(/\s+hinzu$/i, '')
                .replace(/\s+ein$/i, '')
                .replace(/\s+(?:kaufen|besorgen|holen|bestellen|einpacken|aufschreiben|hinzuf[üu]gen|eintragen|notieren|einf[üu]gen)$/i, '')
                .replace(/\s+nicht\s+vergessen$/i, '')
                .replace(/\s+(?:auf|in|zur?)\s+(?:die\s+)?(?:liste\s*\S*|einkaufsliste)$/i, '')
                .replace(/\s+(?:kommt?|muss|soll)\s+(?:noch\s+)?(?:auf|in)\s+(?:die\s+)?liste$/i, '')
                .replace(/\s+auf\s+die\s+liste$/i, '')
                .replace(/\s+auf$/i, '')
                // Verbleibende Füller
                .replace(/\b(bitte|noch|dringend|schnell|kurz|unbedingt)\b/gi, '')
                .replace(/\s+/g, ' ').trim();

            if (!isValidItem(item)) return false;
            if (!list) list = AppState.lists[0];
            if (!list) return false;

            // Mehrere Artikel aufteilen: "Milch, Bananen und Brot" → ["Milch", "Bananen", "Brot"]
            const items = item
                .split(/\s*,\s*|\s+und\s+|\s+sowie\s+|\s+außerdem\s+/i)
                .map(s => s.trim())
                .filter(s => isValidItem(s))
                .map(s => s.charAt(0).toUpperCase() + s.slice(1));

            if (items.length === 0) return false;

            Promise.all(items.map(it => AppState.addProduct(list.id, it, 'sonstiges'))).then(() => {
                const toast = document.createElement('div');
                toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:12px 20px;border-radius:20px;font-size:14px;z-index:9999;pointer-events:none;white-space:nowrap;';
                toast.textContent = items.length === 1
                    ? `„${items[0]}" zu „${list.name}" hinzugefügt ✓`
                    : `${items.length} Artikel zu „${list.name}" hinzugefügt ✓`;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            });
            return true;
        }

        // Groß/Kleinschreibung normalisieren: ersten Buchstaben groß, Rest klein
        // Kurze Abkürzungen (HH, DM, Bio) bleiben wie sie sind
        function fixCase(s) {
            return s.split(/\s+/).map(w => {
                if (w.length <= 3 && w === w.toUpperCase()) return w; // Abkürzung
                return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            }).join(' ');
        }

        function resolveList(name) {
            if (!name || !AppState.lists.length) return AppState.lists[0] || null;
            const n = normVoice(name);
            return AppState.lists.find(l => l.name === name)
                // normalisierter exakter Match
                || AppState.lists.find(l => normVoice(l.name) === n)
                // AI gibt längeren Namen zurück als Liste heißt: "Einkaufsliste" → Liste "Einkauf"
                || AppState.lists.find(l => n.includes(normVoice(l.name)) && normVoice(l.name).length > 2)
                // Liste enthält den gesuchten Namen: "DM Markt" → gesucht "DM"
                || AppState.lists.find(l => normVoice(l.name).includes(n) && n.length > 2)
                // erstes Wort des Listennamens reicht: "Einkauf" findet "Einkauf Rewe"
                || AppState.lists.find(l => normVoice(l.name).split(' ')[0] === n.split(' ')[0] && n.length > 2)
                || AppState.lists[0];
        }

        // Befehlswörter aus Artikelnamen entfernen (KI gibt manchmal “Milch kaufen” statt “Milch” zurück)
        function sanitizeItemName(s) {
            return s
                .replace(/\b(f[üu]ge?|hinzu|ein|auf|kauf(?:en)?|hol(?:en)?|besorg(?:en)?|bestell(?:en)?|notier(?:en)?|schreib(?:en)?|nicht vergessen|vergiss nicht|bitte|zur liste|auf die liste|in die liste)\b/gi, '')
                .replace(/\s+/g, ' ').trim();
        }

        // Sendet Sprachbefehl still an die KI (keine Anzeige, kein Speichern)
        async function silentAI(transcript) {
            if (!AppState.lists?.length) throw new Error('Keine Listen');
            const res = await fetch(GROQ_PROXY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [
                        { role: 'system', content: buildSystemPrompt() },
                        { role: 'user', content: transcript }
                    ],
                    max_tokens: 300,
                    temperature: 0.1
                })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            return (data.choices[0]?.message?.content || '').trim();
        }

        // Führt <action>-Blöcke aus der KI-Antwort aus, gibt Anzahl der hinzugefügten Produkte zurück
        async function executeActionsFromAI(text, transcript) {
            const match = text.match(/<action>([\s\S]*?)<\/action>/);
            if (!match) return 0;
            try {
                const cmd = JSON.parse(match[1]);
                if (cmd.type !== 'add' || !Array.isArray(cmd.ops)) return 0;
                let total = 0;
                for (const op of cmd.ops) {
                    const list = resolveList(op.list);
                    if (!list) continue;
                    const items = cleanItems(op.items, transcript);
                    if (items.length) {
                        await Promise.all(items.map(it => AppState.addProduct(list.id, it, 'sonstiges')));
                        showVoiceToast(items, list.name);
                        total += items.length;
                    }
                }
                return total;
            } catch(e) { return 0; }
        }

        function showVoiceToast(items, listName) {
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:12px 20px;border-radius:20px;font-size:14px;z-index:9999;pointer-events:none;white-space:nowrap;';
            toast.textContent = items.length === 1
                ? `„${items[0]}” zu „${listName}” hinzugefügt ✓`
                : `${items.length} Artikel zu „${listName}” hinzugefügt ✓`;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }

        // Prüft ob ein Item tatsächlich im Sprachbefehl erwähnt wurde (Anti-Halluzination)
        function itemMentionedInTranscript(item, transcript) {
            const t = normVoice(transcript);
            const words = normVoice(item).split(/\s+/).filter(w => w.length > 2);
            if (words.length === 0) return true;
            return words.some(w => t.includes(w));
        }

        // Items aus AI-Antwort sauber machen
        function cleanItems(raw, transcript) {
            return (raw || [])
                .map(s => fixCase(sanitizeItemName(String(s).trim())))
                .filter(s => s.length > 1 && s.split(/\s+/).length <= 6)
                .filter(s => !transcript || itemMentionedInTranscript(s, transcript));
        }

        rec.addEventListener('result', async e => {
            voiceFab.classList.remove('recording');
            voiceFab.classList.add('thinking');
            const transcript = e.results[0][0].transcript.trim();

            try {
                const aiResponse = await silentAI(transcript);
                const actionsCount = await executeActionsFromAI(aiResponse, transcript);

                voiceFab.classList.remove('thinking');

                if (actionsCount === 0) {
                    // Keine Aktion erkannt → Chat öffnen und KI-Antwort anzeigen
                    const cleanText = aiResponse.replace(/<action>[\s\S]*?<\/action>/g, '').trim();
                    openAi();
                    setTimeout(() => {
                        if (cleanText) {
                            addUserBubble(transcript);
                            aiHistory.push({ role: 'user', content: transcript });
                            const { msgDiv, bubble } = addBotBubble();
                            bubble.innerHTML = toHtml(cleanText);
                            aiHistory.push({ role: 'assistant', content: cleanText });
                            addIngredientCard(msgDiv, parseIngredients(cleanText));
                            saveChatHistory();
                            aiMessages.scrollTo({ top: aiMessages.scrollHeight, behavior: 'smooth' });
                        } else {
                            aiInput.value = transcript;
                            sendMessage();
                        }
                    }, 350);
                }
            } catch (err) {
                // Netzwerk-Fehler → Regex als letzter Ausweg
                voiceFab.classList.remove('thinking');
                let handled = false;
                for (let i = 0; i < e.results[0].length; i++) {
                    if (tryAddCommand(e.results[0][i].transcript.trim())) { handled = true; break; }
                }
                if (!handled) {
                    openAi();
                    setTimeout(() => { aiInput.value = transcript; sendMessage(); }, 350);
                }
            }
        });
        rec.addEventListener('end', () => {
            isRecording = false;
            voiceFab.classList.remove('recording');
        });
        rec.addEventListener('error', () => {
            isRecording = false;
            voiceFab.classList.remove('recording');
            voiceFab.classList.remove('thinking');
        });

        voiceFab.addEventListener('click', () => {
            if (isRecording) { rec.stop(); }
            else { isRecording = true; voiceFab.classList.add('recording'); rec.start(); }
        });

        const voiceFabChip = document.getElementById('voiceFabChip');
        if (voiceFabChip) voiceFabChip.addEventListener('click', () => voiceFab.click());
    }
}

// ===== LISTENSEITE =====
if (isListPage) {
    let selectedCategory = 'sonstiges';
    let userManuallySelectedCategory = false;
    let confirmCallback = null;
    let currentListId = null;
    let currentProducts = [];
    let pendingImageBase64 = null;

    const listTitle = document.getElementById('listTitle');
    const productInput = document.getElementById('productInput');
    const productsContainer = document.getElementById('productsContainer');
    const emptyState = document.getElementById('emptyState');
    const fileInput = document.getElementById('fileInput');
    const cameraInput = document.getElementById('cameraInput');
    const categorySelector = document.getElementById('categorySelector');

    // ===== KATEGORIE CHIPS RENDERN =====
    function renderCategoryChips() {
        const cats = AppState.getCategories();
        if (!cats.find(c => c.id === selectedCategory)) {
            selectedCategory = 'sonstiges';
        }
        categorySelector.innerHTML = cats.map(cat => `
            <button class="category-chip ${cat.id === selectedCategory ? 'active' : ''}" data-category="${cat.id}">
                ${cat.emoji} ${cat.name}
            </button>
        `).join('');

        categorySelector.querySelectorAll('.category-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                categorySelector.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                selectedCategory = chip.dataset.category;
                userManuallySelectedCategory = true;
            });
        });
    }

    // ===== ZULETZT GELÖSCHT MODAL =====
    function renderRecentlyDeleted(items) {
        const body = document.getElementById('recentlyDeletedBody');
        if (!items || items.length === 0) {
            body.innerHTML = `<div class="deleted-empty-state">Keine kürzlich gelöschten Produkte</div>`;
            return;
        }
        const rows = items.map(item => {
            const catInfo = AppState.getCategoryInfo(item.category || 'sonstiges');
            const ms = item.deletedAt?.seconds ? Date.now() - item.deletedAt.seconds * 1000 : 0;
            const mins = Math.max(0, Math.round(ms / 60000));
            const time = mins === 0 ? 'Gerade eben' : `Vor ${mins} Min.`;
            return `<div class="deleted-product-item">
                <div class="deleted-product-item-info">
                    <span class="deleted-product-item-name">${escapeHtml(item.name)}</span>
                    <span class="deleted-product-item-meta">${catInfo.emoji} ${catInfo.name} · ${time}</span>
                </div>
                <button class="restore-btn" data-product-id="${item.id}">Wiederherstellen</button>
            </div>`;
        }).join('');
        body.innerHTML = `<div class="deleted-product-list">${rows}</div>`;
        body.querySelectorAll('.restore-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = '…';
                await AppState.restoreProduct(currentListId, btn.dataset.productId);
                btn.closest('.deleted-product-item').remove();
                if (!body.querySelector('.deleted-product-item')) {
                    body.innerHTML = `<div class="deleted-empty-state">Keine kürzlich gelöschten Produkte</div>`;
                }
            });
        });
    }

    // ===== KATEGORIEN BEARBEITEN MODAL =====
    function renderEditCategories() {
        const listEl = document.getElementById('categoriesList');

        // Standard-Kategorien
        const defaultHtml = DEFAULT_CATEGORIES.map(cat => {
            const isHidden = AppState.hiddenDefaultCategories.includes(cat.id);
            return `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--background);border-radius:var(--radius);margin-bottom:6px;">
                    <span style="font-size:16px;${isHidden ? 'opacity:0.4;text-decoration:line-through;' : ''}">${cat.emoji} ${cat.name}</span>
                    <button class="toggle-default-btn"
                        data-cat-id="${cat.id}"
                        data-hidden="${isHidden}"
                        style="border:none;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;
                        background:${isHidden ? 'var(--primary-light)' : 'var(--danger-light)'};
                        color:${isHidden ? 'var(--primary)' : 'var(--danger)'};">
                        ${isHidden ? 'Einblenden' : 'Ausblenden'}
                    </button>
                </div>
            `;
        }).join('');

        // Eigene Kategorien
        const customHtml = AppState.customCategories.length > 0
            ? `<div style="margin-top:12px;margin-bottom:6px;font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Eigene Kategorien</div>`
            + AppState.customCategories.map(cat => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--background);border-radius:var(--radius);margin-bottom:6px;">
                    <span style="font-size:16px;">${cat.emoji} ${cat.name}</span>
                    <button class="delete-cat-btn" data-cat-id="${cat.id}"
                        style="background:var(--danger-light);color:var(--danger);border:none;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;">
                        Löschen
                    </button>
                </div>
            `).join('')
            : '';

        listEl.innerHTML = `
            <div style="margin-bottom:6px;font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Standard-Kategorien</div>
            ${defaultHtml}
            ${customHtml}
        `;

        // Ausblenden / Einblenden
        listEl.querySelectorAll('.toggle-default-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const catId = btn.dataset.catId;
                const isHidden = btn.dataset.hidden === 'true';
                if (isHidden) {
                    await AppState.showDefaultCategory(currentListId, catId);
                } else {
                    await AppState.hideDefaultCategory(currentListId, catId);
                    if (selectedCategory === catId) selectedCategory = 'sonstiges';
                }
                renderCategoryChips();
                renderEditCategories();
            });
        });

        // Eigene löschen
        listEl.querySelectorAll('.delete-cat-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const catId = btn.dataset.catId;
                await AppState.deleteCustomCategory(currentListId, catId);
                if (selectedCategory === catId) selectedCategory = 'sonstiges';
                renderCategoryChips();
                renderEditCategories();
            });
        });
    }

    // ===== LISTE RENDERN =====
    function renderList(list, products) {
        if (!list) return;
        listTitle.textContent = list.name || 'Einkaufsliste';
        document.title = (list.name || 'Einkaufsliste') + ' - Einkaufsliste';

        if (!products || products.length === 0) {
            productsContainer.innerHTML = '';
            emptyState.classList.add('visible');
            return;
        }

        emptyState.classList.remove('visible');

        const grouped = {};
        const allCats = [...DEFAULT_CATEGORIES, ...AppState.customCategories];
        const order = allCats.map(c => c.id);

        products.forEach(p => {
            const cat = (p.category && order.includes(p.category)) ? p.category : 'sonstiges';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(p);
        });

        let html = '';
        order.forEach(catKey => {
            if (grouped[catKey]?.length > 0) {
                const info = AppState.getCategoryInfo(catKey);
                html += `
                    <div class="category-section">
                        <div class="category-header group-head">
                            <h3>${info.name}</h3>
                            <span class="count">${grouped[catKey].length}</span>
                        </div>
                        <div class="products-list">
                            ${grouped[catKey].map(p => `
                                <button class="product-item pitem" data-product-id="${p.id}" aria-pressed="false" aria-label="${escapeHtml(p.name)} abhaken">
                                    <span class="checkbox pcheck">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="20 6 9 17 4 12"/>
                                        </svg>
                                    </span>
                                    <span class="product-name pname">${escapeHtml(p.name)}</span>
                                    ${p.imageUrl ? `
                                        <button class="photo-link-btn" data-image="${encodeURIComponent(p.imageUrl)}" data-name="${escapeHtml(p.name)}">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                                                <circle cx="12" cy="13" r="4"/>
                                            </svg>
                                            Foto
                                        </button>
                                    ` : ''}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
        });

        productsContainer.innerHTML = html;

        productsContainer.querySelectorAll('.product-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.photo-link-btn')) return;
                item.classList.remove('pop');
                void item.offsetWidth;
                item.classList.add('checking', 'pop');
                item.setAttribute('aria-pressed', 'true');
                setTimeout(() => {
                    item.classList.add('checked');
                    setTimeout(async () => {
                        await AppState.removeProduct(currentListId, item.dataset.productId);
                    }, 300);
                }, 450);
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
            });
        });

        productsContainer.querySelectorAll('.photo-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const imageUrl = decodeURIComponent(btn.dataset.image);
                const name = btn.dataset.name;
                document.getElementById('photoViewImg').src = imageUrl;
                document.getElementById('photoViewTitle').textContent = name;
                showModal('photoViewModal');
            });
        });
    }

    async function addProduct() {
        const name = productInput.value.trim();
        if (!name || !currentListId) return;
        const success = await AppState.addProduct(currentListId, name, selectedCategory);
        if (success) {
            productInput.value = '';
            productInput.focus();
            userManuallySelectedCategory = false;
        }
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

    function subscribeToList(listId) {
        onSnapshot(doc(db, "lists", listId), (snap) => {
            if (!snap.exists()) { window.location.href = 'index.html'; return; }
            if (snap.data().familyId && snap.data().familyId !== currentFamilyId) {
                window.location.href = 'index.html';
                return;
            }
            AppState.activeList = { id: snap.id, ...snap.data() };
            renderList(AppState.activeList, currentProducts);
        });

        if (AppState.unsubscribeProducts) AppState.unsubscribeProducts();

        AppState.unsubscribeProducts = onSnapshot(
            collection(db, "lists", listId, "products"),
            (snapshot) => {
                currentProducts = snapshot.docs
                    .map(d => ({ id: d.id, ...d.data() }))
                    .sort((a, b) => (a.addedAt?.seconds || 0) - (b.addedAt?.seconds || 0));
                renderList(AppState.activeList, currentProducts);
            }
        );
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
        AppState.loadCategorySettings(currentListId).then(() => {
            renderCategoryChips();
            subscribeToList(currentListId);
        });
    }

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

    document.getElementById('recentlyDeletedAction').addEventListener('click', async () => {
        hideModal('menuModal');
        await AppState.cleanExpiredDeletedProducts(currentListId);
        const items = await AppState.getRecentlyDeletedProducts(currentListId);
        renderRecentlyDeleted(items);
        showModal('recentlyDeletedModal');
    });

    document.getElementById('closeRecentlyDeleted').addEventListener('click', () => {
        hideModal('recentlyDeletedModal');
    });

    document.getElementById('addCategoryBtn').addEventListener('click', async () => {
        const input = document.getElementById('newCategoryName');
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        await AppState.addCustomCategory(currentListId, name, '🏷️');
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

    function showToast(message, duration = 3000) {
        const existing = document.getElementById('app-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.textContent = message;
        toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:12px 20px;border-radius:20px;font-size:14px;z-index:9999;text-align:center;max-width:80%;pointer-events:none;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

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
            const resized = await resizeImage(e.target.result);
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

    document.getElementById('confirmImageProduct').addEventListener('click', async () => {
        const name = document.getElementById('imageProductName').value.trim();
        if (!name) { document.getElementById('imageProductName').focus(); return; }
        await AppState.addProduct(currentListId, name, selectedCategory, pendingImageBase64);
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

    document.getElementById('confirmRename').addEventListener('click', async () => {
        const newName = document.getElementById('renameInput').value.trim();
        if (currentListId && newName) await AppState.renameList(currentListId, newName);
        hideModal('renameModal');
    });

    document.getElementById('renameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmRename').click();
    });

    document.getElementById('clearListAction').addEventListener('click', () => {
        hideModal('menuModal');
        document.getElementById('confirmTitle').textContent = 'Alle löschen?';
        document.getElementById('confirmMessage').textContent = 'Alle Produkte werden unwiderruflich gelöscht.';
        document.getElementById('confirmAction').textContent = 'Alle löschen';
        confirmCallback = async () => { if (currentListId) await AppState.clearProducts(currentListId); };
        showModal('confirmModal');
    });

    document.getElementById('deleteListAction').addEventListener('click', () => {
        hideModal('menuModal');
        document.getElementById('confirmTitle').textContent = 'Liste löschen?';
        document.getElementById('confirmMessage').textContent = 'Die Liste und alle Produkte werden unwiderruflich gelöscht.';
        document.getElementById('confirmAction').textContent = 'Löschen';
        confirmCallback = async () => {
            if (currentListId) {
                try { await AppState.deleteList(currentListId); } catch (e) {}
                window.location.href = 'index.html';
            }
        };
        showModal('confirmModal');
    });

    document.getElementById('cancelConfirm').addEventListener('click', () => {
        hideModal('confirmModal'); confirmCallback = null;
    });

    document.getElementById('confirmAction').addEventListener('click', async () => {
        if (confirmCallback) { await confirmCallback(); confirmCallback = null; }
        hideModal('confirmModal');
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', async (e) => {
            if (e.target === overlay) {
                hideAllModals();
                confirmCallback = null;
            }
        });
    });
}

} // end auth check

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
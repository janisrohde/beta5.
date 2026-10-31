// Lokaler Notfall-Parser für Sprachbefehle (Stufe D, ohne Internet).
// Ergebnis ist nur ein Vorschlag – die App fragt vor dem Eintragen nach.
// Umlaute bleiben erhalten („Äpfel“, nicht „Apel“).

const NUMBER_WORDS = {
    ein: 1, eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6,
    sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, paar: 2, dutzend: 12
};
const UNITS = {
    liter: 'l', l: 'l', kilo: 'kg', kilogramm: 'kg', kg: 'kg', gramm: 'g', g: 'g',
    packung: 'Pck.', packungen: 'Pck.', pack: 'Pck.', päckchen: 'Pck.', flasche: 'Fl.', flaschen: 'Fl.',
    dose: 'Dose', dosen: 'Dosen', becher: 'Becher', stück: 'Stück', bund: 'Bund', netz: 'Netz', tüte: 'Tüte', glas: 'Glas', gläser: 'Gläser'
};
const FILLERS = [
    'ähm', 'äh', 'ähh', 'öhm', 'hm', 'hmm', 'also', 'halt', 'mal', 'bitte', 'noch', 'so', 'ja', 'okay', 'ok',
    'glaub ich', 'glaube ich', 'oder so', 'irgendwie', 'eigentlich', 'einfach', 'auch', 'vielleicht',
    'wir brauchen', 'ich brauche', 'brauchen wir', 'brauche ich', 'wir müssen', 'kauf', 'kaufen', 'besorgen',
    'setz', 'setze', 'schreib', 'schreibe', 'pack', 'packe', 'tu', 'tue', 'füg', 'füge', 'hinzu',
    'auf die liste', 'auf die einkaufsliste', 'auf meine liste', 'in die liste', 'zur liste', 'dazu', 'drauf'
];
const ARTICLES = ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'etwas', 'some'];
const CANCEL_ALL = /\b(vergiss es|vergiss das|sag das doch nicht|das doch nicht|streich das|lass es|lass mal|abbrechen|egal)\b/i;
const REMOVE_RE = /^(?:nimm|nehm|lösch|lösche|entfern|entferne|streich|streiche|weg mit)\s+(.+?)(?:\s+(?:runter|weg|raus|von der liste|aus der liste))?$/i;
const REMOVE_TAIL_RE = /^(.+?)\s+(?:runter|weg|raus|streichen|löschen|entfernen)(?:\s+nehmen)?$/i;
// „X nein Y“, „X, ähm nein, Y“, „nicht X, sondern Y“
const CORRECTION_RE = /\b(?:nein|ne|nee|quatsch|ich meine|ich mein|besser|lieber|sondern)\b/i;
const NEGATE_RE = /^(?:nicht|kein|keine|keinen)\s+(.+)$/i;
const TAKE_BACK_RE = /^(?:ach\s+)?(.+?)\s+(?:doch nicht|nicht mehr|lieber nicht|nicht)$/i;

function cleanFillers(s) {
    let out = ' ' + s.toLowerCase() + ' ';
    for (const f of [...FILLERS].sort((a, b) => b.length - a.length)) {
        out = out.replace(new RegExp(`(^|\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'), ' ');
    }
    return out.replace(/\s+/g, ' ').trim();
}

function stripArticles(s) {
    const words = s.split(' ');
    while (words.length > 1 && ARTICLES.includes(words[0])) words.shift();
    return words.join(' ');
}

// Großschreibung wie im Deutschen: Substantive groß, Adjektive vorne klein
const LOWER_WORDS = new Set(['ohne', 'mit', 'für', 'aus', 'von', 'vom', 'zum', 'zur', 'in', 'und']);
function capitalize(name) {
    const words = name.split(' ');
    return words.map((w, i) => {
        const isAdjective = i < words.length - 1 && /(e|er|es|en)$/.test(w) && !LOWER_WORDS.has(words[i + 1]);
        if (LOWER_WORDS.has(w) || isAdjective) return w;
        return w.charAt(0).toLocaleUpperCase('de') + w.slice(1);
    }).join(' ');
}

const COLOR_ADJ = { rote: 'rot', roten: 'rot', roter: 'rot', rot: 'rot', grüne: 'grün', grünen: 'grün', grün: 'grün', gelbe: 'gelb', gelben: 'gelb', gelb: 'gelb' };

function parseItem(raw) {
    let s = stripArticles(raw.trim());
    if (!s) return null;
    let qty = null;
    let count = null;
    const words = s.split(' ');
    // Menge vorne: „2 Liter Milch“, „zwei Liter Milch“, „drei Paprika“
    const n = /^\d+([.,]\d+)?$/.test(words[0]) ? parseFloat(words[0].replace(',', '.')) : NUMBER_WORDS[words[0]];
    if (n && words.length > 1) {
        words.shift();
        const unit = UNITS[words[0]];
        if (unit && words.length > 1) { words.shift(); qty = `${n} ${unit}`; }
        else { count = n; }
    }
    // „Paprika, rote“ → Farbe hinten anhängen
    let color = null;
    const filtered = words.filter(w => {
        if (COLOR_ADJ[w]) { color = COLOR_ADJ[w]; return false; }
        return true;
    });
    let name = filtered.join(' ').trim();
    if (!name || name.length < 2) return null;
    name = capitalize(name);
    if (color) name += ' ' + color;
    if (!qty && count && count > 1) qty = String(count);
    return { name, qty };
}

function splitParts(text) {
    return text
        .replace(/[.!?;]+/g, ',')
        .split(/\s*,\s*|\s+und\s+|\s+sowie\s+|\s+plus\s+|\s+…\s*|\.\.\./i)
        .map(s => s.trim())
        .filter(Boolean);
}

function sameItem(a, b) {
    const na = a.toLocaleLowerCase('de').replace(/e?n$|s$/, '');
    const nb = b.toLocaleLowerCase('de').replace(/e?n$|s$/, '');
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/**
 * @param {string} transcript – gesprochener Text
 * @param {Array<{id:string,name:string}>} current – Produkte auf der Liste
 * @returns {{actions: Array, transcript_clean: string, confidence: number, clarification: string|null}}
 */
export function parseLocally(transcript, current = []) {
    const text = String(transcript || '').trim();
    if (!text) return { actions: [], transcript_clean: '', confidence: 0, clarification: null };
    if (CANCEL_ALL.test(text) && !/[,]|\bund\b/.test(text.replace(CANCEL_ALL, ''))) {
        return { actions: [], transcript_clean: text, confidence: 0.9, clarification: null };
    }

    const actions = [];
    const parts = splitParts(text.replace(CANCEL_ALL, ', __cancel__ ,'));

    for (let part of parts) {
        if (part === '__cancel__') { actions.pop(); continue; }
        let cleaned = cleanFillers(part);
        if (!cleaned) continue;

        // „Drei Paprika, rote“ → Farbe gehört zum vorherigen Produkt
        const last = actions[actions.length - 1];
        if (COLOR_ADJ[cleaned] && last?.type === 'add') {
            if (!last.name.endsWith(' ' + COLOR_ADJ[cleaned])) last.name += ' ' + COLOR_ADJ[cleaned];
            continue;
        }

        // Entfernen: „Nimm die Milch runter“
        const rm = cleaned.match(REMOVE_RE) || cleaned.match(REMOVE_TAIL_RE);
        if (rm) {
            const item = parseItem(cleanFillers(rm[1]));
            if (item) {
                const hit = current.find(p => sameItem(p.name, item.name));
                if (hit) actions.push({ type: 'remove', name: hit.name, id: hit.id, qty: null });
            }
            continue;
        }

        // Rücknahme: „ach das Brot doch nicht“, „nicht Äpfel“
        const tb = cleaned.match(TAKE_BACK_RE) || cleaned.match(NEGATE_RE);
        if (tb) {
            const item = parseItem(cleanFillers(tb[1]));
            if (item) {
                const idx = actions.findIndex(a => a.type === 'add' && sameItem(a.name, item.name));
                if (idx >= 0) actions.splice(idx, 1);
            } else {
                actions.pop();
            }
            continue;
        }

        // Selbstkorrektur innerhalb eines Teils: „Äpfel nein Bananen“ → Bananen
        if (CORRECTION_RE.test(cleaned)) {
            const pieces = cleaned.split(CORRECTION_RE).map(s => s.trim()).filter(Boolean);
            const last = pieces[pieces.length - 1];
            if (pieces.length > 1 && last) {
                cleaned = last;
            } else if (!last) {
                actions.pop();
                continue;
            } else {
                // „nein“ steht am Anfang: vorheriges Produkt war falsch
                actions.pop();
                cleaned = last;
            }
            const neg = cleaned.match(NEGATE_RE);
            if (neg) continue;
        }

        const item = parseItem(cleaned);
        if (item) actions.push({ type: 'add', name: item.name, qty: item.qty, category: null });
    }

    // Doppelte zusammenführen
    const unique = [];
    for (const a of actions) {
        if (!unique.find(u => u.type === a.type && sameItem(u.name, a.name))) unique.push(a);
    }
    return {
        actions: unique.slice(0, 15),
        transcript_clean: text,
        confidence: unique.length ? 0.5 : 0.2,
        clarification: null
    };
}

// Spracheingabe für jede Liste: aufnehmen → verstehen (Worker-KI-Kette) → Chips → übernehmen.
// Ohne Worker oder ohne Internet: Live-Text + lokaler Parser, nur als Vorschlag mit Bestätigung.
import { parseLocally } from './voice-parser.js?v=2.0.0';

// Adresse des eigenen Cloudflare Workers (Gratis-Tarif). Leer = nur lokaler Notfall-Parser.
export const VOICE_WORKER_URL = '';

const MAX_SECONDS = 30;
const SILENCE_MS = 1500;
const NO_SPEECH_MS = 7000;
const AUTO_APPLY_MS = 3000;
const MAX_ACTIONS = 15;

let opts = null;
let state = 'idle'; // idle | recording | thinking | review
let recorder = null;
let stream = null;
let audioCtx = null;
let chunks = [];
let liveRec = null;
let liveText = '';
let rafId = null;
let stopTimer = null;
let autoTimer = null;
let pendingOffline = null;

const $ = (sel) => document.querySelector(sel);

export function initVoice(options) {
    opts = options;
    const wrapper = document.querySelector('.add-product-input-wrapper');
    if (!wrapper || document.getElementById('micBtn')) return;

    const mic = document.createElement('button');
    mic.id = 'micBtn';
    mic.type = 'button';
    mic.className = 'mic-btn';
    mic.setAttribute('aria-label', 'Sprechen: Produkte per Sprache hinzufügen');
    mic.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>
        </svg>`;
    wrapper.insertBefore(mic, wrapper.querySelector('.add-btn'));
    mic.addEventListener('click', () => (state === 'recording' ? stopRecording() : startRecording()));

    const panel = document.createElement('div');
    panel.id = 'voicePanel';
    panel.className = 'voice-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `
        <div class="voice-card">
            <div class="voice-rec">
                <button type="button" class="voice-orb" aria-label="Aufnahme beenden"><span class="voice-orb-ring"></span>
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                </button>
                <p class="voice-status">Ich höre zu …</p>
            </div>
            <p class="voice-transcript"></p>
            <p class="voice-question" hidden></p>
            <div class="voice-chips"></div>
            <div class="voice-timer" hidden><span></span></div>
            <div class="voice-actions">
                <button type="button" class="btn btn-cancel" data-act="cancel">Abbrechen</button>
                <button type="button" class="btn btn-confirm" data-act="apply">Hinzufügen</button>
            </div>
        </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.voice-orb').addEventListener('click', () => { if (state === 'recording') stopRecording(); });
    panel.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') closePanel();
        if (act === 'apply') applyChips();
        if (act === 'retry') { closePanel(); startRecording(); }
        const chip = e.target.closest('.voice-chip');
        if (chip) toggleChip(chip);
    });
    window.addEventListener('online', () => { if (pendingOffline) sendPendingOffline(); });
}

// ===== OBERFLÄCHE =====
function openPanel(mode) {
    const panel = $('#voicePanel');
    panel.dataset.mode = mode;
    panel.classList.add('active');
    $('#micBtn')?.classList.toggle('recording', mode === 'recording');
}

function setStatus(text) { $('#voicePanel .voice-status').textContent = text; }
function setTranscript(text) { $('#voicePanel .voice-transcript').textContent = text ? `„${text}“` : ''; }

function closePanel() {
    clearTimeout(autoTimer);
    if (state === 'recording') cleanupRecording(true);
    state = 'idle';
    const panel = $('#voicePanel');
    panel.classList.remove('active');
    panel.querySelector('.voice-chips').innerHTML = '';
    panel.querySelector('.voice-question').hidden = true;
    panel.querySelector('.voice-timer').hidden = true;
    $('#micBtn')?.classList.remove('recording');
}

// ===== AUFNAHME =====
function pickMimeType() {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
    if (state !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        startLiveOnly();
        return;
    }
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
        opts.showToast('Bitte das Mikrofon erlauben (Einstellungen → Safari/Chrome → Mikrofon).', 5000);
        opts.log('Mikrofon', e);
        return;
    }
    state = 'recording';
    chunks = [];
    liveText = '';
    setTranscript('');
    setStatus('Ich höre zu … sag einfach, was fehlt');
    openPanel('recording');

    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start(250);
    startLiveTranscript();
    watchLevel();
    stopTimer = setTimeout(stopRecording, MAX_SECONDS * 1000);
}

// Pegel anzeigen und nach 1,5 s Stille automatisch stoppen
function watchLevel() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const ring = $('#voicePanel .voice-orb-ring');
        const started = performance.now();
        let lastLoud = 0;
        let heardSpeech = false;
        const tick = () => {
            if (state !== 'recording') return;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
            const rms = Math.sqrt(sum / data.length);
            ring.style.transform = `scale(${1 + Math.min(rms * 6, 0.9)})`;
            const now = performance.now();
            if (rms > 0.035) { lastLoud = now; heardSpeech = true; }
            if (heardSpeech && now - lastLoud > SILENCE_MS) { stopRecording(); return; }
            if (!heardSpeech && now - started > NO_SPEECH_MS) { stopRecording(); return; }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    } catch (e) { opts.log('Pegel', e); }
}

// Live-Text nur zur Anzeige (und als letzte Rückfalloption)
function startLiveTranscript() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
        liveRec = new SR();
        liveRec.lang = 'de-DE';
        liveRec.interimResults = true;
        liveRec.continuous = true;
        liveRec.onresult = (e) => {
            let text = '';
            for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + ' ';
            liveText = text.trim();
            setTranscript(liveText);
        };
        liveRec.onerror = () => {};
        liveRec.start();
    } catch (e) { liveRec = null; }
}

function cleanupRecording(discard = false) {
    cancelAnimationFrame(rafId);
    clearTimeout(stopTimer);
    try { liveRec?.stop(); } catch (e) {}
    liveRec = null;
    if (discard && recorder) recorder.onstop = null;
    try { if (recorder?.state !== 'inactive') recorder.stop(); } catch (e) {}
    stream?.getTracks().forEach(t => t.stop());
    try { audioCtx?.close(); } catch (e) {}
    stream = null;
    audioCtx = null;
}

function stopRecording() {
    if (state !== 'recording') return;
    state = 'thinking';
    $('#micBtn')?.classList.remove('recording');
    setStatus('Einen Moment, ich verstehe …');
    $('#voicePanel').dataset.mode = 'thinking';
    cleanupRecording(false);
}

// Ohne MediaRecorder: nur Web-Speech-Live-Text (Stufe D)
function startLiveOnly() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { opts.showToast('Spracheingabe wird von diesem Browser nicht unterstützt.', 4000); return; }
    state = 'recording';
    liveText = '';
    setTranscript('');
    setStatus('Ich höre zu …');
    openPanel('recording');
    startLiveTranscript();
    liveRec.continuous = false;
    liveRec.onend = () => {
        if (state !== 'recording') return;
        state = 'thinking';
        showResult(localUnderstanding(), { suggestion: true });
    };
}

async function onRecordingStopped() {
    const type = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
    const blob = new Blob(chunks, { type });
    recorder = null;
    if (blob.size < 2000 && !liveText) {
        showNothing('Ich habe nichts gehört. Tippe aufs Mikrofon und versuch es nochmal.');
        return;
    }
    if (!VOICE_WORKER_URL) {
        showResult(localUnderstanding(), { suggestion: true });
        return;
    }
    if (!navigator.onLine) {
        if (liveText) showResult(localUnderstanding(), { suggestion: true });
        else {
            pendingOffline = { blob, type };
            showNothing('Kein Internet – ich schicke die Aufnahme, sobald du wieder online bist.');
        }
        return;
    }
    try {
        const result = await sendToWorker(blob, type);
        showResult(result, { suggestion: false });
    } catch (e) {
        opts.log('Sprache', e);
        if (liveText) showResult(localUnderstanding(), { suggestion: true, note: 'KI gerade nicht erreichbar – bitte prüfen.' });
        else showNothing('Das hat nicht geklappt. Bitte nochmal versuchen oder eintippen.');
    }
}

async function sendPendingOffline() {
    const p = pendingOffline;
    pendingOffline = null;
    try {
        const result = await sendToWorker(p.blob, p.type);
        if (state === 'idle') { state = 'thinking'; openPanel('thinking'); }
        showResult(result, { suggestion: false });
    } catch (e) { opts.log('Sprache später', e); }
}

function localUnderstanding() {
    return { ...parseLocally(liveText, opts.getProducts()), transcript: liveText, provider: 'lokal' };
}

// ===== WORKER (KI-KETTE) =====
async function sendToWorker(blob, type, attempt = 0) {
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('audio', blob, `befehl.${ext}`);
    form.append('products', JSON.stringify(opts.getProducts().map(p => ({ id: p.id, name: p.name, qty: p.qty || null }))));
    form.append('categories', JSON.stringify(opts.getCategories().map(c => ({ id: c.id, name: c.name }))));
    form.append('knownNames', JSON.stringify(opts.getKnownNames()));
    form.append('liveText', liveText || '');
    form.append('familyId', opts.getFamilyId() || '');
    const headers = {};
    const token = await opts.getIdToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
        const res = await fetch(VOICE_WORKER_URL.replace(/\/$/, '') + '/voice', { method: 'POST', body: form, headers, signal: controller.signal });
        if (res.status === 429) throw new Error('Limit erreicht');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!isValidResult(json)) {
            if (attempt === 0) return sendToWorker(blob, type, 1);
            throw new Error('Ungültige Antwort');
        }
        return json;
    } finally {
        clearTimeout(timeout);
    }
}

function isValidResult(r) {
    return r && Array.isArray(r.actions) && r.actions.every(a =>
        a && ['add', 'remove', 'update_qty'].includes(a.type) && typeof a.name === 'string' && a.name.trim().length > 0
    );
}

// ===== PRÜFUNG + CHIPS =====
function norm(s) { return String(s || '').toLocaleLowerCase('de').trim(); }
function stem(s) { return norm(s).replace(/(en|n|e|s)$/, ''); }

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[m][n];
}

function findOnList(action) {
    const products = opts.getProducts();
    if (action.id) { const byId = products.find(p => p.id === action.id); if (byId) return byId; }
    const n = norm(action.name);
    return products.find(p => norm(p.name) === n)
        || products.find(p => stem(p.name) === stem(action.name))
        || products.find(p => levenshtein(norm(p.name), n) <= 2 && n.length > 3);
}

function buildChips(result) {
    const chips = [];
    const seen = new Set();
    for (const a of result.actions.slice(0, MAX_ACTIONS)) {
        const name = a.name.trim();
        const key = a.type + '|' + stem(name);
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = findOnList(a);
        if (a.type === 'remove') {
            if (existing) chips.push({ type: 'remove', name: existing.name, id: existing.id, on: true });
            else chips.push({ type: 'missing', name, on: false });
        } else if (a.type === 'update_qty' || (a.type === 'add' && existing)) {
            // Schon da → Menge anpassen statt doppelt anlegen
            if (existing && a.qty && a.qty !== existing.qty) chips.push({ type: 'qty', name: existing.name, id: existing.id, qty: a.qty, oldQty: existing.qty || null, on: true });
            else if (existing) chips.push({ type: 'exists', name: existing.name, on: false });
            else chips.push({ type: 'add', name, qty: a.qty || null, category: a.category, on: true });
        } else {
            chips.push({ type: 'add', name, qty: a.qty || null, category: a.category, on: true });
        }
    }
    return chips;
}

let currentChips = [];

function chipLabel(c) {
    const qty = c.qty ? ` ${c.qty}` : '';
    switch (c.type) {
        case 'add': return `+ ${c.name}${qty}`;
        case 'remove': return `− ${c.name}`;
        case 'qty': return `${c.name}: ${c.qty}`;
        case 'exists': return `${c.name} ist schon da`;
        case 'missing': return `${c.name} nicht auf der Liste`;
        default: return c.name;
    }
}

function renderChips() {
    const box = $('#voicePanel .voice-chips');
    box.innerHTML = currentChips.map((c, i) => `
        <button type="button" class="voice-chip ${c.type} ${c.on ? 'on' : 'off'}" data-i="${i}" ${['exists', 'missing'].includes(c.type) ? 'disabled' : ''}
            aria-pressed="${c.on}">${escapeText(chipLabel(c))}${c.on ? ' ✓' : ''}</button>`).join('');
    const active = currentChips.filter(c => c.on).length;
    $('#voicePanel [data-act="apply"]').disabled = active === 0;
    $('#voicePanel [data-act="apply"]').textContent = active ? `Übernehmen (${active})` : 'Übernehmen';
}

function escapeText(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function toggleChip(el) {
    const c = currentChips[Number(el.dataset.i)];
    if (!c || ['exists', 'missing'].includes(c.type)) return;
    stopAutoApply();
    if (c.on && c.type === 'add') {
        // Zweites Antippen eines aktiven Chips: Namen bearbeiten
        const edited = prompt('Produkt bearbeiten (leer = weglassen):', c.name + (c.qty ? ' ' + c.qty : ''));
        if (edited === null) return;
        if (!edited.trim()) c.on = false;
        else { c.name = edited.trim(); c.qty = null; }
    } else {
        c.on = !c.on;
    }
    renderChips();
}

function stopAutoApply() {
    clearTimeout(autoTimer);
    const timer = $('#voicePanel .voice-timer');
    timer.hidden = true;
}

function showNothing(message) {
    state = 'review';
    currentChips = [];
    openPanel('review');
    setStatus(message);
    $('#voicePanel .voice-chips').innerHTML = `<button type="button" class="btn btn-confirm voice-retry" data-act="retry">Nochmal sprechen</button>`;
    $('#voicePanel [data-act="apply"]').hidden = true;
}

function showResult(result, { suggestion, note } = {}) {
    state = 'review';
    openPanel('review');
    $('#voicePanel [data-act="apply"]').hidden = false;
    setTranscript(result.transcript_clean || result.transcript || liveText);
    currentChips = buildChips(result);
    const question = $('#voicePanel .voice-question');
    const removals = currentChips.filter(c => c.type === 'remove' && c.on).length;

    if (!currentChips.length) {
        showNothing(result.clarification || 'Ich habe kein Produkt verstanden. Versuch es nochmal, z. B. „Milch und Brot“.');
        setTranscript(result.transcript_clean || result.transcript || liveText);
        return;
    }

    const unsure = suggestion || (typeof result.confidence === 'number' && result.confidence < 0.6) || result.clarification || removals > 3;
    question.hidden = !unsure;
    question.textContent = result.clarification
        || (removals > 3 ? `Wirklich ${removals} Produkte entfernen?` : '')
        || note
        || (suggestion ? 'Bitte kurz prüfen – stimmt das so?' : 'Ich bin mir nicht ganz sicher – stimmt das so?');
    setStatus(suggestion ? 'Vorschlag' : 'Verstanden');
    renderChips();

    if (!unsure) {
        const timer = $('#voicePanel .voice-timer');
        timer.hidden = false;
        const bar = timer.querySelector('span');
        bar.style.transition = 'none';
        bar.style.width = '100%';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            bar.style.transition = `width ${AUTO_APPLY_MS}ms linear`;
            bar.style.width = '0%';
        }));
        autoTimer = setTimeout(applyChips, AUTO_APPLY_MS);
    }
}

// ===== ÜBERNEHMEN + RÜCKGÄNGIG =====
function applyChips() {
    clearTimeout(autoTimer);
    const chosen = currentChips.filter(c => c.on);
    if (!chosen.length) { closePanel(); return; }
    const added = [];
    const removed = [];
    const qtyChanges = [];
    for (const c of chosen) {
        if (c.type === 'add') {
            const category = c.category && opts.getCategories().some(k => k.id === c.category) ? c.category : opts.detectCategory(c.name);
            const id = opts.addProduct(c.name, category, c.qty);
            if (id) added.push(id);
        } else if (c.type === 'remove') {
            removed.push(c.id);
        } else if (c.type === 'qty') {
            opts.updateProduct(c.id, { qty: c.qty });
            qtyChanges.push({ id: c.id, qty: c.oldQty });
        }
    }
    if (removed.length) opts.removeProducts(removed);
    closePanel();
    const n = added.length + removed.length + qtyChanges.length;
    opts.showUndo(`${n} ${n === 1 ? 'Änderung' : 'Änderungen'} per Sprache`, () => {
        if (added.length) opts.removeProducts(added);
        if (removed.length) opts.restoreProducts(removed);
        qtyChanges.forEach(q => opts.updateProduct(q.id, { qty: q.qty }));
    });
}

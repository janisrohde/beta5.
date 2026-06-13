import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getFirestore,
    collection,
    doc,
    getDocs,
    setDoc,
    query,
    where
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

// Bereits angemeldete Nutzer direkt weiterleiten
const _session = JSON.parse(localStorage.getItem('auth_session') || 'null');
if (_session && _session.familyId) {
    window.location.href = 'index.html';
}

// Passwort mit SHA-256 hashen (Benutzername als Salt)
async function hashPassword(username, password) {
    const raw = username.toLowerCase() + ':' + password + ':einkaufsliste-app';
    const data = new TextEncoder().encode(raw);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== BRUTE-FORCE-SCHUTZ =====
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 60 * 1000; // 60 Sekunden

function getRateData(username) {
    try { return JSON.parse(localStorage.getItem('rl_' + username.toLowerCase()) || 'null'); }
    catch { return null; }
}

function isLockedOut(username) {
    const d = getRateData(username);
    if (!d) return false;
    if (d.until && Date.now() < d.until) return d.until;
    if (d.until && Date.now() >= d.until) { localStorage.removeItem('rl_' + username.toLowerCase()); }
    return false;
}

function recordFailedAttempt(username) {
    const key = 'rl_' + username.toLowerCase();
    const d = getRateData(username) || { attempts: 0, until: 0 };
    d.attempts = (d.attempts || 0) + 1;
    if (d.attempts >= MAX_ATTEMPTS) d.until = Date.now() + LOCKOUT_MS;
    localStorage.setItem(key, JSON.stringify(d));
}

function clearRateLimit(username) {
    localStorage.removeItem('rl_' + username.toLowerCase());
}

// ===== HILFSFUNKTIONEN =====
function showError(msg) {
    const el = document.getElementById('authError');
    el.textContent = msg;
    el.style.display = 'block';
}

function hideError() {
    const el = document.getElementById('authError');
    el.textContent = '';
    el.style.display = 'none';
}

function setBtn(id, text, disabled) {
    const btn = document.getElementById(id);
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.6' : '1';
}

// ===== TAB-UMSCHALTEN =====
document.getElementById('loginTab').addEventListener('click', () => {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('loginTab').classList.add('active');
    document.getElementById('registerTab').classList.remove('active');
    hideError();
});

document.getElementById('registerTab').addEventListener('click', () => {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
    document.getElementById('loginTab').classList.remove('active');
    document.getElementById('registerTab').classList.add('active');
    hideError();
});

// ===== ANMELDUNG =====
async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!username) { showError('Bitte Benutzernamen eingeben.'); return; }
    if (!password) { showError('Bitte Passwort eingeben.'); return; }

    const lockUntil = isLockedOut(username);
    if (lockUntil) {
        const secs = Math.ceil((lockUntil - Date.now()) / 1000);
        showError(`Zu viele Versuche. Bitte ${secs} Sekunden warten.`);
        return;
    }

    hideError();
    setBtn('loginBtn', 'Anmelden…', true);

    try {
        const snap = await getDocs(query(collection(db, 'users'), where('username', '==', username.toLowerCase())));
        if (snap.empty) {
            recordFailedAttempt(username);
            showError('Benutzername oder Passwort ist falsch.');
            setBtn('loginBtn', 'Anmelden', false);
            return;
        }

        const userDoc = snap.docs[0];
        const userData = userDoc.data();
        const hash = await hashPassword(username, password);

        if (userData.passwordHash !== hash) {
            recordFailedAttempt(username);
            showError('Benutzername oder Passwort ist falsch.');
            setBtn('loginBtn', 'Anmelden', false);
            return;
        }

        clearRateLimit(username);
        const SESSION_DAYS = 30;
        localStorage.setItem('auth_session', JSON.stringify({
            uid: userDoc.id,
            username: userData.username,
            displayName: userData.displayName || userData.username,
            familyId: userData.familyId,
            expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
        }));

        window.location.href = 'index.html';
    } catch (e) {
        showError('Anmeldung fehlgeschlagen. Bitte Internetverbindung prüfen.');
        setBtn('loginBtn', 'Anmelden', false);
    }
}

// ===== REGISTRIERUNG =====
async function doRegister() {
    const username = document.getElementById('registerUsername').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;

    if (!username) { showError('Bitte Benutzernamen eingeben.'); return; }
    if (username.length < 3) { showError('Benutzername muss mindestens 3 Zeichen lang sein.'); return; }
    if (!/^[a-zA-Z0-9_\-\.äöüÄÖÜß ]+$/.test(username)) {
        showError('Ungültige Zeichen im Benutzernamen.');
        return;
    }
    if (!password) { showError('Bitte Passwort festlegen.'); return; }
    if (password.length < 6) { showError('Passwort muss mindestens 6 Zeichen lang sein.'); return; }
    if (password !== passwordConfirm) { showError('Die Passwörter stimmen nicht überein.'); return; }

    hideError();
    setBtn('registerBtn', 'Konto wird erstellt…', true);

    try {
        // Benutzername auf Verfügbarkeit prüfen
        const snap = await getDocs(query(collection(db, 'users'), where('username', '==', username.toLowerCase())));
        if (!snap.empty) {
            showError('Dieser Benutzername ist bereits vergeben.');
            setBtn('registerBtn', 'Konto erstellen', false);
            return;
        }

        const hash = await hashPassword(username, password);
        const uid = crypto.randomUUID();

        await setDoc(doc(db, 'users', uid), {
            username: username.toLowerCase(),
            displayName: username,
            passwordHash: hash,
            familyId: uid,
            createdAt: new Date().toISOString()
        });

        const SESSION_DAYS = 30;
        localStorage.setItem('auth_session', JSON.stringify({
            uid: uid,
            username: username.toLowerCase(),
            displayName: username,
            familyId: uid,
            expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
        }));

        window.location.href = 'index.html';
    } catch (e) {
        showError('Registrierung fehlgeschlagen. Bitte Internetverbindung prüfen.');
        setBtn('registerBtn', 'Konto erstellen', false);
    }
}

// ===== EVENT LISTENER =====
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('registerBtn').addEventListener('click', doRegister);

document.getElementById('loginUsername').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginPassword').focus();
});
document.getElementById('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
});
document.getElementById('registerUsername').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerPassword').focus();
});
document.getElementById('registerPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerPasswordConfirm').focus();
});
document.getElementById('registerPasswordConfirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRegister();
});

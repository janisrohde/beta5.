// Schlüssel für das Foto-Gedächtnis: gleicher Produktname → gleiches Foto.
// „Zahnbürsten“, „zahnbürsten “ und „Zahnbürste“ ergeben denselben Schlüssel.
export function photoKey(name) {
    let k = String(name || '').toLocaleLowerCase('de').trim().replace(/\s+/g, ' ');
    // einfache Mehrzahl angleichen: Zahnbürsten → zahnbürste, Bananen → banane,
    // Batterien → batterie, Joghurts → joghurt; Eier bleibt eier
    if (k.length > 4) k = k.replace(/en$/, 'e').replace(/([^s])s$/, '$1');
    k = k.replace(/[\/#?\[\]]/g, '_');
    if (!k || k === '.' || k === '..') k = '_';
    return k.slice(0, 120);
}

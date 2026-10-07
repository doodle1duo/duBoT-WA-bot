// =============================================================================
// 👑 PREMIUM MANAGER — Sistema de Claves, Beneficios VIP y Tickets Express
// DUbot v1.9+ | ESM
// =============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const KEYS_FILE = path.join(process.cwd(), 'premium_keys.json');
const TICKETS_FILE = path.join(process.cwd(), 'tickets.json');

// ─── JSON STORAGE UTILITIES ──────────────────────────────────────────────────
function readJson(file, def = {}) {
    try {
        if (!fs.existsSync(file)) return def;
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data || '{}');
    } catch (_) {
        return def;
    }
}

function saveJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error(`[PremiumManager] Error guardando ${file}:`, e.message);
    }
}

// ─── DURATION PARSER ─────────────────────────────────────────────────────────
export function parseDuration(str = '30d') {
    const s = String(str).toLowerCase().trim();
    if (['perm', 'permanente', 'inf', 'infinity', 'siempre'].includes(s)) {
        return { ms: Infinity, label: 'Permanente' };
    }
    const match = s.match(/^(\d+)\s*(m|min|h|d|w|mes|y)?$/);
    if (!match) {
        return { ms: 30 * 24 * 3600 * 1000, label: '30 días' };
    }
    const val = parseInt(match[1]);
    const unit = match[2] || 'd';
    switch (unit) {
        case 'm':
        case 'min':
            return { ms: val * 60 * 1000, label: `${val} minuto(s)` };
        case 'h':
            return { ms: val * 3600 * 1000, label: `${val} hora(s)` };
        case 'd':
            return { ms: val * 24 * 3600 * 1000, label: `${val} día(s)` };
        case 'w':
            return { ms: val * 7 * 24 * 3600 * 1000, label: `${val} semana(s)` };
        case 'mes':
            return { ms: val * 30 * 24 * 3600 * 1000, label: `${val} mes(es)` };
        case 'y':
            return { ms: val * 365 * 24 * 3600 * 1000, label: `${val} año(s)` };
        default:
            return { ms: val * 24 * 3600 * 1000, label: `${val} día(s)` };
    }
}

// ─── KEY GENERATOR ───────────────────────────────────────────────────────────
function randomChunk(len = 4) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) {
        res += chars[bytes[i] % chars.length];
    }
    return res;
}

export function generateKeyString(prefix = 'PREM') {
    return `${prefix}-${randomChunk(4)}-${randomChunk(4)}-${randomChunk(4)}`;
}

export function generatePremiumKey({
    tier = 'premium',
    duration = '30d',
    createdBy = 'admin',
    isGift = false,
    gifterJid = null,
    prefix = 'PREM'
}) {
    const keysDb = readJson(KEYS_FILE, {});
    const durInfo = parseDuration(duration);
    const keyStr = generateKeyString(prefix);

    const keyObj = {
        key: keyStr,
        tier: tier.toLowerCase(),
        durationMs: durInfo.ms,
        durationStr: durInfo.label,
        createdAt: Date.now(),
        createdBy: createdBy || 'admin',
        isGift: Boolean(isGift),
        gifterJid: gifterJid || null,
        used: false,
        usedBy: null,
        usedAt: null
    };

    keysDb[keyStr] = keyObj;
    saveJson(KEYS_FILE, keysDb);
    return keyObj;
}

export function getPremiumKey(keyStr) {
    if (!keyStr) return null;
    const cleanKey = String(keyStr).trim().toUpperCase();
    const keysDb = readJson(KEYS_FILE, {});
    return keysDb[cleanKey] || null;
}

export function listPremiumKeys(filter = 'all') {
    const keysDb = readJson(KEYS_FILE, {});
    const list = Object.values(keysDb);
    if (filter === 'active' || filter === 'unused') {
        return list.filter(k => !k.used);
    }
    if (filter === 'used') {
        return list.filter(k => k.used);
    }
    return list;
}

export function revokePremiumKey(keyStr) {
    const cleanKey = String(keyStr).trim().toUpperCase();
    const keysDb = readJson(KEYS_FILE, {});
    if (keysDb[cleanKey]) {
        delete keysDb[cleanKey];
        saveJson(KEYS_FILE, keysDb);
        return true;
    }
    return false;
}

// ─── REDEEM KEY ──────────────────────────────────────────────────────────────
export function redeemPremiumKey(user, senderJid, keyStr) {
    const cleanKey = String(keyStr).trim().toUpperCase();
    const keysDb = readJson(KEYS_FILE, {});
    const keyObj = keysDb[cleanKey];

    if (!keyObj) {
        return { success: false, reason: 'Clave no encontrada o inválida.' };
    }
    if (keyObj.used) {
        return { success: false, reason: `Esta clave ya fue canjeada por @${keyObj.usedBy?.split('@')[0] || 'otro usuario'}.` };
    }

    // Inicializar objeto premium en el usuario si no existe
    if (!user.premium) {
        user.premium = {
            active: false,
            tier: 'free',
            expiresAt: 0,
            customPrefix: null,
            customWelcome: null
        };
    }

    const now = Date.now();
    let newExpiresAt = 0;

    if (keyObj.durationMs === Infinity) {
        newExpiresAt = Infinity;
    } else {
        if (user.premium.active && user.premium.expiresAt && user.premium.expiresAt > now) {
            // Extender tiempo si ya tenía premium activo
            newExpiresAt = user.premium.expiresAt + keyObj.durationMs;
        } else {
            newExpiresAt = now + keyObj.durationMs;
        }
    }

    user.premium.active = true;
    user.premium.tier = keyObj.tier || 'premium';
    user.premium.expiresAt = newExpiresAt;

    // Marcar clave como usada
    keyObj.used = true;
    keyObj.usedBy = senderJid;
    keyObj.usedAt = now;
    saveJson(KEYS_FILE, keysDb);

    // 🎁 INCENTIVO 2x1 (Recompensa por Regalar):
    // Si la clave era un regalo y tiene gifterJid, generamos una clave de recompensa VIP para el gifter!
    let bonusKey = null;
    if (keyObj.isGift && keyObj.gifterJid && keyObj.gifterJid !== senderJid) {
        bonusKey = generatePremiumKey({
            tier: 'vip',
            duration: '7d', // 7 días de regalo para quien obsequió
            createdBy: 'RECOMPENSA_2X1',
            isGift: false,
            gifterJid: null,
            prefix: 'GIFT-VIP'
        });
    }

    return {
        success: true,
        key: keyObj,
        tier: user.premium.tier,
        durationStr: keyObj.durationStr,
        expiresAt: newExpiresAt,
        bonusKey
    };
}

// ─── PREMIUM VERIFICATIONS & BENEFITS ─────────────────────────────────────────
export function isUserPremium(user) {
    if (!user || !user.premium) return false;
    if (!user.premium.active) return false;
    if (user.premium.expiresAt === Infinity || user.premium.expiresAt === null) return true;
    if (typeof user.premium.expiresAt === 'number' && user.premium.expiresAt > Date.now()) {
        return true;
    }
    // Expirado
    user.premium.active = false;
    return false;
}

export function getPremiumMultiplier(user) {
    if (!isUserPremium(user)) return 1.0;
    const tier = (user.premium.tier || 'premium').toLowerCase();
    if (tier === 'sponsor' || tier === 'supremo') return 3.0; // Triplica recompensas
    return 2.0; // Duplica recompensas (Nivel Premium Estándar)
}

export function getPremiumCooldownReduction(user) {
    if (!isUserPremium(user)) return 0;
    return 0.5; // 50% de reducción en cooldowns
}

export function getRemainingPremiumTime(user) {
    if (!isUserPremium(user)) return 'Inactivo';
    if (user.premium.expiresAt === Infinity || user.premium.expiresAt === null) return 'Permanente ♾️';
    const msLeft = user.premium.expiresAt - Date.now();
    if (msLeft <= 0) return 'Expirado';
    const d = Math.floor(msLeft / (24 * 3600000));
    const h = Math.floor((msLeft % (24 * 3600000)) / 3600000);
    const m = Math.floor((msLeft % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h restantes`;
    if (h > 0) return `${h}h ${m}m restantes`;
    return `${m} min restantes`;
}

// ─── TICKETS DE SOPORTE EXPRESS ──────────────────────────────────────────────
export function createTicket(senderJid, senderName, messageText, isPriority = false) {
    const ticketsDb = readJson(TICKETS_FILE, { nextId: 100, tickets: [] });
    const ticketId = `TK-${ticketsDb.nextId++}`;

    const ticket = {
        id: ticketId,
        sender: senderJid,
        senderName: senderName || senderJid.split('@')[0],
        message: messageText.trim(),
        isPriority: Boolean(isPriority),
        status: 'open', // open, answered, closed
        createdAt: Date.now(),
        replies: []
    };

    ticketsDb.tickets.unshift(ticket);
    // Limitar histórico a 100 tickets
    if (ticketsDb.tickets.length > 100) ticketsDb.tickets = ticketsDb.tickets.slice(0, 100);
    saveJson(TICKETS_FILE, ticketsDb);

    return ticket;
}

export function replyTicket(ticketId, adminJid, replyText) {
    const cleanId = String(ticketId).trim().toUpperCase();
    const ticketsDb = readJson(TICKETS_FILE, { nextId: 100, tickets: [] });
    const ticket = ticketsDb.tickets.find(t => t.id === cleanId || t.sender === ticketId || t.sender.split('@')[0] === ticketId.replace(/[^0-9]/g, ''));
    if (!ticket) return null;

    ticket.status = 'answered';
    ticket.replies.push({
        from: adminJid,
        text: replyText.trim(),
        timestamp: Date.now()
    });

    saveJson(TICKETS_FILE, ticketsDb);
    return ticket;
}

export function closeTicket(ticketId) {
    const cleanId = String(ticketId).trim().toUpperCase();
    const ticketsDb = readJson(TICKETS_FILE, { nextId: 100, tickets: [] });
    const ticket = ticketsDb.tickets.find(t => t.id === cleanId);
    if (!ticket) return null;

    ticket.status = 'closed';
    saveJson(TICKETS_FILE, ticketsDb);
    return ticket;
}

export function getOpenTickets() {
    const ticketsDb = readJson(TICKETS_FILE, { nextId: 100, tickets: [] });
    return ticketsDb.tickets.filter(t => t.status !== 'closed');
}
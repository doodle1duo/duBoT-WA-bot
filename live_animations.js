/**
 * live_animations.js
 * Módulo de Animaciones en Tiempo Real para DUbot (Super Admin Abuse & Eventos).
 * Permite al creador/admins reproducir animaciones interactivas editadas en vivo
 * segundo a segundo en los chats de WhatsApp con duración configurable.
 */

// Mapa de animaciones activas por JID de chat
export const activeAnimations = new Map();

/**
 * Parsea duraciones como '15s', '30', '1m', '2m30s', etc.
 * @param {string} str - Cadena de duración
 * @param {number} defaultSec - Segundos por defecto si no se especifica
 * @returns {number} Segundos totales (clamped entre 5 y 600)
 */
export function parseAnimationDuration(str, defaultSec = 15) {
    if (!str) return defaultSec;
    const clean = str.trim().toLowerCase();
    
    // Si es solo un número puro
    if (/^\d+$/.test(clean)) {
        const val = parseInt(clean, 10);
        return Math.max(4, Math.min(600, isNaN(val) ? defaultSec : val));
    }

    let totalSeconds = 0;
    const minMatch = clean.match(/(\d+)\s*m/);
    const secMatch = clean.match(/(\d+)\s*s/);

    if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
    if (secMatch) totalSeconds += parseInt(secMatch[1], 10);

    if (totalSeconds <= 0) totalSeconds = defaultSec;
    return Math.max(4, Math.min(600, totalSeconds));
}

/**
 * Formatea segundos a mm:ss
 */
export function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Genera una barra de progreso de texto
 */
export function renderProgressBar(current, total, length = 10, fillChar = '█', emptyChar = '░') {
    const ratio = Math.max(0, Math.min(1, current / total));
    const filledCount = Math.round(ratio * length);
    const emptyCount = length - filledCount;
    return `${fillChar.repeat(filledCount)}${emptyChar.repeat(emptyCount)}`;
}

// ==========================================
// 🎨 GENERADORES DE FRAMES POR TIPO DE ANIMACIÓN
// ==========================================

export const ANIMATION_PRESETS = {
    // ⏳ 1. RELOJ DE ARENA
    reloj: {
        name: 'Reloj de Arena',
        desc: 'Reloj clásico con arena cayendo y cuenta regresiva personalizable.',
        defaultSec: 20,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const isFinished = remaining <= 0;

            if (isFinished) {
                return (
`⌛ *[ RELOJ DE ARENA DEL TIEMPO ]*
╭─────────────────────╮
│      ░░░░░░░░░      │
│       \\     /       │
│        \\   /        │
│         ><          │
│        /   \\        │
│       /█████\\       │
│      █████████      │
╰─────────────────────╯
🎉🔔 *¡¡¡EL TIEMPO SE HA AGOTADO!!!* 🔔🎉
${customText ? `\n📢 *Mensaje:* ${customText}\n` : ''}
⏱️ *Duración total cumplida:* ${formatTime(total)}`
                );
            }

            // Niveles de arena según progreso
            const topLevels = ['█████████', ' ███████ ', '  █████  ', '   ███   ', '    █    ', '         '];
            const botLevels = ['         ', '    █    ', '   ███   ', '  █████  ', ' ███████ ', '█████████'];
            
            const stage = Math.min(5, Math.floor(ratio * 6));
            const topStr = topLevels[stage];
            const botStr = botLevels[stage];
            const dripChar = (step % 2 === 0) ? '⁝' : '│';
            const icon = (step % 2 === 0) ? '⏳' : '⌛';

            const bar = renderProgressBar(remaining, total, 10, '█', '░');
            const percent = Math.round((remaining / total) * 100);

            return (
`${icon} *[ RELOJ DE ARENA DEL TIEMPO ]*
╭─────────────────────╮
│     ${topStr}     │
│       \\     /       │
│        \\   /        │
│         >${dripChar}<         │
│        /   \\        │
│       /${botStr}\\       │
╰─────────────────────╯
⏳ *Restante:* ${formatTime(remaining)} (${percent}%)
📊 *Progreso:* [${bar}]
${customText ? `\n💬 _${customText}_\n` : ''}
_⏱️ Tic-tac en tiempo real..._`
            );
        }
    },

    // 💣 2. BOMBA DE TIEMPO
    bomba: {
        name: 'Bomba con Mecha',
        desc: 'Bomba de dinamita con mecha chispeante y detonación final.',
        defaultSec: 15,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const isFinished = remaining <= 0;

            if (isFinished) {
                return (
`💥💥💥 *¡¡¡¡¡BOOOOOOOOOOOMMMMMMM!!!!!* 💥💥💥
      (  .      )
   )           (
  (     💥     )
    '..___..'
💀 *¡¡¡LA BOMBA HA DETONADO CON ÉXITO!!!*
${customText ? `\n📢 *Impacto:* ${customText}\n` : ''}
⏱️ *Tiempo detonado:* ${formatTime(total)}`
                );
            }

            const sparkSymbols = ['🔥', '✨', '⚡', '💥'];
            const spark = sparkSymbols[step % sparkSymbols.length];
            const maxFuse = 12;
            const remainingFuse = Math.max(1, Math.round((1 - ratio) * maxFuse));
            const fuseLine = '═'.repeat(remainingFuse) + spark;

            return (
`💣 *[ BOMBA DE TIEMPO ACTIVA ]*
   
   💣${fuseLine}
   
⏱️ *Detonación en:* *${formatTime(remaining)}*
⚠️ *Estado:* ¡LA MECHA SE ESTÁ CONSUMIENDO!
${customText ? `\n💬 _${customText}_\n` : ''}
_🚨 ¡Cuidado antes de que explote!_`
            );
        }
    },

    // 📦 3. COFRE DEL TESORO / AIRDROP
    cofre: {
        name: 'Cofre Legendario / Airdrop',
        desc: 'Cofre blindado que se desbloquea gradualmente hasta abrirse.',
        defaultSec: 18,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const isFinished = remaining <= 0;

            if (isFinished) {
                return (
`✨👑💎 *¡¡¡COFRE LEGENDARIO ABIERTO!!!* 💎👑✨
      ╔══════════╗
      ║  ✨💰✨  ║
      ╚══════════╝
🔓 *¡Cerraduras desintegradas con éxito!*
${customText ? `\n🎁 *CONTENIDO DEL BOTÍN:*\n${customText}\n` : '\n🎁 *Premio:* ¡El tesoro ha sido liberado para todos!\n'}
✨ _¡Felicidades a los afortunados!_`
                );
            }

            let status = '';
            let boxArt = '';
            const shake = (step % 2 === 0) ? '⟨📦⟩' : '⟦📦⟧';

            if (ratio < 0.3) {
                status = '🔒 Cerrado con 3 candados de titanio...';
                boxArt = `🔒🔒🔒\n     ${shake}`;
            } else if (ratio < 0.6) {
                status = '🔑 1° Candado roto... El cofre vibra con fuerza!';
                boxArt = `🔓🔒🔒\n    ⚡${shake}⚡`;
            } else if (ratio < 0.85) {
                status = '✨ 2° Candado destruido... Emana un brillo dorado!';
                boxArt = `🔓🔓🔒\n   ✨🌟${shake}🌟✨`;
            } else {
                status = '🔓 ¡Último candado cediendo! La tapa se abre...';
                boxArt = `🔓🔓🔓\n   💥🔥${shake}🔥💥`;
            }

            const bar = renderProgressBar(elapsed, total, 10, '▰', '▱');

            return (
`📦 *[ DESBLOQUEO DE COFRE MISTERIOSO ]*

${boxArt}

🛡️ *Fase:* ${status}
⏳ *Tiempo de apertura:* ${formatTime(remaining)}
📊 *Progreso:* [${bar}]
${customText ? `\n💬 _${customText}_\n` : ''}`
            );
        }
    },

    // 🎰 4. TRAGAMONEDAS / SLOTS EN VIVO
    slots: {
        name: 'Tragaperras en Vivo',
        desc: 'Carretes de casino girando en tiempo real hasta dar premio.',
        defaultSec: 15,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const isFinished = remaining <= 0;

            const symbols = ['🍒', '🍋', '⭐', '💎', '7️⃣', '🔔'];
            const getRandom = () => symbols[Math.floor(Math.random() * symbols.length)];

            if (isFinished) {
                return (
`🎰🎰🎰 *¡¡¡JACKPOT SUPREMO EN VIVO!!!* 🎰🎰🎰
╔══════════════════╗
║   💎 | 💎 | 💎   ║  ➔ 🌟 ¡GANADOR!
╚══════════════════╝
🎉🎉 *¡LOS RODILLOS SE DETUVIERON EN EL PREMIO MAYOR!* 🎉🎉
${customText ? `\n🏆 *Recompensa:* ${customText}\n` : ''}
⏱️ *Giro finalizado con éxito.*`
                );
            }

            let reel1, reel2, reel3;
            if (ratio < 0.4) {
                // Todos giran
                reel1 = getRandom();
                reel2 = getRandom();
                reel3 = getRandom();
            } else if (ratio < 0.7) {
                // Rodillo 1 frenado en 💎
                reel1 = '💎';
                reel2 = getRandom();
                reel3 = getRandom();
            } else {
                // Rodillo 1 y 2 frenados en 💎
                reel1 = '💎';
                reel2 = '💎';
                reel3 = getRandom();
            }

            const spinAnim = (step % 2 === 0) ? '💫' : '✨';

            return (
`🎰 *[ CASINO EN VIVO — RODILLOS GIRANDO ]*
╔══════════════════╗
║   ${reel1} | ${reel2} | ${reel3}   ║  ${spinAnim}
╚══════════════════╝
🎲 *Estado:* Girando a toda velocidad...
⏱️ *Frenando en:* ${formatTime(remaining)}
${customText ? `\n💬 _${customText}_\n` : ''}
_¡Crucen los dedos por el Jackpot!_`
            );
        }
    },

    // ⚡ 5. HACKEO / FRENESÍ CIBERNÉTICO
    hack: {
        name: 'Sobrecarga de Servidor / Hackeo',
        desc: 'Terminal cibernética inyectando código hasta activar frenesí.',
        defaultSec: 18,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const percent = Math.min(100, Math.round(ratio * 100));
            const isFinished = remaining <= 0;

            if (isFinished) {
                return (
`💻⚡🔓 *¡¡¡OVERRIDE DEL SISTEMA COMPLETADO (100%)!!!* 🔓⚡💻
====================================
>> ACCESS GRANTED: ROOT ADMIN PRIVILEGES
>> RECOMPENSAS: ACTIVADAS
>> COOLDOWNS: ANULADOS
====================================
⚡ *¡EL FRENESÍ DEL ADMINISTRADOR HA SIDO DESATADO!*
${customText ? `\n📢 *Efecto Especial:* ${customText}\n` : ''}
🚀 _¡Aprovechen los beneficios mientras dure!_`
                );
            }

            const logSteps = [
                'Iniciando conexión con el núcleo...',
                'Bypasseando firewalls del bot...',
                'Inyectando paquetes de dinero y suerte...',
                'Sobrecargando generador de recompensas...',
                'Desbloqueando base de datos global...'
            ];
            const currentLog = logSteps[Math.min(logSteps.length - 1, Math.floor(ratio * logSteps.length))];
            const cursor = (step % 2 === 0) ? '█' : ' ';
            const bar = renderProgressBar(elapsed, total, 12, '▓', '░');

            return (
`💻 *[ TERMINAL ADMIN — OVERRIDE EN PROCESO ]*
┌──────────────────────────────┐
│ [${bar}] ${percent}%${cursor}
└──────────────────────────────┘
📡 *Log:* > _${currentLog}_
⏳ *Tiempo de inyección:* ${formatTime(remaining)}
${customText ? `\n💬 _${customText}_\n` : ''}`
            );
        }
    },

    // 🚀 6. DESPEGUE ESPACIAL / CUENTA ATRÁS
    cohete: {
        name: 'Despegue de Cohete',
        desc: 'Lanzamiento de cohete espacial con ignición de motores.',
        defaultSec: 12,
        renderFrame: ({ elapsed, total, customText, step }) => {
            const remaining = Math.max(0, total - elapsed);
            const ratio = elapsed / total;
            const isFinished = remaining <= 0;

            if (isFinished) {
                return (
`🌌🚀✨ *¡¡¡DESPEGUE EXITOSO RUMBO A LA LUNA!!!* ✨🚀🌌
        .    *    .   *
           /\\     *   .
          /  \\  .   *
         |    |   .   
        /|/\\/\\|\\  
       /_|/  \\|_\\
         🔥⚡🔥
        💨💨💨💨
🎉 *¡LA MISIÓN HA SIDO LANZADA CON ÉXITO!*
${customText ? `\n📢 *Carga Útil:* ${customText}\n` : ''}`
                );
            }

            let phase = '';
            let shipArt = '';
            if (ratio < 0.4) {
                phase = '🛡️ Comprobación de sistemas en plataforma...';
                shipArt = '      /\\\n     |  |\n    /|/\\|\\\n     [TWR]';
            } else if (ratio < 0.75) {
                phase = '⛽ Presurización de combustible y oxígeno...';
                shipArt = '      /\\\n     |  |\n    /|/\\|\\\n     (⚡)';
            } else {
                phase = '🔥 ¡IGNICIÓN DE PROPULSORES PRINCIPALES!';
                const fire = (step % 2 === 0) ? '  🔥💥🔥' : '  ⚡🔥⚡';
                shipArt = `      /\\\n     |  |\n    /|/\\|\\\n${fire}`;
            }

            return (
`🚀 *[ PROTOCOLO DE LANZAMIENTO ESPACIAL ]*

${shipArt}

📡 *Fase:* ${phase}
⏱️ *T-Minus:* *${formatTime(remaining)}*
${customText ? `\n💬 _${customText}_\n` : ''}`
            );
        }
    },

    // 🌧️ 7. LLUVIA DE DINERO
    lluvia: {
        name: 'Lluvia de Dinero',
        desc: 'Billetes y monedas cayendo continuamente durante el tiempo fijado.',
        defaultSec: 20,
        renderFrame: ({ elapsed, total, customText, step, poolLeft, initialPool }) => {
            const remaining = Math.max(0, total - elapsed);
            const isFinished = remaining <= 0 || (poolLeft !== undefined && poolLeft <= 0);

            if (isFinished) {
                return (
`🌧️💸💰 *¡¡¡FIN DE LA LLUVIA DE DINERO!!!* 💰💸🌧️
╔═════════════════════════════╗
║   🎉 ¡POZO AGOTADO / FINALIZADO!   ║
╚═════════════════════════════╝
💵 *Dinero total repartido:* $${(initialPool || 0).toLocaleString()}
${customText ? `\n📢 *Detalle:* ${customText}\n` : ''}
✨ _¡Felicidades a todos los que alcanzaron a recoger dinero!_`
                );
            }

            const rainRows = [
                ['💵', '🪙', '💸', '💵', '🪙', '💸'],
                ['🪙', '💸', '💵', '🪙', '💸', '💵'],
                ['💸', '💵', '🪙', '💸', '💵', '🪙']
            ];
            const activeRow = rainRows[step % rainRows.length].join('   ');
            const poolText = poolLeft !== undefined ? `\n💰 *Pozo restante:* *$${poolLeft.toLocaleString()}*` : '';

            return (
`🌧️💸 *¡¡¡LLUVIA DE DINERO ACTIVA EN EL GRUPO!!!* 💸🌧️
╭─────────────────────────────╮
│   ${activeRow}   │
╰─────────────────────────────╯${poolText}
⏱️ *Tiempo restante:* *${formatTime(remaining)}*
👉 *¡Escribe .recoger para agarrar dinero ya!*
${customText ? `\n💬 _${customText}_\n` : ''}`
            );
        }
    }
};

// ==========================================
// 🚀 CONTROLADOR DE ANIMACIONES EN TIEMPO REAL
// ==========================================

/**
 * Inicia una animación en tiempo real en un chat.
 * @param {object} sock - Cliente de Baileys
 * @param {string} chatJid - JID del chat / grupo
 * @param {string} animType - Tipo ('reloj', 'bomba', 'cofre', etc.)
 * @param {number} durationSec - Duración en segundos
 * @param {object} options - Opciones adicionales (customText, pool, onFinish, quoted)
 */
export async function startLiveAnimation(sock, chatJid, animType, durationSec, options = {}) {
    // Si ya hay una animación activa en este chat, cancelarla primero
    if (activeAnimations.has(chatJid)) {
        stopLiveAnimation(chatJid, 'Cancelada por nueva animación.');
    }

    const preset = ANIMATION_PRESETS[animType.toLowerCase()];
    if (!preset) {
        throw new Error(`Tipo de animación desconocido: "${animType}". Usa .anim lista para ver las opciones.`);
    }

    const totalDuration = Math.max(4, Math.min(600, durationSec || preset.defaultSec));
    // Intervalo de actualización: 1.5s para duraciones cortas, 2s para medianas, 3s para largas
    let intervalMs = 1500;
    if (totalDuration > 60) intervalMs = 2500;
    if (totalDuration > 180) intervalMs = 4000;

    const startTime = Date.now();
    let stepCount = 0;

    // Estado mutable de la animación (por ejemplo para lluvia de dinero interactiva)
    const animState = {
        poolLeft: options.pool || 0,
        initialPool: options.pool || 0,
        participants: new Set()
    };

    // Renderizar primer frame
    const initialText = preset.renderFrame({
        elapsed: 0,
        total: totalDuration,
        customText: options.customText || '',
        step: 0,
        poolLeft: animState.poolLeft,
        initialPool: animState.initialPool
    });

    // Enviar el mensaje base inicial
    const sentMsg = await sock.sendMessage(chatJid, { text: initialText }, options.quoted ? { quoted: options.quoted } : {});
    if (!sentMsg?.key) {
        throw new Error('No se pudo enviar el mensaje inicial de la animación.');
    }

    const animRecord = {
        type: animType,
        msgKey: sentMsg.key,
        totalDuration,
        startTime,
        intervalId: null,
        animState,
        options
    };

    // Bucle de actualización en tiempo real
    const intervalId = setInterval(async () => {
        try {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            stepCount++;

            const isDone = elapsed >= totalDuration || (animState.poolLeft !== undefined && options.pool && animState.poolLeft <= 0);

            const frameText = preset.renderFrame({
                elapsed: Math.min(totalDuration, elapsed),
                total: totalDuration,
                customText: options.customText || '',
                step: stepCount,
                poolLeft: animState.poolLeft,
                initialPool: animState.initialPool
            });

            // Editar el mensaje en tiempo real
            await sock.sendMessage(chatJid, {
                text: frameText,
                edit: sentMsg.key
            });

            if (isDone) {
                clearInterval(intervalId);
                activeAnimations.delete(chatJid);

                // Ejecutar callback de finalización si existe (recompensas, etc.)
                if (typeof options.onFinish === 'function') {
                    try {
                        await options.onFinish({
                            sock,
                            chatJid,
                            animState,
                            totalDuration
                        });
                    } catch (cbErr) {
                        console.error('[LiveAnimation] Error en callback onFinish:', cbErr);
                    }
                }
            }
        } catch (err) {
            console.error('[LiveAnimation] Error editando frame:', err.message);
            // Si el mensaje fue borrado o hay un error fatal, detener el timer
            if (err?.message?.includes('item-not-found') || err?.message?.includes('not-authorized')) {
                clearInterval(intervalId);
                activeAnimations.delete(chatJid);
            }
        }
    }, intervalMs);

    animRecord.intervalId = intervalId;
    activeAnimations.set(chatJid, animRecord);

    return animRecord;
}

/**
 * Detiene una animación activa en el chat.
 */
export async function stopLiveAnimation(chatJid, reason = 'Detenida por el administrador.', sock = null) {
    const record = activeAnimations.get(chatJid);
    if (!record) return false;

    if (record.intervalId) {
        clearInterval(record.intervalId);
    }
    activeAnimations.delete(chatJid);

    if (sock && record.msgKey) {
        try {
            await sock.sendMessage(chatJid, {
                text: `🛑 *ANIMACIÓN DETENIDA*\n_${reason}_`,
                edit: record.msgKey
            });
        } catch (_) {}
    }

    return true;
}

/**
 * Obtiene la lista formateada de animaciones para el menú de ayuda.
 */
export function getAnimationHelpText(prefix = '.') {
    const list = Object.entries(ANIMATION_PRESETS).map(([key, p]) => {
        return `• *${prefix}anim ${key} [tiempo] [mensaje/evento]*\n  └ _${p.name}:_ ${p.desc} (Default: ${p.defaultSec}s)`;
    }).join('\n\n');

    return (
`🎬 *CATÁLOGO DE ANIMACIONES EN TIEMPO REAL* ⏳
_Animaciones interactivas editadas segundo a segundo en vivo en WhatsApp._

${list}

🛑 *Detener animación activa:*
• *${prefix}anim stop* — Cancela de inmediato la animación en el chat.

💡 *Ejemplos de uso:*
• *${prefix}anim reloj 30s ¡El primero que hable gana $50k!*
• *${prefix}anim bomba 15s Cuidado con la mecha*
• *${prefix}anim cofre 20s Premio: $100,000 + 500 XP*
• *${prefix}anim slots 10s Girando por el Jackpot*
• *${prefix}anim hack 25s Sobrecargando el servidor*
• *${prefix}anim cohete 10s Misión Apolo DUbot*
• *${prefix}anim lluvia 20s 500000*`
    );
}

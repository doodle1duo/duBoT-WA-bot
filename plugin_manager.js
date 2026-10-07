import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const PLUGINS_DIR = path.join(process.cwd(), 'plugins');

// Asegurar que la carpeta de plugins exista
if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

// Almacén en memoria de plugins cargados
// Map<string, PluginObject>
const loadedPlugins = new Map();
// Map<string, { pluginName: string, handler: Function, description: string }>
const commandRegistry = new Map();

/**
 * Valida la sintaxis de un código de plugin antes de guardarlo.
 * @param {string} code Código fuente del plugin en JS
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePluginCode(code) {
    try {
        if (!code || typeof code !== 'string') {
            return { valid: false, error: 'El código está vacío o no es válido.' };
        }

        // 1. Verificación básica de estructura
        if (!code.includes('export default') && !code.includes('module.exports')) {
            return { valid: false, error: 'El plugin debe exportar un objeto por defecto (export default { ... }).' };
        }

        // 2. Validación de sintaxis evaluando como función de prueba
        const testCode = code
            .replace(/export\s+default\s+/g, 'const __plugin__ = ')
            .replace(/import\s+.*?from\s+['"].*?['"];?/g, '// import');
        
        new Function(testCode);
        return { valid: true };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

/**
 * Carga o recarga un plugin individual desde el disco.
 * @param {string} fileName Nombre del archivo (ej. 'mi_plugin.js')
 */
export async function loadPluginFile(fileName) {
    if (!fileName.endsWith('.js') && !fileName.endsWith('.mjs')) return null;

    const filePath = path.join(PLUGINS_DIR, fileName);
    if (!fs.existsSync(filePath)) return null;

    try {
        // Usamos timestamp como query param para evitar caché del motor ESM en Node.js (Hot-Reload)
        const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
        const module = await import(fileUrl);
        const plugin = module.default || module;

        if (!plugin || typeof plugin !== 'object') {
            console.warn(`⚠️ [Plugins] El archivo ${fileName} no exporta un objeto válido.`);
            return null;
        }

        const pluginName = plugin.name || path.basename(fileName, path.extname(fileName));
        plugin.name = pluginName;
        plugin.fileName = fileName;
        plugin.enabled = plugin.enabled !== false; // Por defecto activo
        plugin.commands = plugin.commands || {};

        // Guardar en el almacén de plugins
        loadedPlugins.set(pluginName, plugin);

        // Si está habilitado, registrar sus comandos
        if (plugin.enabled) {
            for (const [cmd, handler] of Object.entries(plugin.commands)) {
                if (typeof handler === 'function') {
                    commandRegistry.set(cmd.toLowerCase(), {
                        pluginName,
                        handler,
                        description: plugin.description || 'Comando de plugin'
                    });
                }
            }
        }

        console.log(`✅ [Plugins] Cargado: ${pluginName} (${Object.keys(plugin.commands).length} comandos) [${plugin.enabled ? 'ACTIVO' : 'PAUSADO'}]`);
        return plugin;
    } catch (err) {
        console.error(`❌ [Plugins] Error cargando ${fileName}:`, err.message);
        return null;
    }
}

/**
 * Carga todos los plugins existentes en la carpeta /plugins
 */
export async function loadAllPlugins() {
    loadedPlugins.clear();
    commandRegistry.clear();

    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
        return [];
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
    for (const file of files) {
        await loadPluginFile(file);
    }

    console.log(`📦 [Plugins] Total de plugins cargados: ${loadedPlugins.size}, Comandos registrados: ${commandRegistry.size}`);
    return Array.from(loadedPlugins.values());
}

/**
 * Guarda un nuevo plugin o actualiza uno existente y lo activa en caliente.
 * @param {string} name Nombre identificador del plugin (sin extensión)
 * @param {string} code Código fuente JavaScript
 * @returns {Promise<{ success: boolean, message: string, plugin?: object }>}
 */
export async function savePlugin(name, code) {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!cleanName) {
        return { success: false, message: 'Nombre de plugin inválido.' };
    }

    const validation = validatePluginCode(code);
    if (!validation.valid) {
        return { success: false, message: `Error de sintaxis: ${validation.error}` };
    }

    const fileName = `${cleanName}.js`;
    const filePath = path.join(PLUGINS_DIR, fileName);

    try {
        fs.writeFileSync(filePath, code, 'utf-8');
        const plugin = await loadPluginFile(fileName);
        if (!plugin) {
            return { success: false, message: 'El plugin se guardó pero falló al instanciarse en memoria.' };
        }

        return {
            success: true,
            message: `Plugin '${cleanName}' guardado y activado exitosamente.`,
            plugin
        };
    } catch (err) {
        return { success: false, message: `Error al guardar archivo: ${err.message}` };
    }
}

/**
 * Elimina un plugin del disco y de la memoria.
 * @param {string} name Nombre del plugin
 */
export async function deletePlugin(name) {
    const cleanName = name.trim().toLowerCase();
    const plugin = loadedPlugins.get(cleanName);
    const fileName = plugin?.fileName || `${cleanName}.js`;
    const filePath = path.join(PLUGINS_DIR, fileName);

    // Desregistrar comandos
    for (const [cmd, entry] of Array.from(commandRegistry.entries())) {
        if (entry.pluginName === cleanName) {
            commandRegistry.delete(cmd);
        }
    }

    loadedPlugins.delete(cleanName);

    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            return { success: true, message: `Plugin '${cleanName}' eliminado correctamente.` };
        } catch (err) {
            return { success: false, message: `Error eliminando archivo: ${err.message}` };
        }
    }

    return { success: true, message: `Plugin '${cleanName}' descargado de la memoria.` };
}

/**
 * Activa o desactiva un plugin sin borrarlo.
 * @param {string} name 
 * @param {boolean} [enableState] Si se omite, invierte el estado actual
 */
export async function togglePlugin(name, enableState = null) {
    const cleanName = name.trim().toLowerCase();
    const plugin = loadedPlugins.get(cleanName);
    if (!plugin) {
        return { success: false, message: `El plugin '${cleanName}' no fue encontrado.` };
    }

    const newState = enableState !== null ? Boolean(enableState) : !plugin.enabled;
    plugin.enabled = newState;

    // Actualizar registro de comandos
    if (newState) {
        for (const [cmd, handler] of Object.entries(plugin.commands || {})) {
            if (typeof handler === 'function') {
                commandRegistry.set(cmd.toLowerCase(), {
                    pluginName: cleanName,
                    handler,
                    description: plugin.description || 'Comando de plugin'
                });
            }
        }
    } else {
        for (const [cmd, entry] of Array.from(commandRegistry.entries())) {
            if (entry.pluginName === cleanName) {
                commandRegistry.delete(cmd);
            }
        }
    }

    return {
        success: true,
        message: `Plugin '${cleanName}' ahora está ${newState ? '✅ ACTIVADO' : '⏸️ DESACTIVADO'}.`,
        enabled: newState
    };
}

/**
 * Retorna lista de plugins y comandos registrados
 */
export function listPlugins() {
    const list = [];
    for (const [name, p] of loadedPlugins.entries()) {
        list.push({
            name,
            fileName: p.fileName,
            description: p.description || 'Sin descripción',
            author: p.author || 'Desconocido',
            version: p.version || '1.0.0',
            enabled: p.enabled !== false,
            commands: Object.keys(p.commands || {})
        });
    }
    return list;
}

/**
 * Obtiene la información o código fuente de un plugin específico
 */
export function getPluginInfo(name) {
    const cleanName = name.trim().toLowerCase();
    const plugin = loadedPlugins.get(cleanName);
    if (!plugin) return null;

    const filePath = path.join(PLUGINS_DIR, plugin.fileName || `${cleanName}.js`);
    let sourceCode = '';
    if (fs.existsSync(filePath)) {
        try {
            sourceCode = fs.readFileSync(filePath, 'utf-8');
        } catch (e) {}
    }

    return {
        ...plugin,
        sourceCode
    };
}

// ==========================================
// 🧪 SISTEMA TEST VM: AISLAMIENTO DE PRUEBAS
// ==========================================
// Map<userJid, Set<pluginName>>
const userTestVMSessions = new Map();
// Set<pluginName> - Plugins que están forzados en modo test aislado
const isolatedTestPlugins = new Set();

/**
 * Activa el modo Test VM para un usuario sobre un plugin específico.
 * En este estado, el plugin SOLO le responderá y afectará a este usuario.
 * @param {string} pluginName Nombre del plugin
 * @param {string} userJid JID del usuario tester
 * @param {boolean} [isolateForEveryoneElse=true] Si true, nadie más puede usar el plugin
 */
export function enableTestVM(pluginName, userJid, isolateForEveryoneElse = true) {
    const cleanName = pluginName.trim().toLowerCase();
    const plugin = loadedPlugins.get(cleanName);
    if (!plugin) {
        return { success: false, message: `El plugin '${cleanName}' no existe o no está cargado.` };
    }

    if (!userTestVMSessions.has(userJid)) {
        userTestVMSessions.set(userJid, new Set());
    }

    const userSet = userTestVMSessions.get(userJid);
    userSet.add(cleanName);

    if (isolateForEveryoneElse) {
        isolatedTestPlugins.add(cleanName);
        plugin.testMode = true;
    }

    // Asegurar que sus comandos estén registrados para ser ejecutados por el tester
    for (const [cmd, handler] of Object.entries(plugin.commands || {})) {
        if (typeof handler === 'function') {
            commandRegistry.set(cmd.toLowerCase(), {
                pluginName: cleanName,
                handler,
                description: plugin.description || 'Comando de plugin'
            });
        }
    }

    return {
        success: true,
        message: `Modo Test VM activado para '${cleanName}'.`,
        plugin
    };
}

/**
 * Desactiva el modo Test VM para un usuario
 * @param {string} userJid 
 * @param {string} [pluginName] Nombre específico o null para todos
 */
export function disableTestVM(userJid, pluginName = null) {
    if (!userTestVMSessions.has(userJid)) {
        return { success: false, message: 'No tienes ninguna sesión de Test VM activa.' };
    }

    const userSet = userTestVMSessions.get(userJid);
    if (!pluginName || pluginName === 'all' || pluginName === 'todos' || pluginName === 'exit') {
        for (const pName of userSet) {
            // Si nadie más lo está probando, liberar aislamiento
            let otherTesting = false;
            for (const [otherJid, oSet] of userTestVMSessions.entries()) {
                if (otherJid !== userJid && oSet.has(pName)) {
                    otherTesting = true;
                    break;
                }
            }
            if (!otherTesting) {
                isolatedTestPlugins.delete(pName);
                const p = loadedPlugins.get(pName);
                if (p) p.testMode = false;
            }
        }
        userTestVMSessions.delete(userJid);
        return { success: true, message: 'Has salido de todas las sesiones de Test VM.' };
    }

    const cleanName = pluginName.trim().toLowerCase();
    const wasIn = userSet.delete(cleanName);
    if (userSet.size === 0) {
        userTestVMSessions.delete(userJid);
    }

    // Verificar si queda algún otro usuario probándolo
    let otherTesting = false;
    for (const [otherJid, oSet] of userTestVMSessions.entries()) {
        if (otherJid !== userJid && oSet.has(cleanName)) {
            otherTesting = true;
            break;
        }
    }
    if (!otherTesting) {
        isolatedTestPlugins.delete(cleanName);
        const p = loadedPlugins.get(cleanName);
        if (p) p.testMode = false;
    }

    if (!wasIn) {
        return { success: false, message: `No estabas probando el plugin '${cleanName}' en Test VM.` };
    }

    return { success: true, message: `Has salido del modo Test VM para el plugin '${cleanName}'.` };
}

/**
 * Comprueba si un usuario está probando un plugin en Test VM
 */
export function isUserTestingPlugin(pluginName, userJid) {
    if (!userJid) return false;
    const cleanName = pluginName.trim().toLowerCase();
    const userSet = userTestVMSessions.get(userJid);
    return Boolean(userSet && userSet.has(cleanName));
}

/**
 * Retorna los nombres de los plugins que un usuario tiene en Test VM
 */
export function getUserTestPlugins(userJid) {
    const userSet = userTestVMSessions.get(userJid);
    if (!userSet) return [];
    return Array.from(userSet);
}

// ==========================================
// ⚠️ GESTIÓN DE ERRORES DE PLUGINS
// ==========================================
const pluginErrors = new Map(); // Map<pluginName, { command, message, stack, timestamp, sender, isTester }>
let lastGlobalError = null;

/**
 * Registra un error de ejecución o sintaxis de un plugin
 */
export function recordPluginError(pluginName, errorData) {
    const cleanName = (pluginName || 'desconocido').trim().toLowerCase();
    const data = {
        pluginName: cleanName,
        ...errorData,
        timestamp: errorData.timestamp || Date.now()
    };
    pluginErrors.set(cleanName, data);
    lastGlobalError = data;
    return data;
}

/**
 * Obtiene el último error registrado de un plugin específico o el último global
 */
export function getPluginError(pluginName = null) {
    if (!pluginName) return lastGlobalError;
    const cleanName = pluginName.trim().toLowerCase();
    return pluginErrors.get(cleanName) || lastGlobalError;
}

/**
 * Retorna el último error global ocurrido en cualquier plugin
 */
export function getLastError() {
    return lastGlobalError;
}

/**
 * Limpia el error registrado de un plugin tras ser reparado
 */
export function clearPluginError(pluginName = null) {
    if (!pluginName) {
        pluginErrors.clear();
        lastGlobalError = null;
        return;
    }
    const cleanName = pluginName.trim().toLowerCase();
    pluginErrors.delete(cleanName);
    if (lastGlobalError?.pluginName === cleanName) {
        lastGlobalError = null;
    }
}

/**
 * Ejecuta un comando si pertenece a algún plugin activo o en Test VM.
 * Aplica regla de aislamiento: en estado Test VM solo responde al tester.
 * @param {string} command Nombre del comando en minúsculas
 * @param {object} ctx Contexto del mensaje ({ sock, from, sender, senderName, args, argText, reply, db, user, saveDB, ... })
 * @returns {Promise<boolean>} true si el comando fue manejado por un plugin, false si no.
 */
export async function executePluginCommand(command, ctx) {
    const entry = commandRegistry.get(command.toLowerCase());
    if (!entry || typeof entry.handler !== 'function') {
        return false;
    }

    const plugin = loadedPlugins.get(entry.pluginName);
    if (!plugin) return false;

    const isTester = isUserTestingPlugin(entry.pluginName, ctx.sender);
    const isIsolated = isolatedTestPlugins.has(entry.pluginName) || plugin.testMode === true;

    // 🔒 REGLA DE AISLAMIENTO TEST VM:
    // Si el plugin está en modo test o aislado: SOLO responde y afecta al tester
    if (isIsolated) {
        if (!isTester) {
            // Invisible para cualquier otro usuario en el grupo o chat
            return false;
        }
    } else if (!plugin.enabled) {
        // Si el plugin está pausado globalmente, pero el tester lo tiene en Test VM:
        if (!isTester) {
            return false;
        }
    }

    // Si el usuario está baneado de GemPlugins, no puede ejecutar plugins en Test VM ni interactuar
    if (ctx.user && checkPluginBan(ctx.user).isBanned) {
        return false;
    }

    // Marcar contexto de prueba si es tester
    ctx.isTestVM = isTester;

    try {
        await entry.handler(ctx);
        return true;
    } catch (err) {
        console.error(`❌ [Plugins] Error ejecutando comando '${command}' del plugin '${entry.pluginName}':`, err);

        // Registrar el error para auto-reparación
        recordPluginError(entry.pluginName, {
            command,
            message: err.message,
            stack: err.stack,
            sender: ctx.sender,
            isTester
        });

        if (ctx.sock && ctx.from && ctx.msg) {
            try {
                const pref = ctx.pref || '.';
                const userMode = ctx.user?.pluginMode || (ctx.isAdmin ? 'avanzado' : 'simple');

                if (userMode === 'simple') {
                    // 🟢 MODO SIMPLE: Amigable, sin tecnicismos ni stack trace
                    await ctx.sock.sendMessage(ctx.from, {
                        text: `⚠️ *Ups, el comando .${command} tuvo un pequeño detalle al ejecutarse.*\n\n` +
                              `💡 ¡No te preocupes! La inteligencia artificial puede repararlo por ti al instante.\n\n` +
                              `👉 Escribe: *${pref}gemplugins reparar* (o *${pref}reparar*) para corregirlo automáticamente.`
                    }, { quoted: ctx.msg });
                } else {
                    // ⚙️ MODO AVANZADO: Información técnica de desarrollador y traza
                    const stackLine = err.stack ? (err.stack.split('\n')[1]?.trim() || err.message) : err.message;
                    await ctx.sock.sendMessage(ctx.from, {
                        text: `⚠️ *Error en Plugin [${entry.pluginName}]${isTester ? ' 🧪[TestVM]' : ''}:*\n` +
                              `Fallo al ejecutar *.${command}*: \`${err.message}\`\n` +
                              `📍 *Traza:* \`${stackLine}\`\n\n` +
                              `🔧 *Opciones de auto-reparación con IA:*\n` +
                              `• Auto-reparar: *${pref}gemplugins fix ${entry.pluginName}*\n` +
                              `• Reparar con indicaciones: *${pref}gemplugins fix ${entry.pluginName} [instrucciones]*`
                    }, { quoted: ctx.msg });
                }
            } catch (e) {}
        }
        return true; // Fue manejado aunque haya fallado
    }
}

// ==========================================
// 🚫 GESTIÓN DE BANEOS DE GEMPLUGINS
// ==========================================

/**
 * Parsea una duración de baneo en milisegundos o permanente
 * @param {string} str Ejemplos: '30m', '2h', '1d', '60s', 'perm', 'siempre'
 * @returns {{ permanent: boolean, ms: number } | null}
 */
export function parseBanDuration(str) {
    if (!str) return { permanent: true, ms: 0 };
    const lower = str.trim().toLowerCase();
    if (['perm', 'permanent', 'permanente', 'siempre', 'porsiempre', 'infinito', 'forever', '0'].includes(lower)) {
        return { permanent: true, ms: 0 };
    }
    const match = lower.match(/^(\d+)\s*(s|seg|segundos|m|min|minutos|h|hora|horas|d|dia|dias)?$/);
    if (!match) return null;
    const val = parseInt(match[1], 10);
    if (isNaN(val) || val <= 0) return { permanent: true, ms: 0 };
    const unit = match[2] || 'm'; // Por defecto minutos
    let ms = 0;
    if (unit.startsWith('s')) ms = val * 1000;
    else if (unit.startsWith('m')) ms = val * 60 * 1000;
    else if (unit.startsWith('h')) ms = val * 60 * 60 * 1000;
    else if (unit.startsWith('d')) ms = val * 24 * 60 * 60 * 1000;
    return { permanent: false, ms };
}

/**
 * Formatea milisegundos en texto amigable (días, horas, minutos, segundos)
 * @param {number} ms 
 * @returns {string}
 */
export function formatTimeLeft(ms) {
    if (!ms || ms <= 0) return '0 segundos';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parts.length === 0 || seconds > 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

/**
 * Verifica si un usuario está baneado de GemPlugins, limpiando el baneo automáticamente si expiró
 * @param {object} user Objeto del usuario en la base de datos
 * @param {object} [db] Objeto general de DB para persistir
 * @param {Function} [saveDB] Función para guardar cambios
 * @returns {{ isBanned: boolean, permanent?: boolean, remainingMs?: number, remainingText?: string, reason?: string, bannedBy?: string, bannedAt?: number }}
 */
export function checkPluginBan(user, db = null, saveDB = null) {
    if (!user || !user.gempluginsBan || !user.gempluginsBan.banned) {
        return { isBanned: false };
    }

    const ban = user.gempluginsBan;
    if (!ban.permanent && ban.expiresAt && Date.now() >= ban.expiresAt) {
        // Baneo temporal expirado: auto-levantar
        delete user.gempluginsBan;
        if (typeof saveDB === 'function' && db) {
            try { saveDB(db); } catch (e) {}
        }
        return { isBanned: false };
    }

    const remainingMs = ban.permanent ? null : Math.max(0, ban.expiresAt - Date.now());
    return {
        isBanned: true,
        permanent: Boolean(ban.permanent),
        remainingMs,
        remainingText: ban.permanent ? 'Permanente (por siempre)' : formatTimeLeft(remainingMs),
        reason: ban.reason || 'Sin motivo especificado',
        bannedBy: ban.bannedBy || 'Administrador',
        bannedAt: ban.bannedAt || Date.now()
    };
}



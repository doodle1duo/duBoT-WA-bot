import { GoogleGenerativeAI } from '@google/generative-ai';
import { savePlugin, validatePluginCode, listPlugins, enableTestVM, getPluginInfo, getPluginError, getLastError, clearPluginError } from './plugin_manager.js';
import fs from 'fs';
import path from 'path';

// Almacén en memoria de sesiones conversacionales activas
// Map<senderJid, SessionData>
const activeSessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutos de inactividad

// Prompt de sistema especializado para el Arquitecto de Plugins de Gemini
const SYSTEM_INSTRUCTIONS = `
Eres el "Gemini Plugin Studio Architect", un asistente de Inteligencia Artificial avanzado integrado en DUbot (un bot de WhatsApp multifuncional en Node.js con Baileys ESM).
Tu objetivo es asistir al usuario de forma conversacional, amigable y experta para diseñar, programar, depurar y mejorar plugins para el bot.

--- ESTRUCTURA OFICIAL DE UN PLUGIN DE DUBOT ---
Un plugin es un módulo ESM que DEBE exportar por defecto un objeto con este formato exacto:

\`\`\`javascript
// PLUGIN_NAME: <nombre_sin_espacios>
// PLUGIN_DESC: <descripcion_corta>
export default {
    name: '<nombre_sin_espacios>',
    description: '<descripcion_corta>',
    version: '1.0.0',
    author: 'Usuario & Gemini',
    enabled: true,
    commands: {
        <nombre_comando_en_minusculas>: async (ctx) => {
            const { 
                sock,        // Instancia de Baileys
                from,        // JID del chat (grupo o privado)
                sender,      // JID del usuario
                senderName,  // Nombre del usuario en WhatsApp
                args,        // Array de argumentos (ej: ['100', 'cara'])
                argText,     // Texto completo tras el comando (ej: '100 cara')
                msg,         // Mensaje íntegro de Baileys
                db,          // Base de datos actual
                user,        // Objeto del usuario (user.bal, user.bank, user.xp, user.level, user.luck, etc.)
                saveDB,      // Función para guardar cambios: saveDB(db)
                reply,       // Helper: async (text, mentions = []) => await sock.sendMessage(from, { text, mentions }, { quoted: msg })
                isAdmin,     // boolean: si el sender es admin
                isGroup      // boolean: si el chat es un grupo
            } = ctx;

            // Lógica aquí protegida por try...catch
            try {
                // Ejemplo de respuesta amigable
                await reply(\`¡Hola \${senderName}! Resultado...\`);
            } catch (err) {
                await reply(\`❌ Error: \${err.message}\`);
            }
        }
    }
};
\`\`\`

--- CAPACIDADES Y REGLAS IMPORTANTES ---
1. MEJORAS DE RESPUESTA & LATENCIA:
   - Para medir delay o latencia exacta en milisegundos:
     const msgTime = (ctx.msg?.messageTimestamp ? Number(ctx.msg.messageTimestamp) * 1000 : Date.now());
     const delayMs = Math.max(0, Date.now() - msgTime);
   - Formatear respuestas elegantes con negritas (*texto*), cursivas (_texto_), emojis apropiados y estructura limpia de WhatsApp.
2. ECONOMÍA & DB:
   - Para transacciones de dinero: verificar 'if (user.bal < monto) return reply("No tienes suficiente dinero");'
   - Modificar 'user.bal += monto;' o 'user.bal -= monto;' y siempre ejecutar 'saveDB(db);'.
3. GENERACIÓN DEL CÓDIGO:
   - Si el usuario te está pidiendo un plugin o te pide generar/modificar el código, genera el bloque completo de código JavaScript dentro de un bloque \`\`\`javascript ... \`\`\`.
   - SIEMPRE incluye en las primeras dos líneas del código:
     // PLUGIN_NAME: nombre_del_plugin
     // PLUGIN_DESC: descripcion
   - El código debe ser sintácticamente perfecto para Node.js v18+.
   - Explica de forma clara y entusiasta qué comandos se crearon, cómo usarlos y ofrece ideas de mejora.
4. ACTITUD:
   - Eres proactivo, claro, servicial y experto.
   - Si el usuario solo está conversando o explorando ideas, ayúdalo a definir qué comandos quiere antes de generar el código.
   - Si el usuario te pide directamente "créalo ya", genera el código inmediatamente.
`;

// Prompt de sistema para MODO SIMPLE (sin jerga técnica para usuarios comunes)
const SYSTEM_INSTRUCTIONS_SIMPLE = `
Eres el "Asistente Creador de Comandos" de DUbot en MODO SIMPLE.
Tu misión es ayudar a cualquier persona a crear comandos personalizados para WhatsApp sin que tenga que saber nada de programación.

--- REGLAS ESTRICTAS DE MODO SIMPLE ---
1. LENGUAJE 100% AMIGABLE Y DIRECTO:
   - Habla en español sencillo, cálido, positivo y breve (máximo 2 párrafos cortos).
   - NUNCA uses tecnicismos (no menciones "JavaScript", "ESM", "export default", "Node.js", "Sandbox", "Test VM", etc.).
   - Dile con entusiasmo qué hace su comando y cómo probarlo (ejemplo: "¡Listo! Creé tu comando *.saludo*. Pruébalo escribiendo *.saludo*").

2. ESTRUCTURA INTERNA DEL CÓDIGO:
   - Para que el bot instale el comando, SIEMPRE incluye al final de tu respuesta el bloque de código JavaScript funcional dentro de \`\`\`javascript ... \`\`\`.
   - El código DEBE seguir este formato exacto:
\`\`\`javascript
// PLUGIN_NAME: <nombre_sin_espacios>
// PLUGIN_DESC: <descripcion_corta>
export default {
    name: '<nombre_sin_espacios>',
    description: '<descripcion_corta>',
    version: '1.0.0',
    enabled: true,
    commands: {
        <comando>: async (ctx) => {
            const { reply, senderName, args, argText } = ctx;
            try {
                await reply(\`¡Mensaje...\`);
            } catch (e) {
                await reply(\`❌ Error: \${e.message}\`);
            }
        }
    }
};
\`\`\`
   - Haz respuestas con emojis y estilos bonitos de WhatsApp (*negrita*, _cursiva_).
`;

/**
 * Obtiene la clave de API y el modelo configurado, priorizando el modelo seleccionado al inicio
 */
export function getAiConfig() {
    let apiKey = process.env.GEMINI_API_KEY;
    let modelName = process.env.GEMINI_MODEL; // Prioridad 1: Modelo seleccionado al inicio o cambiado en caliente

    try {
        const settingsPath = path.join(process.cwd(), 'settings.json');
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (!apiKey && settings.gemini_api_key) apiKey = settings.gemini_api_key;
            if (!modelName && settings.gemini_model) modelName = settings.gemini_model;
        }
    } catch (e) {}

    if (!modelName) modelName = 'gemini-3.8-flash';

    return { apiKey, modelName };
}

/**
 * Retorna el nombre del modelo de IA actualmente activo en GemPlugins
 */
export function getActiveModelName() {
    return getAiConfig().modelName;
}

/**
 * Verifica si el usuario tiene una sesión activa de GemPlugins Studio
 */
export function isUserInSession(sender) {
    cleanExpiredSessions();
    return activeSessions.has(sender);
}

// Registro global en memoria de plugins creados por cada usuario
// Map<senderJid, string[]>
const userGeneratedPluginsMap = new Map();

/**
 * Registra un plugin como generado por un usuario
 */
export function recordUserPlugin(sender, pluginName) {
    if (!sender || !pluginName) return;
    const cleanName = pluginName.trim().toLowerCase();
    const list = userGeneratedPluginsMap.get(sender) || [];
    if (!list.includes(cleanName)) {
        list.push(cleanName);
        userGeneratedPluginsMap.set(sender, list);
    }
}

/**
 * Retorna los nombres de los plugins generados por un usuario
 */
export function getUserGeneratedPlugins(sender) {
    return userGeneratedPluginsMap.get(sender) || [];
}

/**
 * Obtiene la sesión activa de un usuario
 */
export function getSession(sender) {
    cleanExpiredSessions();
    return activeSessions.get(sender) || null;
}

/**
 * Inicia una nueva sesión conversacional para el usuario
 * @param {string} sender JID del usuario
 * @param {string} from JID del chat
 * @param {string} senderName Nombre del usuario
 * @param {string} [mode='simple'] 'simple' o 'avanzado'
 */
export function openSession(sender, from, senderName, mode = 'simple') {
    cleanExpiredSessions();
    const session = {
        sender,
        from,
        senderName,
        mode: mode || 'simple',
        history: [],
        startedAt: Date.now(),
        lastActive: Date.now(),
        lastGeneratedPlugin: null,
        generatedPlugins: []
    };
    activeSessions.set(sender, session);
    return session;
}

/**
 * Cambia el modo de la sesión activa del usuario
 */
export function setSessionMode(sender, mode) {
    const s = getSession(sender);
    if (s) s.mode = mode;
}

/**
 * Retorna el modo actual de la sesión ('simple' o 'avanzado')
 */
export function getSessionMode(sender) {
    const s = getSession(sender);
    return s?.mode || 'simple';
}

/**
 * Cierra la sesión activa de un usuario
 */
export function closeSession(sender) {
    return activeSessions.delete(sender);
}

/**
 * Limpia sesiones que hayan superado el tiempo de inactividad
 */
function cleanExpiredSessions() {
    const now = Date.now();
    for (const [sender, sess] of activeSessions.entries()) {
        if (now - sess.lastActive > SESSION_TTL_MS) {
            activeSessions.delete(sender);
        }
    }
}

/**
 * Extrae de forma robusta el bloque de código de un plugin de la respuesta de Gemini
 * @param {string} text 
 * @returns {{ code: string, name: string, desc: string } | null}
 */
export function extractPluginCode(text) {
    if (!text || typeof text !== 'string') return null;

    let code = '';

    // 1. Buscar bloques de código markdown: ```javascript, ```js, ```node o ```
    const codeBlockRegex = /```(?:javascript|js|node)?\s*([\s\S]*?)\s*```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const candidate = match[1].trim();
        if (candidate.includes('export default') || candidate.includes('module.exports') || candidate.includes('commands:')) {
            code = candidate;
            break;
        }
    }

    // 2. Si no venía entre backticks, buscar directamente la estructura export default { ... }
    if (!code) {
        const directMatch = text.match(/(?:\/\/\s*PLUGIN_NAME:[\s\S]*?)?(?:export\s+default\s*\{[\s\S]*\}|module\.exports\s*=\s*\{[\s\S]*\})/i);
        if (directMatch) {
            code = directMatch[0].trim();
        }
    }

    if (!code) return null;

    // Normalizar a ESM si vino como CommonJS
    if (!code.includes('export default') && code.includes('module.exports')) {
        code = code.replace(/module\.exports\s*=/, 'export default');
    }

    // Extraer nombre del plugin
    let name = '';
    const nameCommentMatch = code.match(/\/\/\s*PLUGIN_NAME:\s*([a-zA-Z0-9_-]+)/i) || text.match(/\/\/\s*PLUGIN_NAME:\s*([a-zA-Z0-9_-]+)/i);
    if (nameCommentMatch) {
        name = nameCommentMatch[1].trim();
    } else {
        const namePropMatch = code.match(/name\s*:\s*['"`]([a-zA-Z0-9_-]+)['"`]/i);
        if (namePropMatch) name = namePropMatch[1].trim();
    }

    if (!name) name = `plugin_${Date.now()}`;

    // Extraer descripción
    let desc = '';
    const descCommentMatch = code.match(/\/\/\s*PLUGIN_DESC:\s*(.+)/i) || text.match(/\/\/\s*PLUGIN_DESC:\s*(.+)/i);
    if (descCommentMatch) {
        desc = descCommentMatch[1].trim();
    } else {
        const descPropMatch = code.match(/description\s*:\s*['"`]([^'"`]+)['"`]/i);
        if (descPropMatch) desc = descPropMatch[1].trim();
    }

    // Asegurar encabezado PLUGIN_NAME y PLUGIN_DESC si falta
    if (!code.includes('// PLUGIN_NAME:')) {
        code = `// PLUGIN_NAME: ${name}\n// PLUGIN_DESC: ${desc || 'Plugin de DUbot'}\n` + code;
    }

    return { code, name, desc };
}

/**
 * Procesa un mensaje de chat dentro de la sesión de Gemini Plugin Studio
 * @param {string} sender JID del remitente
 * @param {string} userMessage Texto enviado por el usuario
 * @param {object} ctx Contexto del mensaje ({ sock, from, senderName, ... })
 * @returns {Promise<string>} Respuesta para enviar al usuario
 */
export async function handleStudioMessage(sender, userMessage, ctx) {
    const session = getSession(sender) || openSession(sender, ctx.from, ctx.senderName, ctx?.mode || 'simple');
    if (ctx?.mode) session.mode = ctx.mode;
    session.lastActive = Date.now();
    const isSimpleMode = session.mode === 'simple';

    const { apiKey, modelName } = getAiConfig();
    if (!apiKey) {
        return '❌ No hay una clave de Gemini configurada (`GEMINI_API_KEY`). Configúrala en `settings.json`.';
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // Preparar contenido para Gemini
    // Agregamos contexto de plugins actuales
    const installed = listPlugins();
    const installedSummary = installed.map(p => `- ${p.name}: ${p.description} (comandos: ${p.commands.join(', ')})`).join('\n') || '(Ninguno aún)';

    // Inyectar contexto del último error registrado si ocurrió recientemente
    const lastErr = getLastError();
    let errInject = '';
    if (lastErr && (Date.now() - lastErr.timestamp < 20 * 60 * 1000)) {
        errInject = `\n[SISTEMA - DIAGNÓSTICO DE ERROR RECIENTE: El plugin '${lastErr.pluginName}' falló al ejecutar comando '.${lastErr.command}' con error: "${lastErr.message}"${lastErr.stack ? ' (traza: ' + lastErr.stack.split('\n')[1]?.trim() + ')' : ''}. Si el usuario menciona errores, reparar o modificar comandos, usa este contexto para corregirlo automáticamente.]`;
    }

    let contextualUserMessage = userMessage;
    if (session.history.length === 0) {
        contextualUserMessage = `[SISTEMA: El usuario ${ctx.senderName} inició el estudio de plugins en ${isSimpleMode ? 'MODO SIMPLE' : 'MODO AVANZADO'}. Plugins actuales instalados:\n${installedSummary}]${errInject}\n\nUsuario: ${userMessage}`;
    } else if (errInject && /(error|fallo|falló|repar|arregl|correg|bug|problema|no funciona|modific)/i.test(userMessage)) {
        contextualUserMessage = `${errInject}\n\nUsuario: ${userMessage}`;
    }

    session.history.push({
        role: 'user',
        parts: [{ text: contextualUserMessage }]
    });

    try {
        const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: isSimpleMode ? SYSTEM_INSTRUCTIONS_SIMPLE : SYSTEM_INSTRUCTIONS
        });

        const chat = model.startChat({
            history: session.history.slice(0, -1) // Historial previo
        });

        const result = await chat.sendMessage(contextualUserMessage);
        let aiResponse = result.response.text();

        session.history.push({
            role: 'model',
            parts: [{ text: aiResponse }]
        });

        // Verificar si la respuesta contiene un plugin listo para compilar/instalar
        let extracted = extractPluginCode(aiResponse);
        if (extracted) {
            let validation = validatePluginCode(extracted.code);

            // 🛠️ AUTO-REPARACIÓN INMEDIATA DE SINTAXIS:
            // Si la IA generó código con error de sintaxis, le pedimos auto-corregirse en el acto
            if (!validation.valid) {
                try {
                    const retryPrompt = `[SISTEMA - ERROR DE SINTAXIS]: El código que generaste contiene este error: "${validation.error}". Corrige inmediatamente el error y devuelve el código JavaScript completo y funcional dentro de \`\`\`javascript ... \`\`\`.`;
                    const retryResult = await chat.sendMessage(retryPrompt);
                    const retryText = retryResult.response.text();
                    const retryExtracted = extractPluginCode(retryText);
                    if (retryExtracted && validatePluginCode(retryExtracted.code).valid) {
                        extracted = retryExtracted;
                        validation = { valid: true };
                        aiResponse = retryText;
                    }
                } catch (e) {}
            }

            if (validation.valid) {
                const saveResult = await savePlugin(extracted.name, extracted.code);
                if (saveResult.success) {
                    session.lastGeneratedPlugin = extracted.name;
                    if (!Array.isArray(session.generatedPlugins)) session.generatedPlugins = [];
                    if (!session.generatedPlugins.includes(extracted.name)) {
                        session.generatedPlugins.push(extracted.name);
                    }
                    recordUserPlugin(sender, extracted.name);

                    // Limpiar errores previos si se reparó el plugin
                    clearPluginError(extracted.name);

                    const cmds = Object.keys(saveResult.plugin?.commands || {});
                    const cmdListStr = cmds.length > 0 ? cmds.map(c => `*.${c}*`).join(', ') : '_(Sin comandos directos)_';

                    if (isSimpleMode) {
                        // En Modo Simple, limpiamos bloques de código para no confundir al usuario común
                        let userCleanMsg = aiResponse.replace(/```(?:javascript|js)?[\s\S]*?```/gi, '').trim();
                        if (!userCleanMsg) userCleanMsg = `¡He creado tu comando con éxito!`;

                        if (ctx?.isAdmin) {
                            aiResponse = `${userCleanMsg}\n\n` +
                                `✨ *¡Comando creado e instalado!* 🎉\n` +
                                `🕹️ *Comando listo:* ${cmdListStr}\n` +
                                `👑 _Como eres admin del bot, ya está activo para todo el grupo._`;
                        } else {
                            enableTestVM(extracted.name, sender, true);
                            aiResponse = `${userCleanMsg}\n\n` +
                                `✨ *¡Comando creado con éxito!* 🎉\n` +
                                `🕹️ *Comando listo:* ${cmdListStr}\n` +
                                `💡 _Pruébalo ahora en este chat (por ahora solo te responde a ti)._\n\n` +
                                `📤 _¿Quieres que todos puedan usarlo?_\n` +
                                `Envía tu sugerencia al admin con: *.gemplugins enviar ${extracted.name}*`;
                        }
                    } else {
                        // Modo Avanzado (código fuente visible y opciones completas de desarrollador)
                        if (ctx?.isAdmin) {
                            // Admin del bot: se salta el proceso de aprobación y se activa para todos
                            aiResponse += `\n\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `🎉 *¡PLUGIN INSTALADO EN CALIENTE!* 👑\n` +
                                `📦 *Nombre:* \`${extracted.name}\`\n` +
                                `🕹️ *Comandos listos:* ${cmdListStr}\n` +
                                `⚡ _Al ser administrador del bot, te saltas la aprobación. ¡El plugin ya está activo para todos!_ 🚀\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `_¿Deseas afinar algo, agregar más funciones o crear otro?_`;
                        } else {
                            // Miembro: aislar en Test VM para que solo le afecte a él, y permitirle sugerirlo al admin
                            enableTestVM(extracted.name, sender, true);

                            aiResponse += `\n\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `🎉 *¡PLUGIN GENERADO EN MODO PRUEBA!* 🧪\n` +
                                `📦 *Nombre:* \`${extracted.name}\`\n` +
                                `🕹️ *Comandos listos:* ${cmdListStr}\n` +
                                `🔒 _Como eres miembro, el plugin está en tu Sandbox (Test VM): solo tú puedes probarlo y no afecta a nadie más._\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `📤 *¿Quieres sugerirlo para que esté activo para todos?*\n` +
                                `Envía tu sugerencia al administrador con:\n` +
                                `👉 *.gemplugins submit ${extracted.name}*`;
                        }
                    }
                } else {
                    aiResponse += `\n\n⚠️ *Aviso del Instalador:* No se pudo auto-activar el plugin: ${saveResult.message}`;
                }
            } else {
                aiResponse += `\n\n⚠️ *Aviso de Sintaxis:* El código generado tiene un detalle de sintaxis (${validation.error}). Dile a Gemini: _"corrige el error de sintaxis"_ para que lo ajuste.`;
            }
        }

        return aiResponse;

    } catch (err) {
        console.error('Error en Gemini Plugin Studio:', err);
        return `❌ Error al conectar con Gemini: ${err.message}\nIntenta de nuevo o formula tu requerimiento de otra forma.`;
    }
}

/**
 * Genera un plugin de un solo golpe (one-shot) sin chat interactivo
 * @param {string} description Requerimiento del usuario
 * @param {object} ctx Contexto del comando
 */
export async function buildPluginOneShot(description, ctx) {
    const { apiKey, modelName } = getAiConfig();
    if (!apiKey) {
        return { success: false, message: 'Falta configurar GEMINI_API_KEY.' };
    }

    const isSimple = ctx?.mode === 'simple';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: isSimple ? SYSTEM_INSTRUCTIONS_SIMPLE : SYSTEM_INSTRUCTIONS
    });

    const prompt = `Crea un plugin completo de JavaScript ESM para DUbot que cumpla exactamente la siguiente especificación:
"${description}"

REGLAS ESTRICTAS DE RESPUESTA:
1. Incluye el código completo dentro de un bloque de código: \`\`\`javascript ... \`\`\`
2. Las primeras dos líneas del código deben ser:
// PLUGIN_NAME: nombre_sin_espacios
// PLUGIN_DESC: descripcion_corta
3. Estructura exacta a exportar:
export default {
    name: 'nombre_del_plugin',
    description: 'breve descripcion',
    version: '1.0.0',
    author: 'Usuario & Gemini',
    enabled: true,
    commands: {
        comando1: async (ctx) => {
            const { reply, senderName, args, argText } = ctx;
            // logica
            await reply("mensaje");
        }
    }
};
4. Fuera del bloque de código, explica brevemente qué comandos incluye y cómo usarlos.`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        let extracted = extractPluginCode(text);

        if (!extracted) {
            return { 
                success: false, 
                message: 'La IA no incluyó un bloque de código JavaScript reconocible.', 
                details: text 
            };
        }

        let validation = validatePluginCode(extracted.code);
        if (!validation.valid) {
            // Auto-corrección rápida de sintaxis en one-shot
            try {
                const retryPrompt = `El código generado tiene el siguiente error de sintaxis: "${validation.error}". Corrige inmediatamente el error y devuelve el código JavaScript completo y corregido dentro de \`\`\`javascript ... \`\`\`:\n\n${extracted.code}`;
                const retryRes = await model.generateContent(retryPrompt);
                const retryText = retryRes.response.text();
                const retryExtracted = extractPluginCode(retryText);
                if (retryExtracted && validatePluginCode(retryExtracted.code).valid) {
                    extracted = retryExtracted;
                    validation = { valid: true };
                }
            } catch (e) {}
        }

        if (!validation.valid) {
            return {
                success: false,
                message: `Error de sintaxis en el plugin generado: ${validation.error}`,
                details: extracted.code
            };
        }

        const saveRes = await savePlugin(extracted.name, extracted.code);
        if (!saveRes.success) {
            return { 
                success: false, 
                message: `Error al compilar/guardar: ${saveRes.message}`, 
                details: extracted.code 
            };
        }

        if (ctx?.sender) {
            recordUserPlugin(ctx.sender, extracted.name);
        }

        const cmds = Object.keys(saveRes.plugin?.commands || {});
        return {
            success: true,
            pluginName: extracted.name,
            code: extracted.code,
            commands: cmds,
            explanation: text,
            message: `Plugin '${extracted.name}' creado y activado con éxito.`
        };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

/**
 * Modifica o repara un plugin existente con IA en caso de errores o peticiones de ajuste
 * Soporta Modo Simple (sin tecnicismos) y Modo Avanzado (diagnóstico técnico y trazas)
 * @param {string} pluginName Nombre del plugin
 * @param {object} options Opciones ({ errorDetails, customPrompt, mode, sender, senderName, isAdmin })
 * @returns {Promise<{ success: boolean, message: string, explanation?: string, code?: string, plugin?: object, commands?: string[] }>}
 */
export async function fixPluginWithAI(pluginName, options = {}) {
    const { apiKey, modelName } = getAiConfig();
    if (!apiKey) {
        return { success: false, message: 'Falta configurar GEMINI_API_KEY en settings.json.' };
    }

    const cleanName = (pluginName || '').trim().toLowerCase();
    const pluginInfo = cleanName ? getPluginInfo(cleanName) : null;
    if (!pluginInfo || !pluginInfo.sourceCode) {
        return { success: false, message: `No se encontró el plugin '${cleanName}' o no tiene código fuente accesible.` };
    }

    const isSimple = options.mode === 'simple';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: isSimple ? SYSTEM_INSTRUCTIONS_SIMPLE : SYSTEM_INSTRUCTIONS
    });

    const errorDetails = options.errorDetails || getPluginError(cleanName);
    const customPrompt = options.customPrompt || '';

    let taskDesc = '';
    if (errorDetails) {
        taskDesc += `El plugin presentó el siguiente error en tiempo de ejecución al ejecutar el comando '.${errorDetails.command || 'desconocido'}':\n`;
        taskDesc += `• Mensaje de error: "${errorDetails.message}"\n`;
        if (errorDetails.stack) {
            const shortStack = errorDetails.stack.split('\n').slice(0, 5).join('\n');
            taskDesc += `• Traza de pila (Stack):\n${shortStack}\n`;
        }
    }
    if (customPrompt) {
        taskDesc += `\nInstrucciones o cambios solicitados por el usuario:\n"${customPrompt}"\n`;
    }
    if (!errorDetails && !customPrompt) {
        taskDesc += 'El usuario solicitó una revisión, depuración y optimización general del código.\n';
    }

    const prompt = `Tienes la tarea de MODIFICAR / REPARAR el siguiente plugin de JavaScript ESM para DUbot.

CÓDIGO FUENTE ACTUAL DEL PLUGIN:
\`\`\`javascript
${pluginInfo.sourceCode}
\`\`\`

DIAGNÓSTICO Y REQUERIMIENTO:
${taskDesc}

REGLAS ESTRICTAS DE RESPUESTA:
1. Corrige todos los errores de sintaxis, variables no declaradas o problemas de lógica.
2. Si el usuario solicitó modificaciones o nuevos comandos, incorpóralos preservando el resto del plugin funcional.
3. El código modificado DEBE ser un módulo ESM válido y exportar por defecto la misma estructura (name, description, version, enabled, commands).
4. Mantén obligatoriamente las primeras dos líneas del archivo comentadas con:
   // PLUGIN_NAME: ${cleanName}
   // PLUGIN_DESC: <descripcion>
5. Retorna el código modificado completo dentro de un bloque \`\`\`javascript ... \`\`\`.
6. Fuera del bloque de código:
   - En MODO SIMPLE: explica de forma muy amable, cálida y breve (máximo 2 oraciones) qué se arregló, sin tecnicismos ni mencionar JavaScript/código.
   - En MODO AVANZADO: explica concisamente la causa técnica del fallo, qué cambios específicos se aplicaron en el código y qué comandos quedaron listos.`;

    try {
        const result = await model.generateContent(prompt);
        let aiText = result.response.text();
        let extracted = extractPluginCode(aiText);

        if (!extracted) {
            return {
                success: false,
                message: 'La IA no devolvió un bloque de código JavaScript reconocible.',
                details: aiText
            };
        }

        let validation = validatePluginCode(extracted.code);
        if (!validation.valid) {
            // Auto-corrección rápida de sintaxis
            try {
                const retryPrompt = `El código generado tiene el siguiente error de sintaxis: "${validation.error}". Corrige inmediatamente el error y devuelve el código JavaScript completo y corregido dentro de \`\`\`javascript ... \`\`\`:\n\n${extracted.code}`;
                const retryRes = await model.generateContent(retryPrompt);
                const retryText = retryRes.response.text();
                const retryExtracted = extractPluginCode(retryText);
                if (retryExtracted && validatePluginCode(retryExtracted.code).valid) {
                    extracted = retryExtracted;
                    validation = { valid: true };
                }
            } catch (e) {}
        }

        if (!validation.valid) {
            return {
                success: false,
                message: `El código corregido aún contiene un error de sintaxis: ${validation.error}`,
                details: extracted.code
            };
        }

        // Guardar y recargar plugin en caliente
        const saveResult = await savePlugin(cleanName, extracted.code);
        if (!saveResult.success) {
            return {
                success: false,
                message: `No se pudo guardar la modificación: ${saveResult.message}`
            };
        }

        // Limpiar el error registrado ya que fue solucionado
        clearPluginError(cleanName);

        // Si el usuario es miembro y no admin, aislar en Test VM
        if (options.sender && !options.isAdmin) {
            enableTestVM(cleanName, options.sender, true);
        }

        const cmds = Object.keys(saveResult.plugin?.commands || {});

        // Limpiar explicación para Modo Simple (ocultar código crudo)
        let explanation = aiText.replace(/```(?:javascript|js)?[\s\S]*?```/gi, '').trim();
        if (!explanation) {
            explanation = isSimple
                ? 'He reparado el comando para que funcione correctamente.'
                : 'Se corrigieron las excepciones detectadas y se recargó el plugin en caliente.';
        }

        return {
            success: true,
            pluginName: cleanName,
            commands: cmds,
            explanation,
            code: extracted.code,
            plugin: saveResult.plugin,
            isSimple
        };

    } catch (err) {
        return { success: false, message: `Error al conectar con Gemini: ${err.message}` };
    }
}


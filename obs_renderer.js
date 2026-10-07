import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import fluent from 'fluent-ffmpeg';
import zlib from 'zlib';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

fluent.setFfmpegPath(ffmpegStatic);

// ─── CONFIG DECODER (Supports Deflate, Gzip, Base64, and raw JSON) ───────────
export function decodeObsConfig(input) {
    if (typeof input === 'object' && input !== null) return input;
    const s = String(input).trim().replace(/\s/g, '');
    if (s.startsWith('{')) {
        try { return JSON.parse(s); } catch (_) {}
    }
    const buf = Buffer.from(s, 'base64');
    // 1. Try inflateRaw (CompressionStream deflate-raw)
    try {
        const unz = zlib.inflateRawSync(buf);
        return JSON.parse(unz.toString('utf8'));
    } catch (_) {}
    // 2. Try inflate (zlib standard deflate)
    try {
        const unz = zlib.inflateSync(buf);
        return JSON.parse(unz.toString('utf8'));
    } catch (_) {}
    // 3. Try gunzip
    try {
        const unz = zlib.gunzipSync(buf);
        return JSON.parse(unz.toString('utf8'));
    } catch (_) {}
    // 4. Try plain utf8 JSON
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch (_) {}
    // 5. Try binary escape decode (legacy)
    try {
        const bin = buf.toString('binary');
        return JSON.parse(decodeURIComponent(escape(bin)));
    } catch (e2) {
        throw new Error('Configuración OBS inválida o corrupta: ' + e2.message);
    }
}

// ─── KEYFRAME INTERPOLATION ──────────────────────────────────────────────────
function interpolateProps(layer, kf, t) {
    const keyframes = ((kf && kf[layer.id]) || []).slice().sort((a, b) => a.t - b.t);
    if (!keyframes.length) return { ...layer.props };
    if (t <= keyframes[0].t) return { ...layer.props, ...keyframes[0].props };
    if (t >= keyframes[keyframes.length - 1].t) return { ...layer.props, ...keyframes[keyframes.length - 1].props };
    let before = keyframes[0], after = keyframes[keyframes.length - 1];
    for (let i = 0; i < keyframes.length - 1; i++) {
        if (keyframes[i].t <= t && keyframes[i + 1].t >= t) { before = keyframes[i]; after = keyframes[i + 1]; break; }
    }
    const ratio = (t - before.t) / (after.t - before.t);
    const result = { ...layer.props };
    const allKeys = new Set([...Object.keys(before.props || {}), ...Object.keys(after.props || {})]);
    allKeys.forEach(k => {
        const bv = (before.props || {})[k] ?? result[k];
        const av = (after.props || {})[k] ?? result[k];
        result[k] = (typeof bv === 'number' && typeof av === 'number') ? bv + (av - bv) * ratio : (ratio < 0.5 ? bv : av);
    });
    return result;
}

// ─── SEEDED RANDOM (for particles) ───────────────────────────────────────────
function seededRand(seed) {
    let s = seed;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// ─── ANGLE → GRADIENT COORDS ─────────────────────────────────────────────────
function angleCoords(angle, w, h) {
    const a = (angle * Math.PI) / 180;
    const cx = w / 2, cy = h / 2;
    const dx = Math.cos(a) * w / 2, dy = Math.sin(a) * h / 2;
    return { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy };
}

// ─── SAFE SVG TEXT ───────────────────────────────────────────────────────────
function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── FRAME SVG GENERATOR ─────────────────────────────────────────────────────
function buildFrameSvg(project, t, imgCache = {}) {
    const { w, h, layers, kf } = project;
    let defs = '';
    let body = '';

    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer.visible) continue;
        const p = interpolateProps(layer, kf, t);
        const op = Math.max(0, Math.min(1, p.opacity ?? 1)).toFixed(3);

        if (layer.type === 'gradient') {
            const angle = p.animate ? (t * 36 + (p.angle || 135)) : (p.angle || 135);
            const g = angleCoords(angle % 360, p.w || w, p.h || h);
            const gid = 'g' + i;
            defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${g.x1.toFixed(1)}" y1="${g.y1.toFixed(1)}" x2="${g.x2.toFixed(1)}" y2="${g.y2.toFixed(1)}">
              <stop offset="0%"   stop-color="${esc(p.c1 || '#0d0d1a')}"/>
              <stop offset="50%"  stop-color="${esc(p.c2 || '#1a0a2e')}"/>
              <stop offset="100%" stop-color="${esc(p.c3 || '#0a1a2e')}"/>
            </linearGradient>`;
            body += `<rect x="${p.x || 0}" y="${p.y || 0}" width="${p.w || w}" height="${p.h || h}" fill="url(#${gid})" opacity="${op}"/>`;
        }

        if (layer.type === 'rect') {
            const x = p.x || 0, y = p.y || 0, rw = p.w || 200, rh = p.h || 100;
            const cx = x + rw / 2, cy = y + rh / 2;
            const rot = p.rotation || 0;
            const rad = Math.max(0, p.radius || 0);
            body += `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="${rad}" ry="${rad}"
              fill="${esc(p.color || '#333')}" opacity="${op}"
              transform="rotate(${rot},${cx},${cy})"/>`;
        }

        if (layer.type === 'circle') {
            body += `<circle cx="${p.x || w / 2}" cy="${p.y || h / 2}" r="${p.r || 50}"
              fill="${esc(p.color || '#7c3aed')}" opacity="${op}"/>`;
        }

        if (layer.type === 'text') {
            const rot = p.rotation || 0;
            const fs2 = p.fontSize || 48;
            const fw = p.font === 'bold' ? 'bold' : 'normal';
            const fi = p.font === 'italic' ? 'italic' : 'normal';
            const fid = 'f' + i;
            if (p.shadow) {
                const blur = ((p.shadowBlur || 10) / 3).toFixed(1);
                defs += `<filter id="${fid}"><feDropShadow dx="2" dy="2" stdDeviation="${blur}" flood-color="${esc(p.shadowColor || '#000')}"/></filter>`;
            }
            body += `<text x="${p.x || 100}" y="${p.y || 200}"
              font-size="${fs2}" font-family="Arial,sans-serif"
              font-weight="${fw}" font-style="${fi}"
              fill="${esc(p.color || '#fff')}" opacity="${op}"
              ${p.shadow ? `filter="url(#${fid})"` : ''}
              transform="rotate(${rot},${p.x || 100},${p.y || 200})">${esc(p.text || '')}</text>`;
        }

        if (layer.type === 'image') {
            const uri = p.url ? (imgCache[p.url] || null) : null;
            if (uri) {
                const x = p.x || 0, y = p.y || 0, iw = p.w || w, ih = p.h || h;
                const rot = p.rotation || 0;
                body += `<image href="${uri}" x="${x}" y="${y}" width="${iw}" height="${ih}"
                  opacity="${op}" preserveAspectRatio="xMidYMid slice"
                  transform="rotate(${rot},${x + iw / 2},${y + ih / 2})"/>`;
            }
        }

        if (layer.type === 'progress') {
            const px2 = p.x || 0, py2 = p.y || 0, pw = p.w || 800, ph2 = p.h || 24;
            const rad = Math.max(0, p.radius ?? 12);
            const val = Math.max(0, Math.min(1, p.value || 0));
            body += `<rect x="${px2}" y="${py2}" width="${pw}" height="${ph2}" rx="${rad}" ry="${rad}" fill="${esc(p.bg || '#333')}" opacity="${op}"/>`;
            if (val > 0.001) body += `<rect x="${px2}" y="${py2}" width="${(pw * val).toFixed(1)}" height="${ph2}" rx="${rad}" ry="${rad}" fill="${esc(p.color || '#7c3aed')}" opacity="${op}"/>`;
        }

        if (layer.type === 'particles') {
            const count = Math.min(p.count || 50, 150);
            const speed = p.speed || 2;
            const sz = p.size || 4;
            const col = p.color || '#a855f7';
            const rand = seededRand(i * 1000 + 7);
            const pts = [];
            for (let j = 0; j < count; j++) {
                pts.push({ sx: rand() * w, sy: rand() * h, vx: (rand() - 0.5) * 2, vy: (rand() - 0.5) * 2, r: rand() * 3 + 1, ph: rand() * Math.PI * 2 });
            }
            pts.forEach(pt => {
                const px2 = ((pt.sx + pt.vx * speed * t * 60) % w + w) % w;
                const py2 = ((pt.sy + pt.vy * speed * t * 60) % h + h) % h;
                const a = ((0.4 + 0.6 * Math.abs(Math.sin(t * 1.25 + pt.ph))) * (p.opacity ?? 1)).toFixed(3);
                body += `<circle cx="${px2.toFixed(1)}" cy="${py2.toFixed(1)}" r="${(sz * pt.r).toFixed(1)}" fill="${esc(col)}" opacity="${a}"/>`;
            });
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>${defs}</defs>
  ${body}
</svg>`;
}

// ─── IMAGE PRE-FETCH ──────────────────────────────────────────────────────────
async function fetchImgCache(layers) {
    const cache = {};
    for (const layer of layers) {
        if (layer.type === 'image' && layer.props?.url && !cache[layer.props.url]) {
            try {
                const res = await fetch(layer.props.url, { signal: AbortSignal.timeout(6000) });
                if (res.ok) {
                    const buf = await res.arrayBuffer();
                    const b64 = Buffer.from(buf).toString('base64');
                    const mime = res.headers.get('content-type') || 'image/jpeg';
                    cache[layer.props.url] = `data:${mime};base64,${b64}`;
                }
            } catch (_) { /* skip if URL fails */ }
        }
    }
    return cache;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
/**
 * Renders an OBS Studio project (base64 config) to an MP4 Buffer.
 * @param {string} configB64  - base64 project string from the HTML editor
 * @param {Function} [onProgress] - callback(percent 0-100)
 * @returns {Promise<Buffer>} MP4 video buffer
 */
export async function renderObsToVideo(configB64, onProgress) {
    const project = decodeObsConfig(configB64);
    const { w, h, layers, kf } = project;

    // Clamp fps/duration for server render
    const fps  = Math.min(Math.max(project.fps || 30, 10), 30);
    const dur  = Math.min(Math.max(project.dur || 5, 1), 90);
    const total = Math.ceil(fps * dur);

    // Scale down large resolutions
    const maxDim = 1280;
    const scale  = Math.min(1, maxDim / Math.max(w, h));
    const rw = Math.round(w  * scale);
    const rh = Math.round(h * scale);

    // Pre-fetch images
    const imgCache = await fetchImgCache(layers);

    // Temp directory
    const tmpDir = mkdtempSync(join(tmpdir(), 'obs_'));

    try {
        // ── Render frames ──
        for (let f = 0; f < total; f++) {
            const t   = f / fps;
            const svg = buildFrameSvg(project, t, imgCache);
            const fp  = join(tmpDir, `f${String(f).padStart(5, '0')}.png`);

            let sh = sharp(Buffer.from(svg));
            if (scale < 1) sh = sh.resize(rw, rh);
            await sh.png({ compressionLevel: 1 }).toFile(fp);

            if (onProgress && f % Math.max(1, Math.floor(total / 20)) === 0) {
                onProgress(Math.round((f / total) * 80));
            }
        }

        // ── Assemble with ffmpeg ──
        const out = join(tmpDir, 'video.mp4');
        await new Promise((resolve, reject) => {
            fluent()
                .input(join(tmpDir, 'f%05d.png'))
                .inputFPS(fps)
                .videoCodec('libx264')
                .outputOptions(['-pix_fmt yuv420p', '-crf 22', '-preset fast', '-movflags +faststart'])
                .output(out)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        if (onProgress) onProgress(100);

        const buf = readFileSync(out);
        return buf;

    } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}
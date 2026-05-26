#!/usr/bin/env node
//
// server.js - Discarr web UI backend
// Relative Path: ./projects/discarr/server.js
//
// Scan VIDEO_TS/BDMV directories, map titles to episodes via web UI,
// queue HEVC encodes via ffmpeg (local or SSH), notify Sonarr/Radarr + Tdarr on completion.
//

'use strict';

const http    = require('http');
const https   = require('https');
const { spawn, execFile } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { scan, extractIfoChapters } = require('./scanner');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT        = parseInt(process.env.PORT || '8603', 10);
const PUBLIC_DIR  = path.join(__dirname, 'public');
const CONFIG_PATH = process.env.DISCARR_CONFIG
    || path.join(os.homedir(), '.config/media-postprocessor/api-keys.conf');
const LOG_PATH    = process.env.DISCARR_LOG
    || path.join(os.homedir(), '.local/share/discarr/jobs.log');
const QUEUE_PATH  = process.env.DISCARR_QUEUE
    || path.join(os.homedir(), '.local/share/discarr/pending-queue.json');
// Settings overlay: writable JSON layered on top of (possibly read-only) CONFIG_PATH
const SETTINGS_PATH = process.env.DISCARR_SETTINGS
    || path.join(path.dirname(QUEUE_PATH), 'settings.json');

// Known keys that can be written via the settings API
const SETTINGS_KEYS = new Set([
    'SONARR_URL','SONARR_API_KEY','TMDB_API_KEY',
    'RADARR_URL','RADARR_API_KEY',
    'TDARR_URL','TDARR_LIBRARY_ID','ENCODE_SSH_HOST',
    'FFMPEG_BIN','FFPROBE_BIN','OUTPUT_BASE',
]);

function loadConfig() {
    // Load primary config (may be read-only in Docker)
    const cfg = {};
    try {
        const lines = fs.readFileSync(CONFIG_PATH, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^([A-Z_]+)=(.+)$/);
            if (m) cfg[m[1]] = m[2].trim();
        }
    } catch { /* ignore — file may not exist yet */ }
    // Merge writable settings overlay (overrides CONFIG_PATH values)
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const overlay = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
            Object.assign(cfg, overlay);
        }
    } catch { /* ignore corrupt settings */ }
    return cfg;
}

function saveSettings(updates) {
    ensureDir(SETTINGS_PATH);
    let current = {};
    try {
        if (fs.existsSync(SETTINGS_PATH))
            current = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch { /* start fresh */ }
    for (const [k, v] of Object.entries(updates)) {
        if (v === '') delete current[k];   // empty string = clear the override
        else current[k] = v;
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2));
}

let cfg = loadConfig();

// ---------------------------------------------------------------------------
// Persistence helpers (shared pattern with recovarr)
// ---------------------------------------------------------------------------
function ensureDir(p) {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendJobLog(job) {
    try {
        ensureDir(LOG_PATH);
        const record = JSON.stringify({
            id: job.id, type: job.type, status: job.status,
            sourcePath: job.sourcePath, mappings: job.mappings,
            createdAt: job.createdAt, finishedAt: Date.now(),
            lines: job.lines, exitCode: job.exitCode,
        });
        fs.appendFileSync(LOG_PATH, record + '\n');
    } catch (err) { console.warn('Failed to write job log:', err.message); }
}

function loadJobLog() {
    try {
        if (!fs.existsSync(LOG_PATH)) return;
        const raw = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
        let loaded = 0;
        for (const line of raw.slice(-200)) {
            try {
                const r = JSON.parse(line);
                if (!r.id || jobs.has(r.id)) continue;
                jobs.set(r.id, { ...r, archived: true, sseClients: new Set() });
                loaded++;
            } catch { /* skip */ }
        }
        if (loaded) console.log(`Loaded ${loaded} archived job(s) from log`);
    } catch (err) { console.warn('Failed to read job log:', err.message); }
}

function savePendingQueue() {
    try {
        ensureDir(QUEUE_PATH);
        const pending = [...jobs.values()]
            .filter(j => !j.archived && ['queued','running','scanning'].includes(j.status))
            .map(j => ({ id: j.id, type: j.type, sourcePath: j.sourcePath,
                         mappings: j.mappings, createdAt: j.createdAt }));
        fs.writeFileSync(QUEUE_PATH, JSON.stringify(pending, null, 2));
    } catch (err) { console.warn('Failed to save pending queue:', err.message); }
}

function loadPendingQueue() {
    try {
        if (!fs.existsSync(QUEUE_PATH)) return;
        const pending = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
        if (!Array.isArray(pending)) return;
        let restored = 0;
        for (const entry of pending) {
            if (!entry.id || jobs.has(entry.id)) continue;
            jobs.set(entry.id, {
                ...entry, status: 'queued',
                lines: ['[discarr] Re-queued after server restart'],
                exitCode: null, sseClients: new Set(),
            });
            restored++;
        }
        if (restored) console.log(`Restored ${restored} pending job(s) from queue`);
    } catch (err) { console.warn('Failed to load pending queue:', err.message); }
}

// ---------------------------------------------------------------------------
// Job model
// status: scanning | scan-done | scan-failed | queued | running | done | failed
// type:   scan | encode
// ---------------------------------------------------------------------------
const jobs = new Map();

function createJob(type, data) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
        id, type, status: type === 'scan' ? 'scanning' : 'queued',
        lines: [], exitCode: null, createdAt: Date.now(),
        sseClients: new Set(),
        ...data,
    };
    jobs.set(id, job);
    savePendingQueue();
    return job;
}

function pushLine(job, line) {
    job.lines.push(line);
    for (const res of job.sseClients)
        res.write(`data: ${JSON.stringify(line)}\n\n`);
}

function sendEvent(job, event, data) {
    for (const res of job.sseClients)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function finishJob(job, exitCode) {
    job.exitCode = exitCode;
    if (!['scan-done','scan-failed'].includes(job.status))
        job.status = exitCode === 0 ? 'done' : 'failed';
    job.finishedAt = Date.now();
    sendEvent(job, 'done', { exitCode, status: job.status });
    for (const res of job.sseClients) res.end();
    job.sseClients.clear();
    if (job.type === 'encode') appendJobLog(job);
    savePendingQueue();
}

// ---------------------------------------------------------------------------
// Metadata lookup — Sonarr first, TMDB fallback
// ---------------------------------------------------------------------------
function arrRequest(method, baseUrl, apiKey, endpoint, body) {
    return new Promise((resolve, reject) => {
        const url    = new URL(`${baseUrl}/api/v3/${endpoint}`);
        const isHttps = url.protocol === 'https:';
        const lib    = isHttps ? https : http;
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + (url.search || ''),
            method,
            headers: {
                'X-Api-Key': apiKey, 'Accept': 'application/json',
                ...(payload ? { 'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            timeout: 15_000,
        };
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve(null); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

function tmdbRequest(endpoint) {
    return new Promise((resolve, reject) => {
        if (!cfg.TMDB_API_KEY) return reject(new Error('TMDB_API_KEY not configured'));
        const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
        url.searchParams.set('api_key', cfg.TMDB_API_KEY);
        const req = https.get(url.toString(), { timeout: 10_000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve(null); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function lookupSeries(query) {
    cfg = loadConfig();
    const results = [];

    // Sonarr lookup
    if (cfg.SONARR_URL && cfg.SONARR_API_KEY) {
        try {
            const found = await arrRequest('GET', cfg.SONARR_URL, cfg.SONARR_API_KEY,
                `series/lookup?term=${encodeURIComponent(query)}`);
            for (const s of (found || []).slice(0, 8)) {
                results.push({
                    source:   'sonarr',
                    id:       s.tvdbId || s.id,
                    sonarrId: s.id,
                    title:    s.title,
                    year:     s.year,
                    poster:   s.images?.find(i => i.coverType === 'poster')?.remoteUrl || null,
                    seasons:  s.seasons?.map(se => se.seasonNumber).filter(n => n > 0) || [],
                    inLibrary: !!s.path,
                });
            }
        } catch (err) { console.warn('Sonarr lookup failed:', err.message); }
    }

    // TMDB fallback
    if (results.length === 0 && cfg.TMDB_API_KEY) {
        try {
            const found = await tmdbRequest(`search/tv?query=${encodeURIComponent(query)}`);
            for (const s of (found?.results || []).slice(0, 8)) {
                results.push({
                    source:   'tmdb',
                    id:       s.id,
                    title:    s.name,
                    year:     s.first_air_date?.slice(0, 4),
                    poster:   s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : null,
                    seasons:  [],
                    inLibrary: false,
                });
            }
        } catch (err) { console.warn('TMDB lookup failed:', err.message); }
    }

    return results;
}

async function lookupEpisodes(source, id, season) {
    cfg = loadConfig();

    if (source === 'sonarr' && cfg.SONARR_URL && cfg.SONARR_API_KEY) {
        // Find series by sonarrId or tvdbId
        const allSeries = await arrRequest('GET', cfg.SONARR_URL, cfg.SONARR_API_KEY, 'series');
        const series = (allSeries || []).find(s => s.id === id || s.tvdbId === id);
        if (!series) throw new Error('Series not found in Sonarr');

        const episodes = await arrRequest('GET', cfg.SONARR_URL, cfg.SONARR_API_KEY,
            `episode?seriesId=${series.id}&seasonNumber=${season}`);
        return (episodes || [])
            .sort((a, b) => a.episodeNumber - b.episodeNumber)
            .map(e => ({
                episode:  e.episodeNumber,
                season:   e.seasonNumber,
                title:    e.title,
                airDate:  e.airDateUtc?.slice(0, 10) || null,
                overview: e.overview || null,
                hasFile:  e.hasFile,
            }));
    }

    if (source === 'tmdb' && cfg.TMDB_API_KEY) {
        const data = await tmdbRequest(`tv/${id}/season/${season}`);
        return (data?.episodes || []).map(e => ({
            episode:  e.episode_number,
            season:   e.season_number,
            title:    e.name,
            airDate:  e.air_date || null,
            overview: e.overview || null,
            hasFile:  false,
        }));
    }

    throw new Error('No metadata source available — add SONARR_URL/SONARR_API_KEY or TMDB_API_KEY to config');
}

// ---------------------------------------------------------------------------
// Tdarr integration (optional post-encode hook)
// ---------------------------------------------------------------------------
async function notifyTdarr(outputPath) {
    if (!cfg.TDARR_URL) return;
    try {
        // Tdarr v2 API: trigger a library scan on the relevant library
        // If TDARR_LIBRARY_ID is set, trigger rescan of that library
        // Otherwise just log a warning that the user should configure it
        if (!cfg.TDARR_LIBRARY_ID) {
            console.warn('[Tdarr] TDARR_URL set but TDARR_LIBRARY_ID not configured — skipping notify');
            return;
        }
        const url  = new URL(`${cfg.TDARR_URL}/api/v2/library/source`);
        const isHttps = url.protocol === 'https:';
        const lib  = isHttps ? https : http;
        const body = JSON.stringify({
            data: { libraryId: cfg.TDARR_LIBRARY_ID, action: 'folderScan', folder: outputPath }
        });
        await new Promise((resolve, reject) => {
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 10_000,
            };
            const req = lib.request(options, res => {
                res.resume();
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
        console.log(`[Tdarr] Triggered library scan for ${outputPath}`);
    } catch (err) {
        console.warn('[Tdarr] Notify failed:', err.message);
    }
}

async function notifySonarr(outputPath) {
    if (!cfg.SONARR_URL || !cfg.SONARR_API_KEY) return;
    try {
        await arrRequest('POST', cfg.SONARR_URL, cfg.SONARR_API_KEY, 'command',
            { name: 'DownloadedEpisodesScan', path: outputPath });
        console.log(`[Sonarr] Triggered scan for ${outputPath}`);
    } catch (err) {
        console.warn('[Sonarr] Notify failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Encode presets
// ---------------------------------------------------------------------------
const PRESETS = {
    'hevc-nvenc':     ['-c:v','hevc_nvenc','-rc','constqp','-qp','22','-preset','p4','-c:a','copy'],
    'hevc-qsv':       ['-c:v','hevc_qsv','-global_quality','22','-c:a','copy'],
    'hevc-vaapi':     ['-c:v','hevc_vaapi','-qp','22','-c:a','copy'],
    'x265-software':  ['-c:v','libx265','-crf','22','-preset','medium','-c:a','copy'],
    'h264-nvenc':     ['-c:v','h264_nvenc','-rc','constqp','-qp','22','-preset','p4','-c:a','copy'],
};

// HandBrakeCLI preset templates — substitution handled in buildHandbrakeCmd()
// These use {dvd_path}, {title_set}, {input}, {output} tokens (not ffmpeg args)
const HANDBRAKE_PRESETS = {
    'handbrake-hevc':    '--encoder x265     --quality 22 --aencoder copy --subtitle scan --subtitle-forced',
    'handbrake-h264':    '--encoder x264     --quality 22 --aencoder copy --subtitle scan --subtitle-forced',
    'handbrake-nvenc':   '--encoder nvenc_h265 --quality 22 --aencoder copy',
};

function isHandbrakePreset(preset) {
    return preset && (preset.startsWith('handbrake-') || HANDBRAKE_PRESETS[preset]);
}

// Returns [bin, ...args] — caller spawns directly (no shell required)
function buildHandbrakeArgs(mapping) {
    const { diskType, diskPath, titleSet, hbTitle, filePath, outputPath, preset, startSec, endSec } = mapping;
    const hbBin  = process.env.HANDBRAKE_BIN || 'HandBrakeCLI';
    const hbArgs = (HANDBRAKE_PRESETS[preset] || HANDBRAKE_PRESETS['handbrake-hevc']).split(/\s+/).filter(Boolean);

    // HB-scan titles supply hbTitle and use the disc root directly (not /VIDEO_TS subdir),
    // because HandBrake resolves VIDEO_TS internally from the parent path.
    const input    = hbTitle ? diskPath : (diskType === 'dvd' ? `${diskPath}/VIDEO_TS` : filePath);
    const titleNum = hbTitle ?? (diskType === 'dvd' ? titleSet : null);
    const args  = ['--input', input, '--output', outputPath];

    if (titleNum) args.push('--title', String(titleNum));
    if (startSec > 0) args.push('--start-at', `duration:${startSec}`);
    if (endSec   > 0) args.push('--stop-at',  `duration:${endSec - (startSec || 0)}`);

    args.push(...hbArgs);
    return [hbBin, args];
}

// Build the ffmpeg input args for a DVD title set
// concatVobs: array of full VOB paths
function buildDvdInput(vobPaths) {
    return ['-i', 'concat:' + vobPaths.join('|')];
}

// Build ffmpeg args for a single file (BDMV .m2ts)
function buildFileInput(filePath) {
    return ['-i', filePath];
}

// Run a single encode mapping on this host
async function runLocalEncode(job, mapping) {
    cfg = loadConfig();
    const { diskPath, diskType, vobPaths, filePath,
            outputPath, preset, customScript, audioTrack, subTrack } = mapping;

    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // HB-scan titles have empty vobPaths — ffmpeg concat can't address them.
    // Treat titleSet as the HB title number and force HandBrake.
    if (!isHandbrakePreset(preset) && !customScript && diskType === 'dvd'
            && !vobPaths?.length && !filePath) {
        pushLine(job, `[encode] No VOB paths — routing to HandBrake (title ${mapping.hbTitle ?? mapping.titleSet})`);
        mapping = { ...mapping, hbTitle: mapping.hbTitle ?? mapping.titleSet,
                                preset: 'handbrake-hevc' };
    }

    if (isHandbrakePreset(mapping.preset ?? preset)) {
        const [hbBin, hbArgs] = buildHandbrakeArgs(mapping);
        pushLine(job, `[encode] HandBrake: ${hbBin} ${hbArgs.join(' ')}`);
        return new Promise((resolve, reject) => {
            const proc = spawn(hbBin, hbArgs, { stdio: ['ignore','pipe','pipe'] });
            job.activeProc = proc;
            proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
            proc.stderr.on('data', d => {
                const line = d.toString().trim();
                if (line.match(/Encoding|fps|ETA|error/i)) pushLine(job, line);
            });
            proc.on('close', code => { job.activeProc = null; code === 0 ? resolve() : reject(new Error(`HandBrake exit ${code}`)); });
            proc.on('error', reject);
        });
    }

    if (customScript) {
        // Custom script: substitute {input}, {output}, {dvd_path}, {title_set}
        const inputArg = diskType === 'dvd' ? vobPaths[0] : filePath;
        const dvdPath  = diskPath ? `${diskPath}/VIDEO_TS` : (vobPaths[0] ? path.dirname(vobPaths[0]) : '');
        const cmd = customScript
            .replace(/\{input\}/g, inputArg)
            .replace(/\{dvd_path\}/g, dvdPath)
            .replace(/\{title_set\}/g, String(mapping.titleSet || 1))
            .replace(/\{output\}/g, outputPath);
        pushLine(job, `[encode] Custom script: ${cmd}`);
        return new Promise((resolve, reject) => {
            const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore','pipe','pipe'] });
            proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
            proc.stderr.on('data', d => pushLine(job, d.toString().trim()));
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
            proc.on('error', reject);
        });
    }

    const presetArgs = PRESETS[preset] || PRESETS['x265-software'];
    const ffmpegBin  = process.env.FFMPEG_BIN || 'ffmpeg';

    const inputArgs = diskType === 'dvd'
        ? buildDvdInput(vobPaths)
        : buildFileInput(filePath);

    // Audio/subtitle track mapping
    const trackArgs = [];
    if (audioTrack >= 0) {
        trackArgs.push('-map', '0:v:0', '-map', `0:a:${audioTrack}`);
    } else {
        trackArgs.push('-map', '0:v:0', '-map', '0:a');
    }
    if (subTrack >= 0) {
        trackArgs.push('-map', `0:s:${subTrack}`);
    }

    // Segment trimming:
    // - DVD (concat: input): input-side -ss fast-seek cannot cross VOB file boundaries.
    //   Use output-side -ss instead — slower (decodes and discards), but always frame-accurate.
    // - Other sources: input-side -ss is safe and fast.
    const preInputArgs  = [];
    const postInputArgs = [];
    if (diskType === 'dvd') {
        if (mapping.startSec > 0) postInputArgs.push('-ss', String(mapping.startSec));
    } else {
        if (mapping.startSec > 0) preInputArgs.push('-ss', String(mapping.startSec));
    }
    if (mapping.endSec > 0) postInputArgs.push('-t', String(mapping.endSec - (mapping.startSec || 0)));

    // For DVD sources, pcm_dvd audio cannot be stream-copied into MKV — transcode to AAC.
    const audioOverride = diskType === 'dvd' ? ['-c:a', 'aac', '-b:a', '192k'] : [];

    const args = ['-y', ...preInputArgs, ...inputArgs, ...trackArgs,
                  ...postInputArgs, ...presetArgs, ...audioOverride, outputPath];
    pushLine(job, `[encode] ffmpeg ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegBin, args, { stdio: ['ignore','pipe','pipe'] });
        job.activeProc = proc;
        proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
        proc.stderr.on('data', d => {
            const line = d.toString().trim();
            // Only surface progress lines and errors (ffmpeg is very verbose)
            if (line.match(/frame=|time=|speed=|Error|error/i)) pushLine(job, line);
        });
        proc.on('close', code => { job.activeProc = null; code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
        proc.on('error', reject);
    });
}

// Run encode on remote host via SSH
async function runSshEncode(job, mapping, sshHost) {
    cfg = loadConfig();
    const { diskPath, diskType, vobPaths, filePath,
            outputPath, preset, customScript, audioTrack, subTrack } = mapping;

    const outDir = path.dirname(outputPath);

    if (!isHandbrakePreset(preset) && !customScript && diskType === 'dvd'
            && !vobPaths?.length && !filePath) {
        pushLine(job, `[encode] No VOB paths — routing to HandBrake (title ${mapping.hbTitle ?? mapping.titleSet})`);
        mapping = { ...mapping, hbTitle: mapping.hbTitle ?? mapping.titleSet,
                                preset: 'handbrake-hevc' };
    }

    if (isHandbrakePreset(mapping.preset ?? preset)) {
        const [hbBin, hbArgs] = buildHandbrakeArgs(mapping);
        const cmd    = `${hbBin} ${hbArgs.map(a => `"${a.replace(/"/g,'\\"')}"`).join(' ')}`;
        const sshCmd = `mkdir -p "${outDir}" && ${cmd}`;
        pushLine(job, `[encode] SSH ${sshHost} HandBrake: ${cmd}`);
        return new Promise((resolve, reject) => {
            const proc = spawn('ssh', [sshHost, sshCmd], { stdio: ['ignore','pipe','pipe'] });
            job.activeProc = proc;
            proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
            proc.stderr.on('data', d => {
                const line = d.toString().trim();
                if (line.match(/Encoding|fps|ETA|error/i)) pushLine(job, line);
            });
            proc.on('close', code => { job.activeProc = null; code === 0 ? resolve() : reject(new Error(`HandBrake SSH exit ${code}`)); });
            proc.on('error', reject);
        });
    }

    if (customScript) {
        const inputArg = diskType === 'dvd' ? vobPaths[0] : filePath;
        const dvdPath  = diskPath ? `${diskPath}/VIDEO_TS` : (vobPaths[0] ? path.dirname(vobPaths[0]) : '');
        const cmd = customScript
            .replace(/\{input\}/g, inputArg)
            .replace(/\{dvd_path\}/g, dvdPath)
            .replace(/\{title_set\}/g, String(mapping.titleSet || 1))
            .replace(/\{output\}/g, outputPath);
        const sshCmd = `mkdir -p "${outDir}" && ${cmd}`;
        pushLine(job, `[encode] SSH ${sshHost}: ${sshCmd}`);
        return new Promise((resolve, reject) => {
            const proc = spawn('ssh', [sshHost, sshCmd], { stdio: ['ignore','pipe','pipe'] });
            job.activeProc = proc;
            proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
            proc.stderr.on('data', d => pushLine(job, d.toString().trim()));
            proc.on('close', code => { job.activeProc = null; code === 0 ? resolve() : reject(new Error(`Exit ${code}`)); });
            proc.on('error', reject);
        });
    }

    const presetArgs = PRESETS[preset] || PRESETS['x265-software'];
    const ffmpegBin  = process.env.FFMPEG_BIN || 'ffmpeg';

    const concatInput = diskType === 'dvd'
        ? 'concat:' + vobPaths.join('|')
        : filePath;

    const trackArgs = [];
    if (audioTrack >= 0) {
        trackArgs.push('-map', '0:v:0', '-map', `0:a:${audioTrack}`);
    } else {
        trackArgs.push('-map', '0:v:0', '-map', '0:a');
    }
    if (subTrack >= 0) trackArgs.push('-map', `0:s:${subTrack}`);

    const preInputArgs  = [];
    const postInputArgs = [];
    if (diskType === 'dvd') {
        if (mapping.startSec > 0) postInputArgs.push('-ss', String(mapping.startSec));
    } else {
        if (mapping.startSec > 0) preInputArgs.push('-ss', String(mapping.startSec));
    }
    if (mapping.endSec > 0) postInputArgs.push('-t', String(mapping.endSec - (mapping.startSec || 0)));

    const audioOverride = diskType === 'dvd' ? ['-c:a', 'aac', '-b:a', '192k'] : [];

    const ffmpegArgs = [...preInputArgs, '-y', '-i', concatInput,
                        ...trackArgs, ...postInputArgs, ...presetArgs, ...audioOverride, outputPath]
        .map(a => `"${a.replace(/"/g,'\\\"')}"`)
        .join(' ');

    const sshCmd = `mkdir -p "${outDir}" && ${ffmpegBin} ${ffmpegArgs}`;
    pushLine(job, `[encode] SSH ${sshHost}: ${ffmpegBin} ...`);

    return new Promise((resolve, reject) => {
        const proc = spawn('ssh', [sshHost, sshCmd], { stdio: ['ignore','pipe','pipe'] });
        job.activeProc = proc;
        proc.stdout.on('data', d => pushLine(job, d.toString().trim()));
        proc.stderr.on('data', d => {
            const line = d.toString().trim();
            if (line.match(/frame=|time=|speed=|Error|error/i)) pushLine(job, line);
        });
        proc.on('close', code => { job.activeProc = null; code === 0 ? resolve() : reject(new Error(`SSH encode exit ${code}`)); });
        proc.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Encode job runner
// ---------------------------------------------------------------------------
async function runEncodeJob(job) {
    job.status  = 'running';
    job.startedAt = Date.now();
    job.progress  = { current: 0, total: job.mappings.length, currentFile: null, failed: 0 };
    job.cancelled = false;
    job.activeProc = null;
    sendEvent(job, 'status', { status: 'running' });
    cfg = loadConfig();

    const sshHost = cfg.ENCODE_SSH_HOST || null;
    let failed = 0;

    for (const [i, mapping] of job.mappings.entries()) {
        if (job.cancelled) break;
        const file = path.basename(mapping.outputPath);
        job.progress.current     = i + 1;
        job.progress.currentFile = file;
        sendEvent(job, 'progress', { ...job.progress });
        pushLine(job, `[encode] (${i + 1}/${job.mappings.length}) → ${mapping.outputPath}`);
        try {
            if (sshHost) {
                await runSshEncode(job, mapping, sshHost);
            } else {
                await runLocalEncode(job, mapping);
            }
            if (job.cancelled) break;
            pushLine(job, `[encode] ✓ ${file}`);
            sendEvent(job, 'mapping-done', { index: i, outputPath: mapping.outputPath });

            // Post-encode notifications (fire and forget)
            const outDir = path.dirname(mapping.outputPath);
            notifySonarr(outDir).catch(() => {});
            notifyTdarr(outDir).catch(() => {});
        } catch (err) {
            if (job.cancelled) break;
            pushLine(job, `[encode] ✗ FAILED ${file}: ${err.message}`);
            failed++;
            job.progress.failed = failed;
            sendEvent(job, 'progress', { ...job.progress });
        }
    }

    job.activeProc = null;
    job.progress.currentFile = null;
    if (!job.cancelled) finishJob(job, failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Queue — one encode at a time (scans run concurrently)
// ---------------------------------------------------------------------------
let encodeRunning = false;

function processEncodeQueue() {
    if (encodeRunning) return;
    for (const job of jobs.values()) {
        if (job.type === 'encode' && job.status === 'queued') {
            encodeRunning = true;
            runEncodeJob(job).finally(() => {
                encodeRunning = false;
                processEncodeQueue();
            });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

function jobSummary(job) {
    return {
        id: job.id, type: job.type, status: job.status,
        sourcePath: job.sourcePath, scanResult: job.scanResult || null,
        mappings: job.mappings || null,
        lineCount: job.lines.length, exitCode: job.exitCode,
        createdAt: job.createdAt, finishedAt: job.finishedAt || null,
        startedAt: job.startedAt || null,
        archived: job.archived || false,
        progress: job.progress || null,
    };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p   = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Static UI
    if (req.method === 'GET' && p === '/')
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html');

    if (req.method === 'GET' && p === '/favicon.ico') {
        res.writeHead(204); res.end(); return;
    }

    // ── Scan ──────────────────────────────────────────────────────────────

    // POST /api/scan  { path: "..." }
    if (req.method === 'POST' && p === '/api/scan') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
        if (!body.path) return json(res, 400, { error: 'path required' });

        const job = createJob('scan', { sourcePath: body.path, scanResult: null });
        json(res, 202, jobSummary(job));

        // Run scan async — progress via SSE
        scan(body.path, (line) => pushLine(job, line))
            .then(result => {
                job.scanResult = result;
                job.status     = 'scan-done';
                job.finishedAt = Date.now();
                sendEvent(job, 'scan-done', { result });
                for (const c of job.sseClients) c.end();
                job.sseClients.clear();
            })
            .catch(err => {
                job.status     = 'scan-failed';
                job.finishedAt = Date.now();
                pushLine(job, `Scan error: ${err.message}`);
                sendEvent(job, 'done', { error: err.message });
                for (const c of job.sseClients) c.end();
                job.sseClients.clear();
            });
        return;
    }

    // ── Metadata lookup ───────────────────────────────────────────────────

    // GET /api/lookup?q=...&type=series
    if (req.method === 'GET' && p === '/api/lookup') {
        const q    = url.searchParams.get('q');
        const type = url.searchParams.get('type') || 'series';
        if (!q) return json(res, 400, { error: 'q required' });
        try {
            const results = type === 'series'
                ? await lookupSeries(q)
                : [];   // movie lookup — add TMDB movie search here later
            return json(res, 200, results);
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // GET /api/lookup/:source/:id/episodes?season=N
    const epMatch = p.match(/^\/api\/lookup\/(\w+)\/(\d+)\/episodes$/);
    if (req.method === 'GET' && epMatch) {
        const source = epMatch[1];
        const id     = parseInt(epMatch[2], 10);
        const season = parseInt(url.searchParams.get('season') || '1', 10);
        try {
            const episodes = await lookupEpisodes(source, id, season);
            return json(res, 200, episodes);
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // GET /api/chapters?videoTsPath=...&titleSet=N
    // On-demand IFO chapter extraction without a full rescan.
    // Used by the split editor when chapters weren't in the original scan.
    if (req.method === 'GET' && p === '/api/chapters') {
        const videoTsPath = url.searchParams.get('videoTsPath');
        const titleSet    = parseInt(url.searchParams.get('titleSet') || '1', 10);
        if (!videoTsPath) return json(res, 400, { error: 'videoTsPath required' });
        try {
            const chapters = await extractIfoChapters(videoTsPath, titleSet);
            return json(res, 200, { chapters, source: chapters.length ? 'ifo' : 'none' });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // ── Jobs ──────────────────────────────────────────────────────────────

    // GET /api/jobs
    if (req.method === 'GET' && p === '/api/jobs')
        return json(res, 200,
            [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(jobSummary));

    // GET /api/jobs/:id
    const jobMatch = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
    if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { error: 'Not found' });
        return json(res, 200, { ...jobSummary(job), lines: job.lines });
    }

    // GET /api/jobs/:id/stream  (SSE)
    const streamMatch = p.match(/^\/api\/jobs\/([a-f0-9]+)\/stream$/);
    if (req.method === 'GET' && streamMatch) {
        const job = jobs.get(streamMatch[1]);
        if (!job) return json(res, 404, { error: 'Not found' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
        });

        for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);

        const active = ['scanning','queued','running'].includes(job.status);
        if (!active) {
            res.write(`event: done\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`);
            if (job.type === 'scan' && job.scanResult)
                res.write(`event: scan-done\ndata: ${JSON.stringify({ result: job.scanResult })}\n\n`);
            res.end();
            return;
        }

        job.sseClients.add(res);
        req.on('close', () => job.sseClients.delete(res));
        return;
    }

    // POST /api/encode  { scanJobId, mappings: [...], preset, encodeHost }
    if (req.method === 'POST' && p === '/api/encode') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }

        if (!body.mappings?.length) return json(res, 400, { error: 'mappings required' });

        const job = createJob('encode', {
            sourcePath: body.sourcePath || '',
            mappings:   body.mappings,
            preset:     body.preset || 'x265-software',
        });
        processEncodeQueue();
        return json(res, 202, jobSummary(job));
    }

    // DELETE /api/jobs/:id
    const delMatch = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && delMatch) {
        const job  = jobs.get(delMatch[1]);
        if (!job) return json(res, 404, { error: 'Not found' });
        const force = url.searchParams.get('force') === 'true';
        if (job.status === 'running' && !force)
            return json(res, 409, { error: 'Job is running — use ?force=true to cancel' });

        // Cancel in-flight encode: set flag so the loop exits, kill the active process
        job.cancelled = true;
        if (job.activeProc) {
            try { job.activeProc.kill('SIGTERM'); } catch {}
        }
        // If this was the running encode, unblock the queue
        if (job.status === 'running') {
            encodeRunning = false;
            processEncodeQueue();
        }

        jobs.delete(delMatch[1]);
        savePendingQueue();
        return json(res, 200, { ok: true });
    }

    // GET /api/config  — capability probe for the UI
    if (req.method === 'GET' && p === '/api/config') {
        cfg = loadConfig();
        return json(res, 200, {
            sonarr:    !!(cfg.SONARR_URL && cfg.SONARR_API_KEY),
            radarr:    !!(cfg.RADARR_URL && cfg.RADARR_API_KEY),
            tmdb:      !!cfg.TMDB_API_KEY,
            tdarr:     !!(cfg.TDARR_URL && cfg.TDARR_LIBRARY_ID),
            encodeHost: cfg.ENCODE_SSH_HOST || null,
            outputBase: cfg.OUTPUT_BASE || null,
            presets:   [...Object.keys(PRESETS), ...Object.keys(HANDBRAKE_PRESETS)],
        });
    }

    // GET /api/activity?source=sonarr|radarr  — queue + recent history
    if (req.method === 'GET' && p === '/api/activity') {
        cfg = loadConfig();
        const source = url.searchParams.get('source') || 'sonarr';

        const isRadarr = source === 'radarr';
        const baseUrl  = isRadarr ? cfg.RADARR_URL  : cfg.SONARR_URL;
        const apiKey   = isRadarr ? cfg.RADARR_API_KEY : cfg.SONARR_API_KEY;

        if (!baseUrl || !apiKey)
            return json(res, 400, { error: `${source} not configured` });

        try {
            const includeParam = isRadarr ? 'includeMovie=true' : 'includeSeries=true&includeEpisode=true';

            // Request more history than we need so we can filter out 'grabbed'
            // events (those are already visible in the queue) and still surface
            // meaningful terminal events (imported, failed, deleted, renamed).
            const [rawQueue, rawHistory] = await Promise.all([
                arrRequest('GET', baseUrl, apiKey,
                    `queue?page=1&pageSize=200&${includeParam}&includeUnknownSeriesItems=true`),
                arrRequest('GET', baseUrl, apiKey,
                    `history?page=1&pageSize=100&sortKey=date&sortDirection=descending&${includeParam}`),
            ]);

            // Normalize queue items
            const queue = ((rawQueue?.records || rawQueue || [])).map(item => {
                const title  = isRadarr ? item.movie?.title  : item.series?.title;
                const year   = isRadarr ? item.movie?.year   : item.series?.year;
                const epInfo = isRadarr ? null : (item.episode
                    ? `S${String(item.episode.seasonNumber).padStart(2,'0')}E${String(item.episode.episodeNumber).padStart(2,'0')}`
                    : null);
                const pct = item.size > 0
                    ? Math.round((1 - item.sizeleft / item.size) * 100)
                    : null;

                // Show Scan button for any completed download — if it's not a disc
                // structure, the scanner will say so gracefully.
                const dlState = item.trackedDownloadState || '';
                const isComplete = pct === 100 || item.status === 'completed'
                    || item.sizeleft === 0 || dlState === 'ignored';
                const discReady  = isComplete;

                return {
                    id:          item.id,
                    title,
                    year,
                    epInfo,
                    epTitle:     item.episode?.title || null,
                    release:     item.title,
                    status:      item.status,
                    trackStatus: item.trackedDownloadStatus || 'ok',
                    dlState,
                    quality:     item.quality?.quality?.name || null,
                    client:      item.downloadClient || null,
                    pct,
                    size:        item.size,
                    sizeleft:    item.sizeleft,
                    outputPath:  item.outputPath || null,
                    discReady,
                };
            });

            // Normalize history items — skip 'grabbed' events since those are
            // already visible as active queue items; only surface terminal events.
            const history = ((rawHistory?.records || rawHistory || []))
            .filter(item => item.eventType !== 'grabbed')
            .slice(0, 30)
            .map(item => {
                const title  = isRadarr ? item.movie?.title  : item.series?.title;
                const year   = isRadarr ? item.movie?.year   : item.series?.year;
                const epInfo = isRadarr ? null : (item.episode
                    ? `S${String(item.episode.seasonNumber).padStart(2,'0')}E${String(item.episode.episodeNumber).padStart(2,'0')}`
                    : null);
                return {
                    id:        item.id,
                    title,
                    year,
                    epInfo,
                    epTitle:   item.episode?.title || null,
                    release:   item.sourceTitle,
                    eventType: item.eventType,
                    quality:   item.quality?.quality?.name || null,
                    client:    item.data?.downloadClient || null,
                    date:      item.date,
                };
            });

            return json(res, 200, { queue, history });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // DELETE /api/activity/:id?source=sonarr|radarr
    // Removes the queue item from arr tracking WITHOUT touching the download client.
    // Torrent keeps seeding; arr stops watching it. Use after Discarr encode is imported.
    const actDelMatch = p.match(/^\/api\/activity\/(\d+)$/);
    if (req.method === 'DELETE' && actDelMatch) {
        cfg = loadConfig();
        const queueId  = actDelMatch[1];
        const source   = url.searchParams.get('source') || 'sonarr';
        const isRadarr = source === 'radarr';
        const baseUrl  = isRadarr ? cfg.RADARR_URL  : cfg.SONARR_URL;
        const apiKey   = isRadarr ? cfg.RADARR_API_KEY : cfg.SONARR_API_KEY;
        if (!baseUrl || !apiKey)
            return json(res, 400, { error: `${source} not configured` });
        try {
            // blacklist=false → don't block future grabs
            // removeFromClient=false → keep seeding in qBittorrent
            await arrRequest('DELETE', baseUrl, apiKey,
                `queue/${queueId}?blacklist=false&removeFromClient=false&skipRedownload=true`);
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // GET /api/library?source=sonarr|radarr  — full library browse
    if (req.method === 'GET' && p === '/api/library') {
        cfg = loadConfig();
        const source = url.searchParams.get('source') || 'sonarr';

        if (source === 'sonarr') {
            if (!cfg.SONARR_URL || !cfg.SONARR_API_KEY)
                return json(res, 400, { error: 'Sonarr not configured' });
            try {
                const series = await arrRequest('GET', cfg.SONARR_URL, cfg.SONARR_API_KEY, 'series');
                const items = (series || []).map(s => {
                    const total   = s.statistics?.episodeCount    || 0;
                    const onDisk  = s.statistics?.episodeFileCount || 0;
                    return {
                        source:   'sonarr',
                        id:       s.tvdbId || s.id,
                        sonarrId: s.id,
                        title:    s.title,
                        year:     s.year,
                        poster:   s.images?.find(i => i.coverType === 'poster')?.remoteUrl || null,
                        seasons:  (s.seasons || []).map(se => se.seasonNumber).filter(n => n > 0),
                        inLibrary: true,
                        missing:  total - onDisk,
                        total,
                        onDisk,
                    };
                }).sort((a, b) => b.missing - a.missing);
                return json(res, 200, items);
            } catch (err) {
                return json(res, 500, { error: err.message });
            }
        }

        if (source === 'radarr') {
            if (!cfg.RADARR_URL || !cfg.RADARR_API_KEY)
                return json(res, 400, { error: 'Radarr not configured' });
            try {
                const movies = await arrRequest('GET', cfg.RADARR_URL, cfg.RADARR_API_KEY, 'movie');
                const items = (movies || []).map(m => ({
                    source:   'radarr',
                    id:       m.tmdbId || m.id,
                    radarrId: m.id,
                    title:    m.title,
                    year:     m.year,
                    poster:   m.images?.find(i => i.coverType === 'poster')?.remoteUrl || null,
                    seasons:  [],
                    inLibrary: true,
                    missing:  m.hasFile ? 0 : 1,
                    hasFile:  m.hasFile,
                    monitored: m.monitored,
                })).sort((a, b) => b.missing - a.missing);
                return json(res, 200, items);
            } catch (err) {
                return json(res, 500, { error: err.message });
            }
        }

        return json(res, 400, { error: 'source must be sonarr or radarr' });
    }

    // GET /api/settings  — current settings for the settings panel
    if (req.method === 'GET' && p === '/api/settings') {
        cfg = loadConfig();
        // Return URL/non-secret values as-is; mask API keys so they're not sent to browser
        const masked = k => cfg[k] ? '[configured]' : '';
        return json(res, 200, {
            SONARR_URL:      cfg.SONARR_URL      || '',
            SONARR_API_KEY:  masked('SONARR_API_KEY'),
            TMDB_API_KEY:    masked('TMDB_API_KEY'),
            TDARR_URL:       cfg.TDARR_URL        || '',
            TDARR_LIBRARY_ID: cfg.TDARR_LIBRARY_ID || '',
            ENCODE_SSH_HOST: cfg.ENCODE_SSH_HOST  || '',
            FFMPEG_BIN:      cfg.FFMPEG_BIN        || '',
            FFPROBE_BIN:     cfg.FFPROBE_BIN       || '',
            OUTPUT_BASE:     cfg.OUTPUT_BASE       || '',
        });
    }

    // POST /api/settings  — save settings overlay
    if (req.method === 'POST' && p === '/api/settings') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }

        const updates = {};
        for (const [k, v] of Object.entries(body)) {
            if (!SETTINGS_KEYS.has(k) || typeof v !== 'string') continue;
            if (v === '[configured]') continue;   // masked placeholder — skip
            updates[k] = v;                        // empty string = clear override
        }

        try {
            saveSettings(updates);
            cfg = loadConfig();
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    res.writeHead(404); res.end('Not found');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadJobLog();
loadPendingQueue();
processEncodeQueue();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Discarr listening on http://0.0.0.0:${PORT}`);
    console.log(`Config:  ${CONFIG_PATH}`);
    console.log(`Job log: ${LOG_PATH}`);
    console.log(`Queue:   ${QUEUE_PATH}`);
    if (!fs.existsSync(CONFIG_PATH)) console.warn('WARNING: config not found');
});

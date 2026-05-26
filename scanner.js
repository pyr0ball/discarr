//
// scanner.js - Discarr disk scanner
// Relative Path: ./projects/discarr/scanner.js
//
// Detects VIDEO_TS / BDMV structures, enumerates titles via ffprobe.
// Returns structured title list with duration, audio/subtitle tracks.
//

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const LSDVD   = process.env.LSDVD_BIN   || 'lsdvd';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDuration(secs) {
    const s = Math.round(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

// ---------------------------------------------------------------------------
// DVD chapter extraction from IFO files
// ---------------------------------------------------------------------------
// lsdvd reports chapter LENGTHS; we accumulate them to get start times.
// Falls back to ffprobe on the IFO if lsdvd isn't installed.
async function extractIfoChapters(videoTsPath, titleSetNum) {
    const parentDir = path.dirname(videoTsPath); // dir containing VIDEO_TS/

    // ── Strategy 1: lsdvd ──────────────────────────────────────────────────
    try {
        const lsdvdOut = await new Promise((resolve, reject) => {
            execFile(LSDVD, ['-c', '-t', String(titleSetNum), parentDir],
                { maxBuffer: 2 * 1024 * 1024 },
                (err, stdout) => err ? reject(err) : resolve(stdout));
        });

        const chapters = [];
        let accumSecs  = 0;
        for (const line of lsdvdOut.split('\n')) {
            // e.g.  "  Chapter: 01, Length: 00:12:47.333, Start Cell: 01"
            const m = line.match(/Chapter:\s*(\d+),\s*Length:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (!m) continue;
            chapters.push({
                index:    parseInt(m[1], 10) - 1,
                startSec: Math.round(accumSecs),
                title:    null,
            });
            accumSecs += parseInt(m[2], 10) * 3600
                       + parseInt(m[3], 10) * 60
                       + parseFloat(m[4]);
        }
        if (chapters.length > 1) return chapters;
    } catch { /* lsdvd not available or failed */ }

    // ── Strategy 2: direct binary IFO parser (PTT + PGCIT tables) ────────
    // ffprobe can't read DVD PTT chapter structure; we parse the binary directly.
    // VTSI_MAT header offsets (verified against spec and empirical data):
    //   0xC8 (4B BE): VTS_PTT_SRPT sector → chapter→(pgcn,pgn) map
    //   0xCC (4B BE): VTS_PGCIT sector    → PGC list with cell timing
    // PTT_SRPT layout: uint16 nTitles, uint16 reserved, uint32 lastByte,
    //                  then uint32 offsets[nTitles] — each offset relative to pttBase.
    // Each chapter entry: uint16 pgcn + uint16 pgn (4 bytes).
    // PGC fixed header ends at 0x103; program map follows immediately after color table.
    // Cell playback entry: 24 bytes, bytes 4-7 = BCD-encoded H:M:S:frames.
    try {
        const ifoName = `VTS_${String(titleSetNum).padStart(2, '0')}_0.IFO`;
        const ifoPath = path.join(videoTsPath, ifoName);
        if (!fs.existsSync(ifoPath)) throw new Error('IFO not found');

        const buf = fs.readFileSync(ifoPath);

        // ── PTT Search Table ──────────────────────────────────────────────
        const pttSector  = buf.readUInt32BE(0xC8);   // VTS_PTT_SRPT at 0xC8
        const pttBase    = pttSector * 2048;

        const nrSrpts    = buf.readUInt16BE(pttBase);        // nr_of_srpts
        if (nrSrpts < 1) throw new Error('PTT table empty');

        const pttLastByte   = buf.readUInt32BE(pttBase + 4);  // last_byte of PTT table
        // title offset array starts at pttBase+8 (one uint32 per title)
        const titleOffset   = buf.readUInt32BE(pttBase + 8);  // byte offset for title 1 within PTT
        const nextOffset    = nrSrpts >= 2
            ? buf.readUInt32BE(pttBase + 12)  // title 2 offset
            : pttLastByte + 1;

        const nChapters = Math.floor((nextOffset - titleOffset) / 4);
        if (nChapters < 1) throw new Error('no chapters in PTT for title 1');

        // Read (pgcn, pgn) pairs for each chapter of title 1
        const pttEntries = [];
        for (let c = 0; c < nChapters; c++) {
            const off  = pttBase + titleOffset + c * 4;
            const pgcn = buf.readUInt16BE(off);
            const pgn  = buf.readUInt16BE(off + 2);
            pttEntries.push({ pgcn, pgn });
        }

        // ── Program Chain Info Table ──────────────────────────────────────
        const pgcitSector = buf.readUInt32BE(0xCC);   // VTS_PGCIT at 0xCC
        const pgcitBase   = pgcitSector * 2048;

        const bcd = b => ((b >> 4) & 0x0F) * 10 + (b & 0x0F);

        function parsePgcCells(pgcn) {
            // PGCI_SRP: 8-byte entries starting at pgcitBase+8
            const srp      = pgcitBase + 8 + (pgcn - 1) * 8;
            const pgcStart = pgcitBase + buf.readUInt32BE(srp + 4);

            const nPrograms = buf.readUInt8(pgcStart + 0x02);
            const nCells    = buf.readUInt8(pgcStart + 0x03);

            // Table pointer section is PGC+0xFC–0x103 (command, prog_map, cell_pb, cell_pos).
            // Any valid pointer must point AFTER the pointer section, i.e. >= 0x104.
            // Some discs (especially older authoring tools) place program map data directly
            // at 0xFC (overwriting the pointer section), causing pointer reads to return
            // garbage values that are < 0x104.  In that case fall back to fixed offsets:
            //   program map at 0xFC (right after 16-color table which ends at 0xFB)
            //   cell playback immediately follows program map
            const cmdTbl = buf.readUInt16BE(pgcStart + 0xFC);
            let pmOffset, cpOffset;
            if (cmdTbl >= 0x104) {
                // Valid command table present — use explicit pointers
                const rawPm = buf.readUInt16BE(pgcStart + 0xFE);
                const rawCp = buf.readUInt16BE(pgcStart + 0x100);
                pmOffset = (rawPm >= 0x104 && rawPm <= 0x4000) ? rawPm : 0xFC;
                cpOffset = (rawCp > pmOffset && rawCp <= 0x4000) ? rawCp : pmOffset + nPrograms;
            } else {
                // No command table (or garbage pointer): program map starts right at 0xFC
                pmOffset = 0xFC;
                cpOffset = 0xFC + nPrograms;
            }

            // Program map: 1 byte per program = first cell (1-based) for that program
            const firstCell = [];
            for (let p = 0; p < nPrograms; p++) {
                firstCell.push(buf.readUInt8(pgcStart + pmOffset + p));
            }

            // Cell playback: 24 bytes each; bytes 4-7 = BCD H:M:S:frames
            const cellDur = [];
            for (let ci = 0; ci < nCells; ci++) {
                const cOff = pgcStart + cpOffset + ci * 24;
                const h = bcd(buf.readUInt8(cOff + 4));
                const m = bcd(buf.readUInt8(cOff + 5));
                const s = bcd(buf.readUInt8(cOff + 6));
                cellDur.push(h * 3600 + m * 60 + s);
            }

            return { firstCell, cellDur };
        }

        // Cache PGC data
        const pgcCache = {};
        const getPgc = pgcn => {
            if (!pgcCache[pgcn]) pgcCache[pgcn] = parsePgcCells(pgcn);
            return pgcCache[pgcn];
        };

        // Total duration per PGC (for accumulating across PGC boundaries)
        const uniquePgcns = [...new Set(pttEntries.map(e => e.pgcn))];
        const pgcTotal = {};
        for (const pgcn of uniquePgcns) {
            const { cellDur } = getPgc(pgcn);
            pgcTotal[pgcn] = cellDur.reduce((a, b) => a + b, 0);
        }

        // Walk chapters: accumulate absolute start time across PGC transitions
        const result = [];
        let absoluteBase = 0;
        let activePgcn = null;

        for (let c = 0; c < pttEntries.length; c++) {
            const { pgcn, pgn } = pttEntries[c];
            const { firstCell, cellDur } = getPgc(pgcn);

            if (pgcn !== activePgcn) {
                if (activePgcn !== null) absoluteBase += pgcTotal[activePgcn];
                activePgcn = pgcn;
            }

            const cellStart = (firstCell[pgn - 1] || 1) - 1;  // 0-based
            const secInPgc  = cellDur.slice(0, cellStart).reduce((a, b) => a + b, 0);

            result.push({ index: c, startSec: absoluteBase + secInPgc, title: null });
        }

        // Validate: chapters must be strictly increasing.
        // Discs with interleaved cell blocks (shared cells across titles, common on
        // BBC/PAL multi-episode DVDs) produce garbage cpOff values, causing cell
        // durations to be read from the PGC header bytes — resulting in chapters
        // that oscillate between 0 and absurdly large values.
        for (let i = 1; i < result.length; i++) {
            if (result[i].startSec <= result[i - 1].startSec) return [];
        }

        if (result.length > 1) return result;
    } catch (err) {
        // IFO binary parse failed — caller falls back to VOB chapters
    }

    return [];   // caller will keep whatever the VOB scan found
}

// ---------------------------------------------------------------------------
// HandBrake disc scan — enumerates all DVD titles via libdvdnav
// ---------------------------------------------------------------------------
// HandBrake writes scan output to stderr even on success.
// Chapter durations are reported as milliseconds per-chapter; we accumulate
// them into start times as we parse.
async function hbScanDisc(discRoot, onProgress) {
    const hbBin = process.env.HANDBRAKE_BIN || 'HandBrakeCLI';

    const stderr = await new Promise(resolve => {
        execFile(hbBin, ['--scan', '-i', discRoot, '--title', '0'],
            { maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
            (err, stdout, se) => resolve(se || ''));
    });

    const lines = stderr.split('\n')
        .map(l => l.replace(/^\[\d+:\d+:\d+\] /, '').trim());

    const raw = [];
    let cur = null;
    let audioIdx = 0;
    let subIdx   = 0;

    for (const line of lines) {
        const newTitle = line.match(/^scan: scanning title (\d+)/);
        if (newTitle) {
            if (cur) raw.push(cur);
            cur = { hbTitle: +newTitle[1], durationMs: 0, durationSecs: 0,
                    chapters: [], audioTracks: [], subtitleTracks: [], skipped: false };
            audioIdx = 0; subIdx = 0;
            continue;
        }
        if (!cur) continue;

        if (line.includes('ignoring title')) { cur.skipped = true; continue; }

        const dur = line.match(/^scan: duration is \d+:\d+:\d+ \((\d+) ms\)/);
        if (dur) {
            cur.durationMs   = +dur[1];
            cur.durationSecs = Math.round(+dur[1] / 1000);
            continue;
        }

        const chap = line.match(/^scan: chap (\d+), (\d+) ms/);
        if (chap) {
            const ms       = +chap[2];
            const prevEnd  = cur.chapters.length
                ? cur.chapters[cur.chapters.length - 1]._endMs : 0;
            cur.chapters.push({
                index:    +chap[1] - 1,
                startSec: Math.round(prevEnd / 1000),
                title:    null,
                _endMs:   prevEnd + ms,
            });
            continue;
        }

        // Audio: "scan: id=0x80bd, lang=English (AC3), 3cc=eng ext=0"
        const audio = line.match(/^scan: id=\S+, lang=(.+) \(([^)]+)\), 3cc=(\w+)/);
        if (audio) {
            cur.audioTracks.push({
                index:    audioIdx++,
                codec:    audio[2].toLowerCase().replace(/\s+/g, '_'),
                channels: 2,
                language: audio[3],
                label:    audio[1],
            });
            continue;
        }

        // Subtitle: "scan: id=0x20bd, lang=English (Wide Screen) [VOBSUB], 3cc=eng ext=0"
        const sub = line.match(/^scan: id=\S+, lang=(.+) \[([^\]]+)\], 3cc=(\w+)/);
        if (sub) {
            cur.subtitleTracks.push({ index: subIdx++, language: sub[3], label: sub[1] });
        }
    }
    if (cur) raw.push(cur);

    return raw
        .filter(t => !t.skipped && t.durationSecs >= 60)
        .map(t => {
            // Strip the common DVD-authoring stub: a final chapter of < 1 s marks the
            // very end of the title and would create a phantom split point.
            let chapters = t.chapters;
            if (chapters.length) {
                const last = chapters[chapters.length - 1];
                if (last._endMs - last.startSec * 1000 < 1000) chapters = chapters.slice(0, -1);
            }
            chapters = chapters.map(({ _endMs, ...ch }) => ch);

            onProgress?.(`  HB title ${t.hbTitle}: ${formatDuration(t.durationSecs)}`
                + ` · ${chapters.length} chapters · ${t.audioTracks.length} audio`);
            return {
                id:             `hbt${t.hbTitle}`,
                hbTitle:        t.hbTitle,
                titleSet:       t.hbTitle,   // kept for display/compat
                duration:       formatDuration(t.durationSecs),
                durationSecs:   t.durationSecs,
                chapterCount:   chapters.length,
                chapters,
                videoCodec:     'mpeg2video',
                audioTracks:    t.audioTracks,
                subtitleTracks: t.subtitleTracks,
                vobFiles:       [],
                fileSizeBytes:  0,
                hbScan:         true,
            };
        });
}

// DVD disc scanner — HandBrake scan first, VTS binary parser as fallback
async function scanDvdDisc(discRoot, videoTsPath, onProgress) {
    try {
        const titles = await hbScanDisc(discRoot, onProgress);
        if (titles.length > 0) {
            onProgress?.(`  HandBrake scan: ${titles.length} title(s) found`);
            return titles;
        }
        onProgress?.('  HandBrake scan returned no valid titles — falling back to VTS parser');
    } catch (err) {
        onProgress?.(`  HandBrake scan failed (${err.message}) — using VTS parser`);
    }
    return scanVideoTs(videoTsPath, onProgress);
}

function ffprobe(input, extraArgs = []) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'quiet',
            // Larger probe window needed for MPEG2 VOBs with broken PTS timestamps
            '-probesize', '100M',
            '-analyzeduration', '100M',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            '-show_chapters',
            ...extraArgs,
            input,
        ];
        execFile(FFPROBE, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); }
            catch (e) { reject(e); }
        });
    });
}

// ---------------------------------------------------------------------------
// Single video file scanner (AVI, MKV, MP4, etc.)
// ---------------------------------------------------------------------------
async function scanVideoFile(filePath, onProgress) {
    onProgress?.(`  Scanning file: ${path.basename(filePath)}`);
    const fileSizeBytes = fs.statSync(filePath).size;
    try {
        const info = await ffprobe(filePath);
        const duration = parseFloat(info.format?.duration || 0);
        if (duration < 1) return [];

        const videoStreams = (info.streams || []).filter(s => s.codec_type === 'video');
        const audioStreams = (info.streams || []).filter(s => s.codec_type === 'audio');
        const subStreams   = (info.streams || []).filter(s => s.codec_type === 'subtitle');
        const rawChapters  = info.chapters || [];

        const chapterMarks = rawChapters.map(ch => ({
            index:    ch.id,
            startSec: Math.round(parseFloat(ch.start_time || 0)),
            title:    ch.tags?.title || null,
        }));

        return [{
            id:             't1',
            titleSet:       1,
            duration:       formatDuration(duration),
            durationSecs:   Math.round(duration),
            chapterCount:   chapterMarks.length,
            chapters:       chapterMarks,
            videoCodec:     videoStreams[0]?.codec_name || 'unknown',
            audioTracks:    audioStreams.map((s, i) => ({
                index:    i,
                codec:    s.codec_name,
                channels: s.channels || 2,
                language: s.tags?.language || 'und',
                label:    s.tags?.title || null,
            })),
            subtitleTracks: subStreams.map((s, i) => ({
                index:    i,
                language: s.tags?.language || 'und',
                label:    s.tags?.title || null,
            })),
            file:         path.basename(filePath),
            fileSizeBytes,
        }];
    } catch (err) {
        onProgress?.(`  Failed to scan ${path.basename(filePath)}: ${err.message}`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------
function detectLayout(sourcePath) {
    // If the path is a plain file (e.g. .avi, .mkv), treat it as a single video title
    let stat;
    try { stat = fs.statSync(sourcePath); } catch { return { type: 'unknown' }; }
    if (stat.isFile()) return { type: 'video', filePath: sourcePath };

    const entries = fs.readdirSync(sourcePath).map(e => ({
        name: e,
        lname: e.toLowerCase(),
        full: path.join(sourcePath, e),
        isDir: fs.statSync(path.join(sourcePath, e)).isDirectory(),
    }));

    // Multi-disk: subdirs matching Disk1/Disc1/DISK_1 etc. (explicit naming)
    const diskDirs = entries.filter(e =>
        e.isDir && /^(disk|disc)\s*[-_]?\s*\d+$/i.test(e.name)
    ).sort((a, b) => {
        const na = parseInt(a.name.match(/\d+/)[0]);
        const nb = parseInt(b.name.match(/\d+/)[0]);
        return na - nb;
    });

    if (diskDirs.length > 0) {
        return { type: 'multi-disk', diskDirs };
    }

    // Multi-disk fallback: any subdirs that contain a VIDEO_TS or BDMV structure.
    // Catches scene-release naming (e.g. "ShowName.S01D01.DVD-GRP") where the
    // disc number is embedded mid-name rather than being a standalone label.
    const discNumOf = name => {
        // Match "Disc1", "Disk2", "D01", "D1" — any D/Disc/Disk followed by digits
        const m = name.match(/(?:Dis[ck]\s*|(?<![a-zA-Z])D)(\d+)\b/i);
        return m ? parseInt(m[1]) : null;
    };
    const contentDiskDirs = entries.filter(e =>
        e.isDir && (
            fs.existsSync(path.join(e.full, 'VIDEO_TS')) ||
            fs.existsSync(path.join(e.full, 'BDMV'))
        )
    ).sort((a, b) => {
        const na = discNumOf(a.name);
        const nb = discNumOf(b.name);
        if (na !== null && nb !== null && na !== nb) return na - nb;
        return a.name.localeCompare(b.name);
    });

    if (contentDiskDirs.length > 1) {
        return { type: 'multi-disk', diskDirs: contentDiskDirs };
    }

    // Single VIDEO_TS
    const vtDir = entries.find(e => e.isDir && e.lname === 'video_ts');
    if (vtDir) return { type: 'dvd', videoTsPath: vtDir.full };

    // Single BDMV
    const bdDir = entries.find(e => e.isDir && e.lname === 'bdmv');
    if (bdDir) return { type: 'bluray', bdmvPath: path.dirname(bdDir.full) };

    // ISO files
    const isos = entries.filter(e => !e.isDir && /\.iso$/i.test(e.name));
    if (isos.length > 0) return { type: 'iso', isoFiles: isos.map(e => e.full) };

    return { type: 'unknown' };
}

// ---------------------------------------------------------------------------
// VIDEO_TS scanner
// ---------------------------------------------------------------------------
async function scanVideoTs(videoTsPath, onProgress) {
    const files = fs.readdirSync(videoTsPath);

    // Group content VOBs by title set number (skip _0 = menu)
    const groups = {};
    for (const file of files) {
        const m = file.match(/^VTS_(\d{2})_(\d+)\.VOB$/i);
        if (!m) continue;
        const setNum = parseInt(m[1], 10);
        const partNum = parseInt(m[2], 10);
        if (partNum === 0) continue;
        if (!groups[setNum]) groups[setNum] = [];
        groups[setNum].push({ partNum, file, fullPath: path.join(videoTsPath, file) });
    }

    const titles = [];
    const setNums = Object.keys(groups).map(Number).sort((a, b) => a - b);

    for (const setNum of setNums) {
        const vobs = groups[setNum].sort((a, b) => a.partNum - b.partNum);
        const concatInput = 'concat:' + vobs.map(v => v.fullPath).join('|');
        const fileSizeBytes = vobs.reduce((sum, v) => {
            try { return sum + fs.statSync(v.fullPath).size; } catch { return sum; }
        }, 0);

        onProgress?.(`  Scanning title set ${setNum}...`);

        try {
            const info = await ffprobe(concatInput);
            let duration = parseFloat(info.format?.duration || 0);

            // MPEG2 VOBs with broken PTS timestamps can report 0, multi-day, or
            // implausibly short durations. Sanity-check using implied bitrate:
            // if ffprobe says "41 seconds" but the file is 7 GB, that's ~1.4 Gbps —
            // physically impossible for MPEG2 DVD (max ~10 Mbps).
            // Fall back to size-based estimate at MPEG2 DVD average of ~4.5 Mbps.
            const MAX_SANE_SECS    = 8 * 3600;         // >8h is bogus for a disc title
            const MAX_SANE_BITRATE = 15 * 1024 * 1024 / 8; // 15 Mbps in bytes/sec
            const impliedBitrate   = duration > 0 ? fileSizeBytes / duration : Infinity;
            if (duration <= 0 || duration > MAX_SANE_SECS || impliedBitrate > MAX_SANE_BITRATE) {
                const estimated = fileSizeBytes / 562500; // 4.5 Mbps avg
                onProgress?.(`  Title set ${setNum}: ffprobe duration unreliable (${formatDuration(duration)}, ${Math.round(impliedBitrate/125000)} Mbps implied) — estimating ${formatDuration(estimated)} from file size`);
                duration = estimated;
            }

            // Skip only if both duration is tiny AND file is tiny — real menus are <5 MB
            if (duration < 120 && fileSizeBytes < 5 * 1024 * 1024) continue;

            const videoStreams  = (info.streams || []).filter(s => s.codec_type === 'video');
            const audioStreams  = (info.streams || []).filter(s => s.codec_type === 'audio');
            const subStreams    = (info.streams || []).filter(s => s.codec_type === 'subtitle');
            const rawChapters   = info.chapters || [];

            // VOB stream chapters (from NAV packets)
            let chapterMarks = rawChapters.map(ch => ({
                index:    ch.id,
                startSec: Math.round(parseFloat(ch.start_time || 0)),
                title:    ch.tags?.title || null,
            }));

            // IFO chapters are more reliable for DVDs — upgrade if they give more detail
            const ifoChapters = await extractIfoChapters(videoTsPath, setNum);
            if (ifoChapters.length > chapterMarks.length) {
                onProgress?.(`  Title set ${setNum}: using ${ifoChapters.length} IFO chapters (VOB stream had ${chapterMarks.length})`);
                chapterMarks = ifoChapters;
            }

            titles.push({
                id:             `t${setNum}`,
                titleSet:       setNum,
                duration:       formatDuration(duration),
                durationSecs:   Math.round(duration),
                chapterCount:   chapterMarks.length,
                chapters:       chapterMarks,
                videoCodec:     videoStreams[0]?.codec_name || 'mpeg2video',
                audioTracks:    audioStreams.map((s, i) => ({
                    index:    i,
                    codec:    s.codec_name,
                    channels: s.channels || 2,
                    language: s.tags?.language || 'und',
                    label:    s.tags?.title || null,
                })),
                subtitleTracks: subStreams.map((s, i) => ({
                    index:    i,
                    language: s.tags?.language || 'und',
                    label:    s.tags?.title || null,
                })),
                vobFiles:       vobs.map(v => v.file),
                fileSizeBytes,
            });
        } catch (err) {
            onProgress?.(`  Skipping title set ${setNum}: ${err.message}`);
        }
    }

    return titles;
}

// ---------------------------------------------------------------------------
// BDMV scanner (Bluray)
// ---------------------------------------------------------------------------
async function scanBdmv(bdmvRoot, onProgress) {
    onProgress?.('  Scanning Bluray structure...');
    const titles = [];

    // BDMV/STREAM/ contains .m2ts files — each is a playlist item / title
    const streamDir = path.join(bdmvRoot, 'BDMV', 'STREAM');
    if (!fs.existsSync(streamDir)) {
        // Try uppercase
        const streamDirUpper = path.join(bdmvRoot, 'BDMV', 'stream');
        if (!fs.existsSync(streamDirUpper)) {
            onProgress?.('  BDMV/STREAM not found');
            return titles;
        }
    }

    const resolvedStreamDir = fs.existsSync(path.join(bdmvRoot, 'BDMV', 'STREAM'))
        ? path.join(bdmvRoot, 'BDMV', 'STREAM')
        : path.join(bdmvRoot, 'BDMV', 'stream');

    const m2tsFiles = fs.readdirSync(resolvedStreamDir)
        .filter(f => /\.m2ts$/i.test(f))
        .sort();

    for (const [i, file] of m2tsFiles.entries()) {
        const fullPath = path.join(resolvedStreamDir, file);
        const fileSizeBytes = fs.statSync(fullPath).size;

        // Skip small files (menus, trailers) — under ~100MB
        if (fileSizeBytes < 100 * 1024 * 1024) continue;

        onProgress?.(`  Scanning ${file}...`);
        try {
            const info = await ffprobe(fullPath);
            const duration = parseFloat(info.format?.duration || 0);
            if (duration < 120) continue;

            const audioStreams = (info.streams || []).filter(s => s.codec_type === 'audio');
            const subStreams   = (info.streams || []).filter(s => s.codec_type === 'subtitle');

            const bdChapters = info.chapters || [];
            const bdChapterMarks = bdChapters.map(ch => ({
                index: ch.id,
                startSec: Math.round(parseFloat(ch.start_time || 0)),
                title: ch.tags?.title || null,
            }));

            titles.push({
                id:             `m${i}`,
                titleSet:       i + 1,
                file,
                duration:       formatDuration(duration),
                durationSecs:   Math.round(duration),
                chapterCount:   bdChapters.length,
                chapters:       bdChapterMarks,
                videoCodec:     (info.streams || []).find(s => s.codec_type === 'video')?.codec_name || 'h264',
                audioTracks:    audioStreams.map((s, j) => ({
                    index:    j,
                    codec:    s.codec_name,
                    channels: s.channels || 2,
                    language: s.tags?.language || 'und',
                    label:    s.tags?.title || null,
                })),
                subtitleTracks: subStreams.map((s, j) => ({
                    index:    j,
                    language: s.tags?.language || 'und',
                    label:    s.tags?.title || null,
                })),
                vobFiles:       [file],
                fileSizeBytes,
            });
        } catch (err) {
            onProgress?.(`  Skipping ${file}: ${err.message}`);
        }
    }

    return titles;
}

// ---------------------------------------------------------------------------
// Main scan entry point
// ---------------------------------------------------------------------------
async function scan(sourcePath, onProgress) {
    onProgress?.(`Scanning: ${sourcePath}`);
    const layout = detectLayout(sourcePath);
    onProgress?.(`Layout detected: ${layout.type}`);

    const result = {
        sourcePath,
        layout: layout.type,
        disks: [],
    };

    if (layout.type === 'multi-disk') {
        for (const [diskIdx, diskDir] of layout.diskDirs.entries()) {
            // Prefer an explicit disc indicator (Disc1, Disk2, D01) over the first
            // digit sequence in the name — scene releases embed the year or season
            // before the disc number, which would otherwise be grabbed first.
            const discM  = diskDir.name.match(/(?:Dis[ck]\s*|(?<![a-zA-Z])D)(\d+)\b/i);
            const diskNum = discM ? parseInt(discM[1]) : (diskIdx + 1);
            onProgress?.(`Disk ${diskNum}: ${diskDir.full}`);

            const diskLayout = detectLayout(diskDir.full);
            let titles = [];

            if (diskLayout.type === 'dvd') {
                onProgress?.(`  Type: DVD`);
                titles = await scanDvdDisc(diskDir.full, diskLayout.videoTsPath, onProgress);
            } else if (diskLayout.type === 'bluray') {
                onProgress?.(`  Type: Bluray`);
                titles = await scanBdmv(diskLayout.bdmvPath, onProgress);
            } else {
                onProgress?.(`  Unknown disk type in ${diskDir.full}`);
            }

            result.disks.push({ diskNum, path: diskDir.full, type: diskLayout.type, titles });
        }
    } else if (layout.type === 'dvd') {
        const titles = await scanDvdDisc(sourcePath, layout.videoTsPath, onProgress);
        result.disks.push({ diskNum: 1, path: sourcePath, type: 'dvd', titles });
    } else if (layout.type === 'bluray') {
        const titles = await scanBdmv(layout.bdmvPath, onProgress);
        result.disks.push({ diskNum: 1, path: sourcePath, type: 'bluray', titles });
    } else if (layout.type === 'video') {
        const titles = await scanVideoFile(layout.filePath, onProgress);
        // Use the file's parent directory as diskPath so encode mapping can find the file
        result.disks.push({ diskNum: 1, path: path.dirname(layout.filePath), type: 'video', titles });
    } else if (layout.type === 'iso') {
        onProgress?.('ISO files detected — mount manually and re-scan the mount point');
        result.error = 'ISO mounting not supported automatically — mount the ISO and point to the mount path';
    } else {
        onProgress?.('No VIDEO_TS or BDMV found at path');
        result.error = 'No recognizable disc structure found (expected VIDEO_TS/ or BDMV/ directory)';
    }

    const totalTitles = result.disks.reduce((sum, d) => sum + d.titles.length, 0);
    onProgress?.(`Scan complete: ${result.disks.length} disk(s), ${totalTitles} title(s)`);

    return result;
}

module.exports = { scan, detectLayout, extractIfoChapters, hbScanDisc };

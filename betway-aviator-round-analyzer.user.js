// ==UserScript==
// @name         Betway Aviator Predictor
// @namespace    http://tampermonkey.net/
// @version      9.0.0
// @description  Local round history and honest statistical summaries; does not predict future crash outcomes.
// @author       You
// @match        https://www.betway.co.bw/*aviator*
// @match        https://www.betway.co.bw/lobby/Casino/featured/Aviator*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        STORAGE_KEY: 'aviator_round_analyzer_v9',
        BACKUP_KEY: 'aviator_round_analyzer_v9_backup',
        LEGACY_KEY: 'aviator_ml_v8',
        LEGACY_BACKUP_KEY: 'aviator_ml_v8_backup',
        MAX_HISTORY: 5000,
        MAX_MULTIPLIER: 1000000,
        RECENT_WINDOW: 100,
        PINK_THRESHOLD: 3,
        BIG_PINK_THRESHOLD: 5,
        PANEL_ID: 'aviator-round-analyzer'
    });

    const BUCKETS = Object.freeze([
        { label: '1.00–1.49x', min: 1, max: 1.5 },
        { label: '1.50–1.99x', min: 1.5, max: 2 },
        { label: '2.00–2.99x', min: 2, max: 3 },
        { label: '3.00–4.99x', min: 3, max: 5 },
        { label: '5.00–9.99x', min: 5, max: 10 },
        { label: '10.00x+', min: 10, max: Infinity }
    ]);

    const DEFAULT_SETTINGS = Object.freeze({
        minimized: false,
        autoOrder: 'newest',
        position: null
    });
    const ALLOWED_SOURCES = new Set(['manual', 'import', 'auto']);

    let roundHistory = [];
    let settings = { ...DEFAULT_SETTINGS };
    let autoSnapshot = null;
    let suppressAutoSeed = false;
    let observer = null;
    let captureTimer = null;
    let panel = null;
    let saveWarning = '';

    function isValidMultiplier(value) {
        return Number.isFinite(value) && value >= 1 && value <= CONFIG.MAX_MULTIPLIER;
    }

    function parseMultiplierToken(token) {
        const match = String(token).trim().match(/^((?:\d+(?:\.\d+)?|\.\d+))\s*[x×]$/i);
        if (!match) return null;
        const value = Number(match[1]);
        return isValidMultiplier(value) ? value : null;
    }

    // Strict by design: explicit x-suffixed values are accepted from mixed text;
    // bare numbers are accepted only when the complete line is a list of numbers.
    function parseManualValues(inputText) {
        const lines = String(inputText ?? '').split(/\r?\n/);
        const values = [];
        const numericListPattern = /^(?:\d+(?:\.\d+)?|\.\d+)\s*[x×]?(?:[\s,;|]+(?:\d+(?:\.\d+)?|\.\d+)\s*[x×]?)*$/i;

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            const tokens = line
                .replace(/^[([{]+/g, '')
                .replace(/[)\]}.,]+$/g, '')
                .split(/[\s,;|]+/)
                .filter(Boolean);

            // Accept a whole line that consists only of multipliers, optionally mixed
            // with and without an x suffix. In arbitrary text, only x-suffixed tokens
            // are extracted so round IDs and other numbers are not mistaken for results.
            if (numericListPattern.test(line)) {
                for (const token of tokens) {
                    const value = Number(token.replace(/[x×]$/i, ''));
                    if (isValidMultiplier(value)) values.push(value);
                }
                continue;
            }

            const suffixed = tokens
                .map(parseMultiplierToken)
                .filter(value => value !== null);
            values.push(...suffixed);
        }

        return values.slice(0, CONFIG.MAX_HISTORY);
    }

    function normalizeValues(items) {
        if (!Array.isArray(items)) return [];
        return items.map(item => {
            if (typeof item === 'number' || typeof item === 'string') return Number(item);
            return Number(item && item.value);
        }).filter(isValidMultiplier);
    }

    function normalizeRound(item, fallbackSource = 'import') {
        const value = typeof item === 'number' || typeof item === 'string'
            ? Number(item)
            : Number(item && item.value);
        if (!isValidMultiplier(value)) return null;

        const suppliedTime = item && typeof item === 'object' ? Number(item.at ?? item.timestamp) : NaN;
        const dateIsRepresentable = Number.isFinite(suppliedTime) && suppliedTime > 0 && suppliedTime <= 8640000000000000;
        const suppliedSource = item && typeof item === 'object' && ALLOWED_SOURCES.has(item.source)
            ? item.source
            : fallbackSource;

        return {
            value,
            at: dateIsRepresentable ? suppliedTime : Date.now(),
            source: suppliedSource
        };
    }

    function quantile(values, probability) {
        if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(probability)) return null;
        const sorted = values.filter(isValidMultiplier).sort((a, b) => a - b);
        if (!sorted.length) return null;

        const p = Math.min(1, Math.max(0, probability));
        const position = (sorted.length - 1) * p;
        const lowerIndex = Math.floor(position);
        const upperIndex = Math.ceil(position);
        if (lowerIndex === upperIndex) return sorted[lowerIndex];
        const fraction = position - lowerIndex;
        return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
    }

    function wilsonInterval(successes, total, z = 1.96) {
        if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || !Number.isFinite(z) || z <= 0) {
            return null;
        }

        const n = Math.floor(total);
        const k = Math.min(n, Math.max(0, Math.floor(successes)));
        if (n === 0) return null;

        const p = k / n;
        const z2 = z * z;
        const denominator = 1 + z2 / n;
        const center = (p + z2 / (2 * n)) / denominator;
        const margin = (z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)))) / denominator;

        return {
            lower: Math.max(0, center - margin),
            upper: Math.min(1, center + margin)
        };
    }

    function empiricalRate(values, threshold) {
        const clean = normalizeValues(values);
        const successes = clean.filter(value => value >= threshold).length;
        return {
            threshold,
            successes,
            total: clean.length,
            rate: clean.length ? successes / clean.length : null,
            interval: wilsonInterval(successes, clean.length)
        };
    }

    function makeDistribution(values, buckets = BUCKETS) {
        const clean = normalizeValues(values);
        return buckets.map(bucket => ({
            label: bucket.label,
            count: clean.filter(value => value >= bucket.min && value < bucket.max).length,
            total: clean.length
        }));
    }

    function summarize(history, recentLimit = CONFIG.RECENT_WINDOW) {
        const allValues = normalizeValues(history);
        const recentValues = allValues.slice(0, Math.max(0, recentLimit));

        return {
            storedCount: allValues.length,
            recentCount: recentValues.length,
            recentMedian: quantile(recentValues, 0.5),
            recentP90: quantile(recentValues, 0.9),
            storedRate3: empiricalRate(allValues, CONFIG.PINK_THRESHOLD),
            storedRate5: empiricalRate(allValues, CONFIG.BIG_PINK_THRESHOLD),
            recentRate3: empiricalRate(recentValues, CONFIG.PINK_THRESHOLD),
            distribution: makeDistribution(recentValues)
        };
    }

    function valuesFromHistory(history) {
        if (!Array.isArray(history)) return [];
        return history.map(round => Number(round && round.value)).filter(isValidMultiplier);
    }

    // For newest-first lists, the unseen rounds are the prefix before the
    // longest suffix of `incoming` that matches the existing history's prefix.
    function longestSuffixPrefixOverlap(incoming, existing) {
        const left = normalizeValues(incoming);
        const right = normalizeValues(existing);
        const maxOverlap = Math.min(left.length, right.length);

        for (let size = maxOverlap; size > 0; size--) {
            let matches = true;
            for (let index = 0; index < size; index++) {
                if (Math.abs(left[left.length - size + index] - right[index]) > 1e-9) {
                    matches = false;
                    break;
                }
            }
            if (matches) return size;
        }
        return 0;
    }

    function mergeNewestFirst(incoming, existing) {
        const incomingValues = normalizeValues(incoming);
        const existingValues = normalizeValues(existing);
        const overlap = longestSuffixPrefixOverlap(incomingValues, existingValues);
        const added = incomingValues.slice(0, incomingValues.length - overlap);
        return {
            overlap,
            added,
            merged: [...added, ...existingValues].slice(0, CONFIG.MAX_HISTORY)
        };
    }

    function decodeStoredValue(raw) {
        if (raw == null) return null;
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function readStoredValue(key) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key, null);
                if (value != null) return value;
            }
        } catch (_) {
            // Fall back to localStorage if the userscript manager storage is unavailable.
        }
        try {
            return window.localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function writeStoredValue(key, value) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof GM_setValue === 'function') {
            GM_setValue(key, serialized);
            return;
        }
        window.localStorage.setItem(key, serialized);
    }

    function applyStoredState(payload) {
        if (!payload || typeof payload !== 'object') return false;
        const storedRounds = Array.isArray(payload.rounds)
            ? payload.rounds
            : Array.isArray(payload.history) ? payload.history : null;
        if (!storedRounds) return false;

        roundHistory = storedRounds
            .map(item => normalizeRound(item, 'import'))
            .filter(Boolean)
            .slice(0, CONFIG.MAX_HISTORY);

        if (payload.settings && typeof payload.settings === 'object') {
            settings.minimized = Boolean(payload.settings.minimized);
            settings.autoOrder = payload.settings.autoOrder === 'oldest' ? 'oldest' : 'newest';
            const position = payload.settings.position;
            if (position && Number.isFinite(Number(position.left)) && Number.isFinite(Number(position.top))) {
                settings.position = { left: Number(position.left), top: Number(position.top) };
            }
        }
        suppressAutoSeed = Boolean(payload.suppressAutoSeed);
        return true;
    }

    function loadData() {
        const candidates = [
            readStoredValue(CONFIG.STORAGE_KEY),
            readStoredValue(CONFIG.BACKUP_KEY),
            readStoredValue(CONFIG.LEGACY_KEY),
            readStoredValue(CONFIG.LEGACY_BACKUP_KEY)
        ];

        for (const raw of candidates) {
            const payload = decodeStoredValue(raw);
            if (applyStoredState(payload)) return;
        }
    }

    function saveData() {
        const payload = {
            schemaVersion: 1,
            rounds: roundHistory.slice(0, CONFIG.MAX_HISTORY),
            settings,
            suppressAutoSeed,
            updatedAt: Date.now()
        };
        const serialized = JSON.stringify(payload);

        try {
            const previous = readStoredValue(CONFIG.STORAGE_KEY);
            if (previous != null) writeStoredValue(CONFIG.BACKUP_KEY, previous);
            writeStoredValue(CONFIG.STORAGE_KEY, serialized);
            saveWarning = '';
            return true;
        } catch (error) {
            saveWarning = 'Could not save locally. Check your userscript manager storage permissions.';
            console.warn('[Aviator Round Analyzer] Storage error:', error);
            return false;
        }
    }

    function addRounds(values, source) {
        const cleanValues = normalizeValues(values);
        if (!cleanValues.length) return 0;

        const now = Date.now();
        const additions = cleanValues.map(value => ({ value, at: now, source }));
        roundHistory = [...additions, ...roundHistory].slice(0, CONFIG.MAX_HISTORY);
        saveData();
        return additions.length;
    }

    function replaceRounds(values) {
        const cleanValues = normalizeValues(values).slice(0, CONFIG.MAX_HISTORY);
        const now = Date.now();
        roundHistory = cleanValues.map(value => ({ value, at: now, source: 'import' }));
        if (autoSnapshot === null) suppressAutoSeed = true;
        saveData();
        return roundHistory.length;
    }

    function formatMultiplier(value) {
        return Number.isFinite(value) ? `${value.toFixed(2)}x` : '—';
    }

    function formatPercent(value) {
        return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
    }

    function getPanelElement(selector) {
        return panel ? panel.querySelector(selector) : null;
    }

    function setNotice(message, kind = 'info') {
        const notice = getPanelElement('#ara-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.dataset.kind = kind;
    }

    function setAutoStatus(message, kind = 'info') {
        const status = getPanelElement('#ara-auto-status');
        if (!status) return;
        status.textContent = message;
        status.dataset.kind = kind;
    }

    function renderRate(valueElement, noteElement, rate, label) {
        if (!valueElement || !noteElement) return;
        if (!rate.total) {
            valueElement.textContent = '—';
            noteElement.textContent = 'No observations yet';
            return;
        }

        valueElement.textContent = `${formatPercent(rate.rate)} observed`;
        noteElement.textContent = rate.interval
            ? `${rate.successes}/${rate.total}; 95% Wilson interval ${formatPercent(rate.interval.lower)}–${formatPercent(rate.interval.upper)} (assumes stable, independent rounds). Historical only—not a next-round forecast.`
            : `${rate.successes}/${rate.total}; historical only—not a next-round forecast.`;
        valueElement.setAttribute('aria-label', `${label}: ${formatPercent(rate.rate)} observed`);
    }

    function renderDistribution(rows) {
        const container = getPanelElement('#ara-distribution');
        if (!container) return;
        container.replaceChildren();

        const largest = Math.max(1, ...rows.map(row => row.count));
        for (const row of rows) {
            const line = document.createElement('div');
            line.className = 'ara-bucket';

            const label = document.createElement('span');
            label.className = 'ara-bucket-label';
            label.textContent = row.label;

            const track = document.createElement('span');
            track.className = 'ara-bar-track';
            const fill = document.createElement('span');
            fill.className = 'ara-bar-fill';
            fill.style.width = `${row.count ? Math.max(3, (row.count / largest) * 100) : 0}%`;
            track.appendChild(fill);

            const count = document.createElement('span');
            count.className = 'ara-bucket-count';
            count.textContent = String(row.count);
            line.append(label, track, count);
            container.appendChild(line);
        }
    }

    function renderRecentHistory() {
        const list = getPanelElement('#ara-recent-history');
        if (!list) return;
        list.replaceChildren();

        if (!roundHistory.length) {
            const empty = document.createElement('span');
            empty.className = 'ara-empty';
            empty.textContent = 'No rounds recorded yet.';
            list.appendChild(empty);
            return;
        }

        for (const round of roundHistory.slice(0, 12)) {
            const chip = document.createElement('span');
            chip.className = 'ara-round-chip';
            chip.textContent = formatMultiplier(round.value);
            if (round.value >= CONFIG.BIG_PINK_THRESHOLD) chip.classList.add('ara-high');
            else if (round.value >= CONFIG.PINK_THRESHOLD) chip.classList.add('ara-mid');
            const when = new Date(round.at);
            chip.title = `${round.source || 'recorded'} · ${Number.isNaN(when.getTime()) ? '' : when.toLocaleString()}`;
            list.appendChild(chip);
        }
    }

    function render() {
        if (!panel) return;
        const summary = summarize(roundHistory);
        const total = getPanelElement('#ara-total');
        const median = getPanelElement('#ara-median');
        const p90 = getPanelElement('#ara-p90');
        const storedCaption = getPanelElement('#ara-stored-caption');
        const recentCaption = getPanelElement('#ara-recent-caption');

        if (total) total.textContent = `${summary.storedCount.toLocaleString()} / ${CONFIG.MAX_HISTORY.toLocaleString()}`;
        if (median) median.textContent = formatMultiplier(summary.recentMedian);
        if (p90) p90.textContent = formatMultiplier(summary.recentP90);
        if (storedCaption) storedCaption.textContent = `Stored sample (up to latest ${CONFIG.MAX_HISTORY.toLocaleString()})`;
        if (recentCaption) recentCaption.textContent = `Recent sample (up to ${CONFIG.RECENT_WINDOW} rounds)`;

        renderRate(getPanelElement('#ara-rate3'), getPanelElement('#ara-rate3-note'), summary.storedRate3, 'At least 3x');
        renderRate(getPanelElement('#ara-rate5'), getPanelElement('#ara-rate5-note'), summary.storedRate5, 'At least 5x');
        renderRate(getPanelElement('#ara-recent-rate3'), getPanelElement('#ara-recent-rate3-note'), summary.recentRate3, 'Recent at least 3x');
        renderDistribution(summary.distribution);
        renderRecentHistory();

        const lastRound = roundHistory[0];
        const lastCaptured = getPanelElement('#ara-last-captured');
        if (lastCaptured) {
            lastCaptured.textContent = lastRound
                ? `Latest recorded: ${formatMultiplier(lastRound.value)} · ${new Date(lastRound.at).toLocaleString()} · ${lastRound.source}`
                : 'Latest recorded: —';
        }

        if (saveWarning) setNotice(saveWarning, 'error');
    }

    function injectStyles() {
        if (document.getElementById('ara-styles')) return;
        const style = document.createElement('style');
        style.id = 'ara-styles';
        style.textContent = `
            #${CONFIG.PANEL_ID} {
                position: fixed; z-index: 2147483000; top: 16px; right: 16px;
                width: min(390px, calc(100vw - 24px)); max-height: calc(100vh - 32px);
                overflow: auto; color: #eaf1ff; background: rgba(16, 23, 39, .97);
                border: 1px solid rgba(116, 153, 209, .42); border-radius: 14px;
                box-shadow: 0 18px 55px rgba(0, 0, 0, .48);
                font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                color-scheme: dark; backdrop-filter: blur(12px);
            }
            #${CONFIG.PANEL_ID} *, #${CONFIG.PANEL_ID} *::before, #${CONFIG.PANEL_ID} *::after { box-sizing: border-box; }
            #${CONFIG.PANEL_ID} .ara-header {
                position: sticky; top: 0; z-index: 2; display: flex; gap: 10px; align-items: center;
                justify-content: space-between; padding: 12px 14px; background: #151f34;
                border-bottom: 1px solid rgba(116, 153, 209, .22); cursor: grab; touch-action: none;
            }
            #${CONFIG.PANEL_ID} .ara-header:active { cursor: grabbing; }
            #${CONFIG.PANEL_ID} .ara-heading { min-width: 0; }
            #${CONFIG.PANEL_ID} .ara-title { display: block; color: #8bd4ff; font-size: 14px; font-weight: 750; letter-spacing: .2px; }
            #${CONFIG.PANEL_ID} .ara-subtitle { display: block; margin-top: 1px; color: #9eacc4; font-size: 10px; }
            #${CONFIG.PANEL_ID} .ara-header-actions { display: flex; gap: 6px; flex-shrink: 0; }
            #${CONFIG.PANEL_ID} button {
                border: 1px solid rgba(160, 183, 221, .28); border-radius: 7px; padding: 6px 9px;
                color: #edf5ff; background: #26344f; font: inherit; font-size: 11px; font-weight: 650;
                cursor: pointer; transition: background .15s ease, border-color .15s ease;
            }
            #${CONFIG.PANEL_ID} button:hover { background: #344767; border-color: #77c8ff; }
            #${CONFIG.PANEL_ID} button:focus-visible, #${CONFIG.PANEL_ID} input:focus-visible, #${CONFIG.PANEL_ID} textarea:focus-visible {
                outline: 2px solid #79d5ff; outline-offset: 2px;
            }
            #${CONFIG.PANEL_ID} .ara-content { padding: 12px; }
            #${CONFIG.PANEL_ID}.ara-minimized .ara-content { display: none; }
            #${CONFIG.PANEL_ID} .ara-warning {
                padding: 10px 11px; margin-bottom: 10px; border: 1px solid rgba(255, 190, 90, .38);
                border-radius: 9px; background: rgba(255, 176, 59, .10); color: #ffe0a4; font-size: 11px;
            }
            #${CONFIG.PANEL_ID} .ara-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 10px; }
            #${CONFIG.PANEL_ID} .ara-card {
                min-width: 0; padding: 9px; border: 1px solid rgba(116, 153, 209, .20);
                border-radius: 9px; background: rgba(255, 255, 255, .035);
            }
            #${CONFIG.PANEL_ID} .ara-label { display: block; color: #aebbd1; font-size: 10px; }
            #${CONFIG.PANEL_ID} .ara-value { display: block; margin-top: 3px; color: #f4f7ff; font-size: 18px; font-weight: 750; overflow-wrap: anywhere; }
            #${CONFIG.PANEL_ID} .ara-note { display: block; margin-top: 4px; color: #97a6bf; font-size: 9px; line-height: 1.4; }
            #${CONFIG.PANEL_ID} .ara-section {
                margin-top: 9px; padding: 10px; border: 1px solid rgba(116, 153, 209, .20);
                border-radius: 10px; background: rgba(255, 255, 255, .025);
            }
            #${CONFIG.PANEL_ID} .ara-section-title { margin: 0 0 7px; color: #cdeaff; font-size: 11px; font-weight: 750; }
            #${CONFIG.PANEL_ID} .ara-caption { margin: -3px 0 8px; color: #96a5bd; font-size: 9px; }
            #${CONFIG.PANEL_ID} .ara-bucket { display: grid; grid-template-columns: 74px 1fr 24px; gap: 7px; align-items: center; margin: 5px 0; }
            #${CONFIG.PANEL_ID} .ara-bucket-label, #${CONFIG.PANEL_ID} .ara-bucket-count { color: #aebbd1; font-size: 9px; }
            #${CONFIG.PANEL_ID} .ara-bucket-count { text-align: right; color: #e8f4ff; }
            #${CONFIG.PANEL_ID} .ara-bar-track { display: block; height: 6px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.09); }
            #${CONFIG.PANEL_ID} .ara-bar-fill { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #41b8ed, #a07cff); }
            #${CONFIG.PANEL_ID} .ara-history { display: flex; flex-wrap: wrap; gap: 5px; }
            #${CONFIG.PANEL_ID} .ara-round-chip {
                padding: 3px 6px; border: 1px solid rgba(105, 172, 222, .28); border-radius: 6px;
                color: #c8eaff; background: rgba(57, 145, 200, .12); font: 10px ui-monospace, SFMono-Regular, Consolas, monospace;
            }
            #${CONFIG.PANEL_ID} .ara-round-chip.ara-mid { color: #ffc5dc; background: rgba(240, 64, 138, .13); border-color: rgba(240, 64, 138, .30); }
            #${CONFIG.PANEL_ID} .ara-round-chip.ara-high { color: #ffe4a8; background: rgba(235, 161, 48, .14); border-color: rgba(235, 161, 48, .33); }
            #${CONFIG.PANEL_ID} .ara-empty { color: #95a4bc; font-size: 10px; }
            #${CONFIG.PANEL_ID} .ara-row { display: flex; gap: 7px; align-items: center; }
            #${CONFIG.PANEL_ID} input, #${CONFIG.PANEL_ID} textarea {
                display: block; width: 100%; min-width: 0; border: 1px solid rgba(160, 183, 221, .28);
                border-radius: 7px; padding: 8px; color: #f2f6ff; background: rgba(0,0,0,.24); font: inherit;
            }
            #${CONFIG.PANEL_ID} input { flex: 1; }
            #${CONFIG.PANEL_ID} textarea { min-height: 75px; margin-top: 6px; resize: vertical; font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
            #${CONFIG.PANEL_ID} .ara-primary { color: #061a2a; background: #7dd3fc; border-color: #7dd3fc; }
            #${CONFIG.PANEL_ID} .ara-button-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
            #${CONFIG.PANEL_ID} .ara-order { width: 100%; margin-bottom: 7px; color: #c4d0e2; background: rgba(255,255,255,.045); text-align: left; }
            #${CONFIG.PANEL_ID} .ara-auto-status, #${CONFIG.PANEL_ID} .ara-notice, #${CONFIG.PANEL_ID} .ara-last-captured {
                margin-top: 7px; color: #aab8ce; font-size: 9px; overflow-wrap: anywhere;
            }
            #${CONFIG.PANEL_ID} .ara-auto-status[data-kind="warn"] { color: #ffd58a; }
            #${CONFIG.PANEL_ID} .ara-auto-status[data-kind="success"] { color: #8ce2b1; }
            #${CONFIG.PANEL_ID} .ara-notice[data-kind="error"] { color: #ff9c9c; }
            #${CONFIG.PANEL_ID} .ara-notice[data-kind="success"] { color: #8ce2b1; }
            #${CONFIG.PANEL_ID} .ara-privacy { margin-top: 9px; color: #8191aa; font-size: 9px; }
            @media (max-width: 440px) {
                #${CONFIG.PANEL_ID} { top: 8px; right: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
                #${CONFIG.PANEL_ID} .ara-content { padding: 9px; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function createPanel() {
        if (document.getElementById(CONFIG.PANEL_ID)) {
            panel = document.getElementById(CONFIG.PANEL_ID);
            return;
        }

        panel = document.createElement('aside');
        panel.id = CONFIG.PANEL_ID;
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Aviator round analyzer');
        panel.innerHTML = `
            <header class="ara-header" id="ara-drag-handle">
                <div class="ara-heading">
                    <span class="ara-title">✈ Aviator Round Analyzer</span>
                    <span class="ara-subtitle">Historical analysis · no next-round predictions</span>
                </div>
                <div class="ara-header-actions">
                    <button type="button" id="ara-minimize" aria-expanded="true" title="Collapse or expand panel">Hide</button>
                </div>
            </header>
            <div class="ara-content" id="ara-content">
                <div class="ara-warning" role="note">
                    No history-based method can reliably forecast an independent crash round. The rates below describe recorded results only; they are not betting signals or a promise about the next round.
                </div>

                <div class="ara-grid" aria-label="Summary statistics">
                    <div class="ara-card">
                        <span class="ara-label" id="ara-stored-caption">Stored sample</span>
                        <span class="ara-value" id="ara-total">0</span>
                        <span class="ara-note">Duplicate multipliers are kept as separate rounds.</span>
                    </div>
                    <div class="ara-card">
                        <span class="ara-label" id="ara-recent-caption">Recent sample</span>
                        <span class="ara-value" id="ara-median">—</span>
                        <span class="ara-note">Median multiplier; descriptive only.</span>
                    </div>
                    <div class="ara-card">
                        <span class="ara-label">Recent 90th percentile</span>
                        <span class="ara-value" id="ara-p90">—</span>
                        <span class="ara-note">Last up to 100 recorded rounds.</span>
                    </div>
                    <div class="ara-card">
                        <span class="ara-label">Stored sample ≥3.00x</span>
                        <span class="ara-value" id="ara-rate3">—</span>
                        <span class="ara-note" id="ara-rate3-note">No observations yet</span>
                    </div>
                    <div class="ara-card">
                        <span class="ara-label">Stored sample ≥5.00x</span>
                        <span class="ara-value" id="ara-rate5">—</span>
                        <span class="ara-note" id="ara-rate5-note">No observations yet</span>
                    </div>
                    <div class="ara-card">
                        <span class="ara-label">Recent sample ≥3.00x</span>
                        <span class="ara-value" id="ara-recent-rate3">—</span>
                        <span class="ara-note" id="ara-recent-rate3-note">No observations yet</span>
                    </div>
                </div>

                <section class="ara-section">
                    <h2 class="ara-section-title">Recent outcome distribution</h2>
                    <p class="ara-caption">Last up to 100 rounds, newest first. Counts—not forecasts.</p>
                    <div id="ara-distribution"></div>
                </section>

                <section class="ara-section">
                    <h2 class="ara-section-title">Latest recorded rounds</h2>
                    <div class="ara-history" id="ara-recent-history" aria-live="polite"></div>
                    <div class="ara-last-captured" id="ara-last-captured">Latest recorded: —</div>
                </section>

                <section class="ara-section">
                    <h2 class="ara-section-title">Add latest result</h2>
                    <div class="ara-row">
                        <input id="ara-quick-input" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 1.25x" aria-label="Latest crash multiplier">
                        <button type="button" class="ara-primary" id="ara-add-latest">Add</button>
                    </div>
                </section>

                <section class="ara-section">
                    <h2 class="ara-section-title">Bulk history</h2>
                    <p class="ara-caption">Paste newest first. Use one multiplier per line or a comma/space-separated list. Keep the x suffix when pasting mixed text.</p>
                    <textarea id="ara-bulk-input" spellcheck="false" placeholder="2.14x\n1.08x\n1.52x" aria-label="Bulk multiplier history, newest first"></textarea>
                    <div class="ara-button-row">
                        <button type="button" class="ara-primary" id="ara-import">Merge import</button>
                        <button type="button" id="ara-replace">Replace stored data</button>
                        <button type="button" id="ara-export">Export CSV</button>
                        <button type="button" id="ara-clear">Clear data</button>
                    </div>
                </section>

                <section class="ara-section">
                    <h2 class="ara-section-title">Best-effort page capture</h2>
                    <button type="button" class="ara-order" id="ara-order" title="Change the order used for detected page history">DOM order: newest → oldest</button>
                    <div class="ara-auto-status" id="ara-auto-status" role="status" aria-live="polite">Looking for a clearly labeled round-history list…</div>
                    <div class="ara-caption">Automatic capture only reads visible multiplier labels near a round-history heading. If the game is inside a protected frame or the page layout changes, enter results manually. The default assumes the visible list is newest first.</div>
                </section>

                <div class="ara-notice" id="ara-notice" role="status" aria-live="polite"></div>
                <div class="ara-privacy">Data stays in this browser's userscript storage. This script makes no network requests and does not interact with bets.</div>
            </div>
        `;
        document.body.appendChild(panel);
        applyPanelState();
        bindPanelEvents();
        makeDraggable();
        render();
    }

    function applyPanelState() {
        if (!panel) return;
        const minimized = Boolean(settings.minimized);
        panel.classList.toggle('ara-minimized', minimized);
        const button = getPanelElement('#ara-minimize');
        const content = getPanelElement('#ara-content');
        if (button) {
            button.textContent = minimized ? 'Show' : 'Hide';
            button.setAttribute('aria-expanded', String(!minimized));
        }
        if (content) content.hidden = minimized;

        if (settings.position && Number.isFinite(settings.position.left) && Number.isFinite(settings.position.top)) {
            panel.style.left = `${settings.position.left}px`;
            panel.style.top = `${settings.position.top}px`;
            panel.style.right = 'auto';
            requestAnimationFrame(clampPanelPosition);
        }
        updateOrderButton();
    }

    function updateOrderButton() {
        const button = getPanelElement('#ara-order');
        if (!button) return;
        button.textContent = settings.autoOrder === 'newest'
            ? 'DOM order: newest → oldest'
            : 'DOM order: oldest → newest';
    }

    function bindPanelEvents() {
        getPanelElement('#ara-minimize')?.addEventListener('click', () => {
            settings.minimized = !settings.minimized;
            applyPanelState();
            saveData();
        });

        getPanelElement('#ara-add-latest')?.addEventListener('click', addLatestFromInput);
        getPanelElement('#ara-quick-input')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addLatestFromInput();
            }
        });

        getPanelElement('#ara-import')?.addEventListener('click', importBulkHistory);
        getPanelElement('#ara-replace')?.addEventListener('click', replaceBulkHistory);
        getPanelElement('#ara-export')?.addEventListener('click', exportCsv);
        getPanelElement('#ara-clear')?.addEventListener('click', clearHistory);
        getPanelElement('#ara-order')?.addEventListener('click', () => {
            settings.autoOrder = settings.autoOrder === 'newest' ? 'oldest' : 'newest';
            autoSnapshot = null;
            updateOrderButton();
            saveData();
            setAutoStatus('Order preference changed. Checking the visible history again…', 'info');
            scheduleAutoCapture(0);
        });
    }

    function addLatestFromInput() {
        const input = getPanelElement('#ara-quick-input');
        if (!input) return;
        const values = parseManualValues(input.value);
        if (values.length !== 1) {
            setNotice('Enter exactly one valid multiplier, for example 1.25 or 1.25x.', 'error');
            return;
        }

        addRounds(values, 'manual');
        input.value = '';
        render();
        setNotice(`Added ${formatMultiplier(values[0])}.`, 'success');
        input.focus();
    }

    function importBulkHistory() {
        const textarea = getPanelElement('#ara-bulk-input');
        const values = parseManualValues(textarea ? textarea.value : '');
        if (!values.length) {
            setNotice('No valid multipliers found. Use values ≥1, one per line or separated by commas/spaces.', 'error');
            return;
        }

        const existing = valuesFromHistory(roundHistory);
        if (!existing.length) {
            addRounds(values, 'import');
            render();
            setNotice(`Imported ${Math.min(values.length, CONFIG.MAX_HISTORY)} rounds (newest first).`, 'success');
            return;
        }

        const merged = mergeNewestFirst(values, existing);
        if (!merged.added.length) {
            setNotice(`No new rounds detected; ${merged.overlap} values already overlap the newest stored history.`, 'info');
            return;
        }
        if (merged.overlap === 0 && !window.confirm(
            'No matching overlap was found. Import these as new latest rounds? If this list includes old rounds, duplicates may be added.'
        )) return;

        addRounds(merged.added, 'import');
        render();
        setNotice(`Added ${merged.added.length} rounds${merged.overlap ? `; skipped ${merged.overlap} overlapping values` : ''}.`, 'success');
    }

    function replaceBulkHistory() {
        const textarea = getPanelElement('#ara-bulk-input');
        const values = parseManualValues(textarea ? textarea.value : '');
        if (!values.length) {
            setNotice('No valid multipliers found; stored data was not changed.', 'error');
            return;
        }
        if (!window.confirm(`Replace the stored history with ${Math.min(values.length, CONFIG.MAX_HISTORY)} pasted rounds? This cannot be undone.`)) return;

        const count = replaceRounds(values);
        render();
        setNotice(`Replaced stored history with ${count} rounds.`, 'success');
    }

    function clearHistory() {
        if (!roundHistory.length) {
            setNotice('There is no stored history to clear.', 'info');
            return;
        }
        if (!window.confirm(`Delete all ${roundHistory.length} stored rounds from this browser? This cannot be undone.`)) return;

        roundHistory = [];
        suppressAutoSeed = true;
        saveData();
        render();
        setNotice('Stored history cleared. Existing on-screen rounds will not be re-imported automatically.', 'success');
    }

    function csvEscape(value) {
        const text = String(value ?? '');
        return `"${text.replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!roundHistory.length) {
            setNotice('There are no rounds to export yet.', 'info');
            return;
        }

        const rows = [['multiplier', 'captured_at_utc', 'source']];
        for (const round of roundHistory) {
            rows.push([
                round.value,
                new Date(round.at).toISOString(),
                round.source || 'unknown'
            ]);
        }
        const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `aviator-round-history-${new Date().toISOString().slice(0, 10)}.csv`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setNotice(`Exported ${roundHistory.length} rounds as CSV.`, 'success');
    }

    function makeDraggable() {
        const handle = getPanelElement('#ara-drag-handle');
        if (!handle || !panel) return;
        let drag = null;

        handle.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) return;
            if (event.button !== undefined && event.button !== 0) return;
            const rect = panel.getBoundingClientRect();
            drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
            handle.setPointerCapture?.(event.pointerId);
        });

        handle.addEventListener('pointermove', event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            panel.style.left = `${event.clientX - drag.offsetX}px`;
            panel.style.top = `${event.clientY - drag.offsetY}px`;
            panel.style.right = 'auto';
            clampPanelPosition();
        });

        const finish = event => {
            if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
            drag = null;
            const rect = panel.getBoundingClientRect();
            settings.position = { left: Math.round(rect.left), top: Math.round(rect.top) };
            saveData();
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        window.addEventListener('resize', clampPanelPosition);
    }

    function clampPanelPosition() {
        if (!panel || !settings.position && panel.style.right !== 'auto') return;
        const rect = panel.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
        const top = Math.max(8, Math.min(window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8, rect.top));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function collectVisibleRoundItems(container) {
        if (!container || container.id === CONFIG.PANEL_ID || container.closest(`#${CONFIG.PANEL_ID}`)) return [];
        const elements = [container, ...container.querySelectorAll('*')];
        const items = [];

        for (const element of elements) {
            if (element.id === CONFIG.PANEL_ID || element.closest(`#${CONFIG.PANEL_ID}`) || !isVisible(element)) continue;
            const value = parseMultiplierToken(element.textContent || '');
            if (value === null) continue;

            // When a wrapper and its child both contain the same exact label, keep only the deepest one.
            const hasExactChild = Array.from(element.children).some(child => parseMultiplierToken(child.textContent || '') !== null);
            if (!hasExactChild) items.push({ value, node: element });
            if (items.length >= CONFIG.MAX_HISTORY) break;
        }
        return items;
    }

    function longestDomOverlap(incoming, existing) {
        const maxOverlap = Math.min(incoming.length, existing.length);
        for (let size = maxOverlap; size > 0; size--) {
            let matches = true;
            for (let index = 0; index < size; index++) {
                const fresh = incoming[incoming.length - size + index];
                const prior = existing[index];
                if (fresh.node !== prior.node || Math.abs(fresh.value - prior.value) > 1e-9) {
                    matches = false;
                    break;
                }
            }
            if (matches) return size;
        }
        return 0;
    }

    function findLabeledHistory() {
        if (!document.body) return null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let textNode;

        while ((textNode = walker.nextNode())) {
            if (!/round\s*history|recent\s*rounds/i.test(textNode.nodeValue || '')) continue;
            let candidate = textNode.parentElement;
            for (let depth = 0; candidate && candidate !== document.body && depth < 9; depth++, candidate = candidate.parentElement) {
                if (!isVisible(candidate) || candidate.id === CONFIG.PANEL_ID || candidate.closest(`#${CONFIG.PANEL_ID}`)) continue;
                const items = collectVisibleRoundItems(candidate);
                if (items.length >= 2) return { items, source: 'labeled round history' };
            }
        }

        // Conservative fallback for pages that label the history container through accessible metadata/classes.
        const selectors = [
            '[data-testid*="round-history" i]',
            '[aria-label*="round history" i]',
            '[class*="round-history" i]',
            '[class*="history-list" i]'
        ];
        for (const selector of selectors) {
            let candidates = [];
            try { candidates = Array.from(document.querySelectorAll(selector)); } catch (_) { /* Ignore unsupported selectors. */ }
            for (const candidate of candidates) {
                if (!isVisible(candidate) || candidate.id === CONFIG.PANEL_ID || candidate.closest(`#${CONFIG.PANEL_ID}`)) continue;
                const items = collectVisibleRoundItems(candidate);
                if (items.length >= 2) return { items, source: 'history container' };
            }
        }
        return null;
    }

    function captureVisibleHistory() {
        const found = findLabeledHistory();
        if (!found) {
            setAutoStatus('No clearly labeled visible round-history list found. Manual entry is ready.', 'warn');
            return false;
        }

        const observedItems = found.items.slice();
        if (settings.autoOrder === 'oldest') observedItems.reverse();
        const observed = observedItems.map(item => item.value);
        if (observed.length < 2) {
            setAutoStatus('Found fewer than two visible multipliers; waiting to avoid an ambiguous capture.', 'warn');
            return false;
        }

        const previousSnapshot = autoSnapshot;
        let additions = [];
        let overlap = 0;

        if (previousSnapshot === null && suppressAutoSeed) {
            // After an explicit clear (including across reloads), establish a baseline
            // rather than silently importing the page's pre-clear history again.
            autoSnapshot = observedItems;
            suppressAutoSeed = false;
            saveData();
            setAutoStatus(`Watching ${found.source}; existing visible rounds were not re-imported.`, 'info');
            return false;
        }

        if (previousSnapshot === null && !roundHistory.length) {
            additions = observed;
        } else {
            if (previousSnapshot) {
                overlap = longestDomOverlap(observedItems, previousSnapshot);
                if (overlap === 0) {
                    overlap = longestSuffixPrefixOverlap(observed, previousSnapshot.map(item => item.value));
                }
            } else {
                overlap = longestSuffixPrefixOverlap(observed, valuesFromHistory(roundHistory));
            }
            if (overlap === 0) {
                autoSnapshot = observedItems;
                setAutoStatus(`${found.source} found, but no safe overlap was found. No values were added; the capture baseline was reset.`, 'warn');
                return false;
            }
            additions = observed.slice(0, observed.length - overlap);
        }

        // Keep live DOM identity as well as values so repeated equal multipliers
        // can still be distinguished when the page prepends a new round node.
        autoSnapshot = observedItems;
        if (additions.length) {
            addRounds(additions, 'auto');
            render();
            setAutoStatus(`Captured ${additions.length} new round${additions.length === 1 ? '' : 's'} from ${found.source} (${settings.autoOrder} first).`, 'success');
            return true;
        }

        setAutoStatus(`Watching ${found.source}; no new round detected (${observed.length} visible).`, 'info');
        return false;
    }

    function isInsidePanel(node) {
        const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        return Boolean(element && (element.id === CONFIG.PANEL_ID || element.closest(`#${CONFIG.PANEL_ID}`)));
    }

    function scheduleAutoCapture(delay = 350) {
        if (captureTimer !== null) return;
        captureTimer = window.setTimeout(() => {
            captureTimer = null;
            captureVisibleHistory();
        }, delay);
    }

    function setupMutationObserver() {
        if (!document.body || typeof MutationObserver === 'undefined') return;
        observer = new MutationObserver(records => {
            const changedOutsidePanel = records.some(record => !isInsidePanel(record.target));
            if (changedOutsidePanel) scheduleAutoCapture(350);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function clampLoadedPosition() {
        if (!panel || !settings.position) return;
        const left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, settings.position.left));
        const top = Math.max(8, Math.min(window.innerHeight - Math.min(panel.offsetHeight, window.innerHeight - 16) - 8, settings.position.top));
        settings.position = { left, top };
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    function initialize() {
        if (!document.body || document.getElementById(CONFIG.PANEL_ID)) return;
        loadData();
        injectStyles();
        createPanel();
        clampLoadedPosition();
        setupMutationObserver();
        scheduleAutoCapture(250);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            CONFIG,
            parseManualValues,
            normalizeValues,
            quantile,
            wilsonInterval,
            empiricalRate,
            makeDistribution,
            summarize,
            longestSuffixPrefixOverlap,
            mergeNewestFirst
        };
    }

    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize, { once: true });
        } else {
            initialize();
        }
    }
})();

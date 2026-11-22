import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { UsageError } from './errors.js';

export const CONFIG_FILE = '.wabadevrc.json';
export const DEFAULT_GRAPH_VERSION = 'v23.0';
export const DEFAULT_TEMPLATES_DIR = 'templates';

/**
 * Removes a leading UTF-8 byte-order mark, which Windows editors and PowerShell 5.1 write.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
    return text.replace(/^\u{FEFF}/u, '');
}

/**
 * `JSON.parse` that tolerates a leading UTF-8 byte-order mark.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJson(text) {
    return JSON.parse(stripBom(text));
}

/**
 * @typedef {object} WabaEntry
 * @property {string} wabaId - WhatsApp Business Account ID.
 * @property {string} tokenEnv - Name of the environment variable that holds the access token.
 */

/**
 * @typedef {object} Config
 * @property {string} graphVersion - Graph API version, e.g. `v23.0`.
 * @property {string} templatesDir - Absolute path of the template folder.
 * @property {Object.<string, WabaEntry[]>} stages - Stage name to its WABAs.
 * @property {string[]} warnings - Config problems that were fixed automatically (shown as warnings).
 */

/**
 * Loads `.env` from the project root into `process.env`. Variables that are already set win.
 *
 * @param {string} cwd - Project root.
 * @param {NodeJS.ProcessEnv} [environment] - Environment to fill (default `process.env`).
 * @returns {string[]} Names of the variables that were set from the file.
 */
export function loadDotenvFile(cwd, environment = process.env) {
    const file = path.join(cwd, '.env');
    if (!existsSync(file)) {
        return [];
    }
    const parsed = parseEnv(stripBom(readFileSync(file, 'utf8')));
    const loaded = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (environment[key] !== undefined) {
            continue;
        }

        environment[key] = value;
        loaded.push(key);
    }
    return loaded;
}

/**
 * Reads and validates `.wabadevrc.json`.
 *
 * @param {string} cwd - Project root.
 * @returns {Config}
 */
export function loadConfig(cwd) {
    const file = path.join(cwd, CONFIG_FILE);
    if (!existsSync(file)) {
        throw new UsageError(`No ${CONFIG_FILE} found in ${cwd}. See the README for its format.`);
    }
    let raw;
    try {
        raw = parseJson(readFileSync(file, 'utf8'));
    } catch (ex) {
        throw new UsageError(`${CONFIG_FILE} is not valid JSON: ${ex.message}`);
    }
    return validateConfig(raw, cwd);
}

/**
 * @param {any} raw - Parsed config file.
 * @param {string} cwd - Project root, used to resolve `templatesDir`.
 * @returns {Config}
 */
export function validateConfig(raw, cwd) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new UsageError(`${CONFIG_FILE} must contain a JSON object.`);
    }
    const graphVersion = raw.graphVersion ?? DEFAULT_GRAPH_VERSION;
    if (typeof graphVersion !== 'string' || !/^v\d+\.\d+$/.test(graphVersion)) {
        throw new UsageError(`${CONFIG_FILE}: graphVersion must look like "v23.0".`);
    }
    const templatesFolder = raw.templatesDir ?? DEFAULT_TEMPLATES_DIR;
    if (typeof templatesFolder !== 'string' || templatesFolder === '') {
        throw new UsageError(`${CONFIG_FILE}: templatesDir must be a non-empty string.`);
    }
    if (!raw.stages || typeof raw.stages !== 'object' || Array.isArray(raw.stages)) {
        throw new UsageError(`${CONFIG_FILE}: "stages" must be an object of stage name to WABAs.`);
    }
    const stages = {};
    const warnings = [];
    for (const [stage, entries] of Object.entries(raw.stages)) {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new UsageError(`${CONFIG_FILE}: stage "${stage}" needs at least one WABA entry.`);
        }
        stages[stage] = entries.map((entry, index) => {
            const where = `stage "${stage}", entry ${index + 1}`;
            if (!entry || typeof entry.wabaId !== 'string' || !/^\d+$/.test(entry.wabaId)) {
                throw new UsageError(`${CONFIG_FILE}: ${where}: wabaId must be a numeric string.`);
            }
            if (typeof entry.tokenEnv !== 'string' || !/^[A-Za-z_]\w*$/.test(entry.tokenEnv)) {
                throw new UsageError(
                    `${CONFIG_FILE}: ${where}: tokenEnv must be an environment variable name.`,
                );
            }
            return { wabaId: entry.wabaId, tokenEnv: entry.tokenEnv };
        });
        stages[stage] = dropDuplicates(stage, stages[stage], warnings);
    }
    return { graphVersion, templatesDir: path.resolve(cwd, templatesFolder), stages, warnings };
}

/**
 * Keeps the first entry of a WABA listed twice in one stage, so it is deployed only once.
 *
 * @param {string} stage
 * @param {WabaEntry[]} entries
 * @param {string[]} warnings - Receives one message per dropped entry.
 * @returns {WabaEntry[]}
 */
function dropDuplicates(stage, entries, warnings) {
    const kept = new Map();
    for (const entry of entries) {
        const first = kept.get(entry.wabaId);
        if (first) {
            warnings.push(
                `${CONFIG_FILE}: stage "${stage}" lists WABA ${entry.wabaId} more than once; it is used once (tokenEnv ${first.tokenEnv}).`,
            );
        } else {
            kept.set(entry.wabaId, entry);
        }
    }
    return kept.values().toArray();
}

/**
 * @param {Config} config
 * @param {string} name - Stage name.
 * @returns {WabaEntry[]}
 */
export function getStage(config, name) {
    const entries = config.stages[name];
    if (!entries) {
        const known = Object.keys(config.stages).join(', ');
        throw new UsageError(`Unknown stage "${name}". Stages in ${CONFIG_FILE}: ${known}.`);
    }
    return entries;
}

/**
 * A WABA entry together with the stage it was found in.
 *
 * @typedef {object} StageWaba
 * @property {string} stage - Stage name (several names joined when the WABA is in more stages).
 * @property {string[]} stages - All stages the WABA was found in.
 * @property {WabaEntry} entry
 */

/**
 * Finds a WABA in the config without a stage. A WABA listed in several stages is fine as long as
 * all of them use the same token variable.
 *
 * @param {Config} config
 * @param {string} wabaId
 * @param {string} hint - What to do when the WABA is ambiguous, for the error message.
 * @returns {StageWaba}
 */
function locateWaba(config, wabaId, hint) {
    const matches = Object.entries(config.stages).flatMap(([stage, entries]) =>
        entries.filter((entry) => entry.wabaId === wabaId).map((entry) => ({ stage, entry })),
    );
    if (matches.length === 0) {
        throw new UsageError(`WABA ${wabaId} is not in ${CONFIG_FILE}.`);
    }
    const stages = matches.map((match) => match.stage).join(', ');
    const tokens = new Set(matches.map((match) => match.entry.tokenEnv));
    if (tokens.size > 1) {
        throw new UsageError(
            `WABA ${wabaId} is in stages ${stages} with different tokens; ${hint}.`,
        );
    }
    return { stage: stages, stages: matches.map((match) => match.stage), entry: matches[0].entry };
}

/**
 * Picks the one source WABA: from `--from`, `--from-waba` or both.
 *
 * @param {Config} config
 * @param {string} [stage] - `--from`.
 * @param {string} [wabaId] - `--from-waba`; required when the stage has several WABAs.
 * @returns {StageWaba}
 */
export function pickSourceWaba(config, stage, wabaId) {
    if (!stage) {
        if (!wabaId) {
            throw new UsageError('Missing --from or --from-waba.');
        }
        return locateWaba(config, wabaId, 'add --from <stage>');
    }
    const entries = getStage(config, stage);
    if (wabaId) {
        const entry = entries.find((candidate) => candidate.wabaId === wabaId);
        if (!entry) {
            throw new UsageError(`WABA ${wabaId} is not part of stage "${stage}".`);
        }
        return { stage, stages: [stage], entry };
    }
    if (entries.length > 1) {
        const ids = entries.map((entry) => entry.wabaId).join(', ');
        throw new UsageError(
            `Stage "${stage}" has several WABAs (${ids}); pick one with --from-waba.`,
        );
    }
    return { stage, stages: [stage], entry: entries[0] };
}

/**
 * The target WABAs: all of a stage (`--to`), the ones named with `--to-waba`, or the named ones
 * within a stage (both).
 *
 * @param {Config} config
 * @param {string} [stage] - `--to`.
 * @param {string[]} [wabaIds] - `--to-waba` values.
 * @param {string} [hint] - Advice when a WABA is in several stages with different tokens.
 * @returns {StageWaba[]}
 */
export function pickTargetWabas(config, stage, wabaIds = [], hint = 'add --to <stage>') {
    const wanted = [...new Set(wabaIds)];
    if (!stage) {
        if (wanted.length === 0) {
            throw new UsageError('Missing --to or --to-waba.');
        }
        return wanted.map((wabaId) => locateWaba(config, wabaId, hint));
    }
    const entries = getStage(config, stage);
    const known = new Set(entries.map((entry) => entry.wabaId));
    const unknown = wanted.filter((wabaId) => !known.has(wabaId));
    if (unknown.length > 0) {
        throw new UsageError(`WABA ${unknown.join(', ')} is not part of stage "${stage}".`);
    }
    const selected =
        wanted.length === 0 ? entries : entries.filter((entry) => wanted.includes(entry.wabaId));
    return selected.map((entry) => ({ stage, stages: [stage], entry }));
}

/**
 * Reads the token of a WABA entry from the environment.
 *
 * @param {WabaEntry} entry
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string}
 */
export function resolveToken(entry, environment = process.env) {
    const token = environment[entry.tokenEnv];
    if (!token) {
        throw new UsageError(
            `Environment variable ${entry.tokenEnv} (token for WABA ${entry.wabaId}) is not set.`,
        );
    }
    return token;
}

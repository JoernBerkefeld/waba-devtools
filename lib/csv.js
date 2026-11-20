import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import csv, { replayFiles, validateFile } from '@joern.berkefeld/csv-parser';
import { UsageError } from './errors.js';
import { assertSafeIdentity, normalizeTemplate, templateKey } from './normalize.js';

/**
 * CSV column headers (compared case-insensitively, trimmed). Other columns are ignored.
 */
export const CSV_COLUMNS = {
    name: 'template name',
    category: 'category',
    body: 'meta template',
    language: 'language',
    examples: 'examples',
};

const REQUIRED_COLUMNS = ['name', 'category', 'body', 'language'];
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * @typedef {object} CsvRowError
 * @property {number} row - Line number in the sheet (header = 1).
 * @property {string} message
 */

/**
 * @typedef {object} CsvResult
 * @property {import('./normalize.js').Template[]} templates - Body-only templates, one per row.
 * @property {CsvRowError[]} errors
 * @property {CsvCleanup} [cleanup] - What was cleaned up while reading the file.
 */

/**
 * @typedef {object} CsvCleanup
 * @property {number} removedColumns - Empty columns removed on the right (no header, no values).
 * @property {number} removedRecords - Empty rows removed at the bottom.
 * @property {number} skippedRecords - Empty rows skipped in between.
 */

/**
 * Parser options, the same as sfmc-dataloader uses for its CSV imports: strict width and quoting,
 * BOM removal, empty rows skipped, empty right-padding columns and bottom rows removed.
 */
const PARSER_OPTIONS = {
    bom: true,
    strict: true,
    strictQuotes: true,
    skipEmptyLines: true,
    sanitizeRightPadding: true,
    sanitizeBottom: true,
    mapHeaders: ({ header }) => header.trim().toLowerCase(),
    outputByteOffset: true,
};

/**
 * Line ending of the file, taken from the end of the header line: `\r` for old Mac exports,
 * otherwise `\n` (the parser handles `\r\n` with it).
 *
 * @param {string} file
 * @returns {Promise.<string>}
 */
async function detectNewline(file) {
    const handle = await open(file);
    try {
        const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(64 * 1024) });
        const text = buffer.subarray(0, bytesRead).toString('latin1');
        const end = text.search(/[\r\n]/);
        return end !== -1 && text[end] === '\r' && text[end + 1] !== '\n' ? '\r' : '\n';
    } finally {
        await handle.close();
    }
}

/**
 * Row number in the sheet of every record in the file, by byte offset. Counts every record,
 * also the empty ones that are skipped while parsing.
 *
 * @param {string} file
 * @param {string} newline - From `detectNewline`, so both passes split records the same way.
 * @returns {Promise.<Map.<number, number>>} Byte offset to row number.
 */
async function recordOffsets(file, newline) {
    const rowNumbers = new Map();
    const parser = createReadStream(file).pipe(
        csv({ bom: true, headers: false, skipEmptyLines: false, outputByteOffset: true, newline }),
    );
    for await (const { byteOffset } of parser) {
        rowNumbers.set(byteOffset, rowNumbers.size + 1);
    }
    return rowNumbers;
}

/**
 * Reads a Google Sheets (or other) CSV export into body-only templates.
 *
 * @param {string} file - CSV path.
 * @returns {Promise.<CsvResult>}
 */
export async function readCsvTemplates(file) {
    const rows = [];
    const rowNumbers = [];
    let validation;
    try {
        const newline = await detectNewline(file);
        validation = await validateFile(file, { ...PARSER_OPTIONS, newline });
        const offsets = await recordOffsets(file, newline);
        for await (const { row, byteOffset } of replayFiles(validation)) {
            rows.push(row);
            const rowNumber = offsets.get(byteOffset);
            if (rowNumber === undefined) {
                throw new Error(`no row number for the record at byte ${byteOffset}`);
            }
            rowNumbers.push(rowNumber);
        }
    } catch (ex) {
        throw new UsageError(`Could not read CSV ${file}: ${ex.message}`);
    }
    if (!validation.headers || validation.headers.length === 0) {
        throw new UsageError(`CSV ${file} has no header row.`);
    }
    const { removedColumns, removedRecords, skippedRecords } = validation.cleanup;
    return {
        ...templatesFromRows(rows, rowNumbers),
        cleanup: { removedColumns, removedRecords, skippedRecords },
    };
}

/**
 * @param {Object.<string, string>[]} rows - Parsed rows keyed by lower-case header.
 * @param {number[]} [rowNumbers] - Row number in the sheet per row (default: header = 1, no gaps).
 * @returns {CsvResult}
 */
export function templatesFromRows(rows, rowNumbers = rows.map((_, index) => index + 2)) {
    if (rows.length > 0) {
        const headers = new Set(Object.keys(rows[0]));
        const missing = REQUIRED_COLUMNS.filter((column) => !headers.has(CSV_COLUMNS[column]));
        if (missing.length > 0) {
            const names = missing.map((column) => `"${CSV_COLUMNS[column]}"`).join(', ');
            throw new UsageError(`CSV is missing the column(s) ${names}.`);
        }
    }
    const templates = [];
    const errors = [];
    const seen = new Map();
    for (const [index, row] of rows.entries()) {
        const line = rowNumbers[index];
        try {
            const template = templateFromRow(row);
            const key = templateKey(template);
            if (seen.has(key)) {
                throw new Error(
                    `duplicate of row ${seen.get(key)} (${template.name}, ${template.language})`,
                );
            }
            seen.set(key, line);
            templates.push(template);
        } catch (ex) {
            errors.push({ row: line, message: ex.message });
        }
    }
    return { templates, errors };
}

/**
 * @param {Object.<string, string>} row
 * @returns {import('./normalize.js').Template}
 */
function templateFromRow(row) {
    const value = (column) => String(row[CSV_COLUMNS[column]] ?? '').trim();
    const name = value('name');
    const language = value('language');
    const category = value('category');
    const text = value('body');
    if (!name || !language || !category || !text) {
        throw new Error('template name, language, category and template text are all required');
    }
    assertSafeIdentity({ name, language });
    if (category.toUpperCase() === 'AUTHENTICATION') {
        throw new Error('authentication (OTP) templates are not supported yet');
    }
    const variables = new Set();
    for (const [, variable] of text.matchAll(VARIABLE)) {
        if (!/^\d+$/.test(variable)) {
            throw new Error(
                `only numbered variables like {{1}} are supported, found {{${variable}}}`,
            );
        }
        variables.add(Number(variable));
    }
    const count = variables.size === 0 ? 0 : Math.max(...variables);
    const body = { type: 'BODY', text };
    if (count > 0) {
        const examples = value('examples')
            .split('|')
            .map((example) => example.trim());
        const missingExample = examples.slice(0, count).includes('');
        if (missingExample || examples.length < count) {
            throw new Error(
                `text uses ${count} variable(s) but the Examples column has ` +
                    `${examples.slice(0, count).filter((example) => example !== '').length} ` +
                    `non-empty value(s) for them; give one per variable, separated by |`,
            );
        }
        body.example = { body_text: [examples.slice(0, count)] };
    }
    return normalizeTemplate({
        name,
        language,
        category,
        parameter_format: 'POSITIONAL',
        components: [body],
    });
}

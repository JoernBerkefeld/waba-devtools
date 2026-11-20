/**
 * Human-readable report lines. `--json` prints the report object instead.
 *
 * @param {object} report - Result of a command.
 * @returns {string[]}
 */
export function formatReport(report) {
    switch (report.command) {
        case 'retrieve': {
            return [
                `Retrieved ${report.files.length} template(s) from ${report.stage} (WABA ${report.wabaId}):`,
                ...report.files.map((file) => `  ${file.result.padEnd(9)} ${file.path}`),
            ];
        }
        case 'import': {
            return [
                `Imported ${report.files.length} row(s) from ${report.csv}:`,
                ...cleanupLines(report.csvCleanup),
                ...report.files.map((file) => `  ${file.result.padEnd(9)} ${file.path}`),
                ...rowErrorLines(report.rowErrors),
            ];
        }
        case 'deploy': {
            return deployLines(report);
        }
        case 'check': {
            return report.entries.map((entry) =>
                entry.ok
                    ? `  OK      ${entry.stage}  WABA ${entry.wabaId} (${entry.wabaName ?? 'no name'})`
                    : `  FAILED  ${entry.stage}  WABA ${entry.wabaId}: ${entry.error}`,
            );
        }
        default: {
            return [JSON.stringify(report)];
        }
    }
}

/**
 * One line about the CSV cleanup, when anything was cleaned up.
 *
 * @param {import('./csv.js').CsvCleanup} [cleanup]
 * @returns {string[]}
 */
function cleanupLines(cleanup) {
    if (
        !cleanup ||
        cleanup.removedColumns + cleanup.removedRecords + cleanup.skippedRecords === 0
    ) {
        return [];
    }
    const rows = cleanup.removedRecords + cleanup.skippedRecords;
    return [
        `  CSV cleanup: removed ${cleanup.removedColumns} empty column(s) on the right and ${rows} empty row(s).`,
    ];
}

/**
 * @param {{row: number, message: string}[]} rowErrors
 * @returns {string[]}
 */
function rowErrorLines(rowErrors = []) {
    if (rowErrors.length === 0) {
        return [];
    }
    return [
        `CSV rows with errors (${rowErrors.length}):`,
        ...rowErrors.map((error) => `  row ${error.row}: ${error.message}`),
    ];
}

/**
 * @param {object} report - Deploy report.
 * @returns {string[]}
 */
function deployLines(report) {
    const lines = [];
    const from =
        report.source.type === 'waba'
            ? `${report.source.stage} (WABA ${report.source.wabaId})`
            : (report.source.csv ?? report.source.dir);
    lines.push(
        `${report.dryRun ? 'Dry run — nothing is sent. ' : ''}Source: ${from}`,
        ...cleanupLines(report.source.cleanup),
    );
    for (const target of report.targets) {
        lines.push(`${target.stage} — WABA ${target.wabaId}:`);
        if (target.error) {
            lines.push(`  FAILED  ${target.error}`);
            continue;
        }
        for (const action of target.actions) {
            const status = action.status ? ` [${action.status}]` : '';
            const after = action.statusAfter ? ` → ${action.statusAfter}` : '';
            const result = action.result ? ` ${action.result}${after}` : '';
            const detail = action.error ?? action.note;
            lines.push(
                `  ${action.action.padEnd(9)} ${action.name} (${action.language})${status}${result}` +
                    (detail ? ` — ${detail}` : ''),
            );
        }
        const counts = {};
        for (const action of target.actions) {
            counts[action.action] = (counts[action.action] ?? 0) + 1;
        }
        const summary = Object.entries(counts)
            .map(([action, count]) => `${count} ${action}`)
            .join(', ');
        lines.push(`  = ${summary || 'nothing to do'}`);
    }
    lines.push(...rowErrorLines(report.rowErrors));
    return lines;
}

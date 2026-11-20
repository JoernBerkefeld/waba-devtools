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
        case 'list': {
            return report.wabas.flatMap((waba) => [
                `${waba.stage} — WABA ${waba.wabaId}:`,
                ...(waba.error
                    ? [`  FAILED  ${waba.error}`]
                    : [
                          ...waba.templates.map(
                              (template) =>
                                  `  ${template.name} (${template.language}) ${template.category} [${template.status}]`,
                          ),
                          `  = ${waba.templates.length} template(s)`,
                      ]),
            ]);
        }
        case 'discover': {
            return report.wabas.map((waba) =>
                waba.error
                    ? `  FAILED  WABA ${waba.wabaId}: ${waba.error}`
                    : `  WABA ${waba.wabaId}  ${waba.name ?? ''}  ${waba.phoneNumbers
                          .map((phone) => `${phone.displayPhoneNumber} (${phone.verifiedName})`)
                          .join(', ')}`,
            );
        }
        case 'backup': {
            return report.sets.map((set) =>
                set.error
                    ? `  FAILED  ${set.stage}  WABA ${set.wabaId}: ${set.error}`
                    : `  OK      ${set.stage}  WABA ${set.wabaId} → ${set.backup} (${set.templateCount} templates)`,
            );
        }
        case 'compare': {
            return compareLines(report);
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
 * @param {{wabaId: string, stage?: string, createdAt: string, phase?: string}} info
 * @returns {string}
 */
function setLine(info) {
    if (info.phase === 'live') {
        return `WABA ${info.wabaId} (${info.stage ?? '-'}) right now`;
    }
    const phase = info.phase ? ` ${info.phase}` : '';
    return `WABA ${info.wabaId} (${info.stage ?? '-'}) backup ${info.createdAt}${phase}`;
}

/**
 * @param {{name: string, language: string}} template
 * @returns {string}
 */
function itemLine(template) {
    return `  ${template.name} (${template.language})`;
}

/**
 * Compare report: the two sets, then added / removed / changed with field details.
 *
 * @param {object} report
 * @returns {string[]}
 */
function compareLines(report) {
    const lines = [`Before: ${setLine(report.before)}`, `After:  ${setLine(report.after)}`];
    if (!report.sameWaba) {
        lines.push('Note: before and after are different WABAs.');
    }
    lines.push(
        `Added (${report.added.length}):`,
        ...report.added.map((template) => itemLine(template)),
        `Removed (${report.removed.length}):`,
        ...report.removed.map((template) => itemLine(template)),
        `Changed (${report.changed.length}):`,
    );
    for (const template of report.changed) {
        lines.push(itemLine(template));
        for (const change of template.changes) {
            lines.push(
                `    ${change.field}:`,
                `      before: ${change.before ?? '—'}`,
                `      after:  ${change.after ?? '—'}`,
            );
        }
    }
    lines.push(`Unchanged: ${report.unchanged}`);
    return lines;
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
        for (const [label, value] of [
            ['backup before', target.backup],
            ['backup after', target.backupAfter],
            ['WARNING', target.backupAfterError],
        ]) {
            if (value) {
                lines.push(`  ${label}: ${value}`);
            }
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

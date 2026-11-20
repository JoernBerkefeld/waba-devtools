import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { check, deploy, importCsv, retrieve } from './commands.js';
import { loadConfig, loadDotenvFile } from './config.js';
import { UsageError } from './errors.js';
import { formatReport } from './report.js';

/**
 * Exit codes, documented in the README.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2 };

const HELP = `wabadev — WABA DevTools: deploy WhatsApp message templates between WABAs

Usage:
  wabadev retrieve --from <stage> [--waba <id>] [-m <name>…] [--json]
  wabadev import   --csv <file> [--json]
  wabadev deploy   --to <stage> [-m <name>…] [--dry-run] [--json]
  wabadev deploy   --from <stage> [--waba <id>] --to <stage> [-m <name>…] [--dry-run] [--json]
  wabadev deploy   --csv <file> --to <stage> [--dry-run] [--json]
  wabadev deploy   --to <stage> [--from <stage>] --prune [--yes]
  wabadev check    [--stage <stage>] [--json]

Options:
  -m, --template <name>  Only this template (all its languages). Repeatable.
      --dry-run          Show the planned actions and live statuses; send nothing.
      --prune            Full-set deploys only: delete templates that exist only in the target.
                         Without --yes the deletes are listed but not run.
      --yes              Confirm the deletes of --prune.
      --json             Print the report as JSON.
  -h, --help             Show this help.
  -v, --version          Show the version.

Configuration: .wabadevrc.json in the current folder. Tokens: environment variables named
in the config (a .env file in the current folder is loaded too).`;

const OPTIONS = {
    from: { type: 'string' },
    to: { type: 'string' },
    waba: { type: 'string' },
    stage: { type: 'string' },
    csv: { type: 'string' },
    template: { type: 'string', short: 'm', multiple: true },
    'dry-run': { type: 'boolean' },
    prune: { type: 'boolean' },
    yes: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
};

/**
 * Options each command accepts (besides --json and --help).
 */
const ALLOWED = new Map([
    ['retrieve', ['from', 'waba', 'template']],
    ['import', ['csv']],
    ['deploy', ['from', 'waba', 'to', 'csv', 'template', 'dry-run', 'prune', 'yes']],
    ['check', ['stage']],
]);

/**
 * Runs the CLI. Returns the exit code instead of exiting, so it can be tested.
 *
 * @param {string[]} argv - Arguments after the executable and script.
 * @param {object} [io]
 * @param {string} [io.cwd]
 * @param {NodeJS.ProcessEnv} [io.environment]
 * @param {(text: string) => void} [io.out]
 * @param {(text: string) => void} [io.err]
 * @param {typeof fetch} [io.fetchImpl]
 * @returns {Promise.<number>}
 */
export async function main(argv, io = {}) {
    const {
        cwd = process.cwd(),
        environment = process.env,
        out = (text) => process.stdout.write(`${text}\n`),
        err: error = (text) => process.stderr.write(`${text}\n`),
        fetchImpl,
    } = io;
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (ex) {
        error(`${ex.message}\n\n${HELP}`);
        return EXIT.usage;
    }
    const { values, positionals } = parsed;
    if (values.version) {
        const package_ = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        );
        out(package_.version);
        return EXIT.ok;
    }
    const [command, ...extra] = positionals;
    if (!command || values.help) {
        out(HELP);
        return values.help ? EXIT.ok : EXIT.usage;
    }
    try {
        const allowed = ALLOWED.get(command);
        if (!allowed || extra.length > 0) {
            throw new UsageError(`Unknown command "${positionals.join(' ')}".`);
        }
        const unsupported = Object.keys(values).filter(
            (key) => !['json', 'help'].includes(key) && !allowed.includes(key),
        );
        if (unsupported.length > 0) {
            throw new UsageError(`"${command}" does not take --${unsupported.join(', --')}.`);
        }
        loadDotenvFile(cwd, environment);
        const config = loadConfig(cwd);
        const common = { cwd, config, environment, fetchImpl };
        const names = values.template ?? [];
        let report;
        switch (command) {
            case 'retrieve': {
                requireOption(values.from, 'from');
                report = await retrieve({ ...common, from: values.from, waba: values.waba, names });
                break;
            }
            case 'import': {
                requireOption(values.csv, 'csv');
                report = await importCsv({ ...common, csv: values.csv });
                break;
            }
            case 'deploy': {
                requireOption(values.to, 'to');
                report = await deploy({
                    ...common,
                    to: values.to,
                    from: values.from,
                    waba: values.waba,
                    csv: values.csv,
                    names,
                    dryRun: values['dry-run'] === true,
                    prune: values.prune === true,
                    yes: values.yes === true,
                });
                break;
            }
            default: {
                report = await check({ ...common, stage: values.stage });
            }
        }
        out(values.json ? JSON.stringify(report, undefined, 2) : formatReport(report).join('\n'));
        return report.ok ? EXIT.ok : EXIT.failed;
    } catch (ex) {
        if (values.json) {
            out(JSON.stringify({ command, ok: false, error: ex.message }, undefined, 2));
        } else {
            error(`Error: ${ex.message}`);
        }
        return ex instanceof UsageError ? EXIT.usage : EXIT.failed;
    }
}

/**
 * @param {string|undefined} value - Parsed option value.
 * @param {string} name - Option name for the message.
 * @returns {void}
 */
function requireOption(value, name) {
    if (!value) {
        throw new UsageError(`Missing --${name}.`);
    }
}

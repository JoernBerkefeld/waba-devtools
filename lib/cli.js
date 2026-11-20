import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { check, deploy, discoverWabas, importCsv, listTemplates, retrieve } from './commands.js';
import { loadConfig, loadDotenvFile } from './config.js';
import { UsageError } from './errors.js';
import { formatReport } from './report.js';

/**
 * Exit codes, documented in the README.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2 };

const HELP = `wabadev — WABA DevTools: deploy WhatsApp message templates between WABAs

Usage:
  wabadev retrieve <source> [-m <name>…] [--json]
  wabadev import   --csv <file> [--json]
  wabadev deploy   <target> [-m <name>…] [--dry-run] [--json]          (from the template files)
  wabadev deploy   <source> <target> [-m <name>…] [--dry-run] [--json]  (WABA to WABA)
  wabadev deploy   --csv <file> <target> [--dry-run] [--json]
  wabadev deploy   [<source>] <target> --prune [--yes]
  wabadev deploy   … --backup <folder>                                   (snapshot targets first)
  wabadev list     <source> | <target> [--json]
  wabadev check    [--stage <stage>] [--json]
  wabadev discover --token-env <NAME> [--json]

  <source>  --from <stage> and/or --from-waba <id>
  <target>  --to <stage> and/or --to-waba <id>…

Options:
  -m, --template <name>  Only this template (all its languages). Repeatable.
      --from <stage>     Source: the WABA of this stage.
      --from-waba <id>   Source: this WABA. Needed when the --from stage has several.
      --to <stage>       Target: every WABA of this stage.
      --to-waba <id>     Target: only this WABA. Repeatable. With --to: must be in that stage.
      --dry-run          Show the planned actions and live statuses; send nothing.
      --prune            Full-set deploys only: delete templates that exist only in the target.
                         Without --yes the deletes are listed but not run.
      --yes              Confirm the deletes of --prune.
      --backup <folder>  Before changing a WABA, save all its templates to <folder>/<wabaId>/.
      --from-dir <folder> Source: template files in this folder instead of templatesDir
                         (e.g. a backup: <backup>/<wabaId>).
      --token-env <NAME> discover: the environment variable that holds the access token.
      --json             Print the report as JSON.
  -h, --help             Show this help.
  -v, --version          Show the version.

Configuration: .wabadevrc.json in the current folder. Tokens: environment variables named
in the config (a .env file in the current folder is loaded too).`;

const OPTIONS = {
    from: { type: 'string' },
    to: { type: 'string' },
    'from-waba': { type: 'string' },
    'to-waba': { type: 'string', multiple: true },
    stage: { type: 'string' },
    csv: { type: 'string' },
    template: { type: 'string', short: 'm', multiple: true },
    'dry-run': { type: 'boolean' },
    backup: { type: 'string' },
    'from-dir': { type: 'string' },
    prune: { type: 'boolean' },
    yes: { type: 'boolean' },
    'token-env': { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
};

/**
 * Options each command accepts (besides --json and --help).
 */
const ALLOWED = new Map([
    ['retrieve', ['from', 'from-waba', 'template']],
    ['import', ['csv']],
    [
        'deploy',
        [
            'from',
            'from-waba',
            'to',
            'to-waba',
            'csv',
            'template',
            'dry-run',
            'prune',
            'yes',
            'backup',
            'from-dir',
        ],
    ],
    ['check', ['stage']],
    ['list', ['from', 'from-waba', 'to', 'to-waba']],
    ['discover', ['token-env']],
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
        if (command === 'discover') {
            const report = await discover(values['token-env'], environment, fetchImpl);
            out(
                values.json
                    ? JSON.stringify(report, undefined, 2)
                    : formatReport(report).join('\n'),
            );
            return report.ok ? EXIT.ok : EXIT.failed;
        }
        const config = loadConfig(cwd);
        for (const warning of config.warnings) {
            error(`Warning: ${warning}`);
        }
        const common = { cwd, config, environment, fetchImpl };
        const names = values.template ?? [];
        let report;
        switch (command) {
            case 'retrieve': {
                requireOption(values.from ?? values['from-waba'], 'from or --from-waba');
                report = await retrieve({
                    ...common,
                    from: values.from,
                    fromWaba: values['from-waba'],
                    names,
                });
                break;
            }
            case 'import': {
                requireOption(values.csv, 'csv');
                report = await importCsv({ ...common, csv: values.csv });
                break;
            }
            case 'deploy': {
                requireOption(values.to ?? values['to-waba'], 'to or --to-waba');
                report = await deploy({
                    ...common,
                    to: values.to,
                    from: values.from,
                    toWabas: values['to-waba'] ?? [],
                    fromWaba: values['from-waba'],
                    csv: values.csv,
                    names,
                    dryRun: values['dry-run'] === true,
                    prune: values.prune === true,
                    yes: values.yes === true,
                    backupDir: values.backup && path.resolve(cwd, values.backup),
                    sourceDir: values['from-dir'] && path.resolve(cwd, values['from-dir']),
                });
                break;
            }
            case 'list': {
                report = await listTemplates({
                    ...common,
                    from: values.from,
                    fromWaba: values['from-waba'],
                    to: values.to,
                    toWabas: values['to-waba'] ?? [],
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
 * `discover` needs no config: the token comes from the named environment variable.
 *
 * @param {string|undefined} variableName - `--token-env` value.
 * @param {NodeJS.ProcessEnv} environment
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise.<object>} Report.
 */
function discover(variableName, environment, fetchImpl) {
    requireOption(variableName, 'token-env');
    const token = environment[variableName];
    if (!token) {
        throw new UsageError(
            `The environment variable ${variableName} is not set (or not in .env).`,
        );
    }
    return discoverWabas({ token, fetchImpl });
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

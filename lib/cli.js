import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
    check,
    createBackup,
    deploy,
    discoverWabas,
    importCsv,
    listTemplates,
    retrieve,
} from './commands.js';
import { compareBackups, compareWabas, compareWithLive } from './compare.js';
import { loadConfig, loadDotenvFile, parseJson } from './config.js';
import { UsageError } from './errors.js';
import { formatReport } from './report.js';

/**
 * Exit codes, documented in the README.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2 };

const HELP = `waba — WABA DevTools: deploy WhatsApp message templates between WABAs

Usage:
  waba retrieve <source> [-m <name>…] [--json]
  waba import   --csv <file> [--json]
  waba deploy   <target> [-m <name>…] [--dry-run] [--json]          (from the template files)
  waba deploy   <source> <target> [-m <name>…] [--dry-run] [--json]  (WABA to WABA)
  waba deploy   --csv <file> <target> [--dry-run] [--json]
  waba deploy   [<source>] <target> --prune [--yes]
  waba deploy   … --backup <folder>                                   (snapshot targets first)
  waba list     <source> | <target> [--json]
  waba check    [--stage <stage>] [--json]
  waba discover --token-env <NAME> [--business <id>] [--json]
  waba compare  <backup set> <backup set> [--json]   (older vs newer, by backup time)
  waba compare  <backup set> --live [--waba <id>] [--json]   (backup vs the WABA right now)
  waba compare  --before-waba <id> --after-waba <id> [--json]   (two WABAs right now)
  waba backup   --stage <stage> | --waba <id>… --backup <folder> [--json]   (restore point)

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
                         Without --yes the deletes are listed but not run — creates and updates
                         ARE sent. Preview everything with --dry-run.
      --yes              Confirm the deletes of --prune.
      --expect <file>    Send only what this preview showed: the --json output of a previous
                         deploy --dry-run. A WABA whose plan changed since gets nothing.
      --backup <folder>  Before changing a WABA, save all its templates as a backup set
                         <folder>/<wabaId>_<time>_before/.
      --backup-after     With --backup: also save each changed WABA after the changes
                         (<wabaId>_<time>_after/).
      --from-dir <folder> Source: template files in this folder instead of templatesDir
                         (e.g. a backup set: <backup>/<wabaId>_<time>).
      --token-env <NAME> discover: the environment variable that holds the access token.
      --business <id>    discover: the business portfolio whose WABAs to list (needed when Meta
                         does not name the WABAs for the token).
      --live             compare: compare with the WABA's templates right now (nothing is saved).
      --waba <id>        backup: this WABA (repeatable); compare --live: another WABA than the
                         backup's own.
      --before-waba <id> compare: this WABA (right now) is "before" …
      --after-waba <id>  … and this one "after". Nothing is saved.
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
    waba: { type: 'string', multiple: true },
    live: { type: 'boolean' },
    'before-waba': { type: 'string' },
    'after-waba': { type: 'string' },
    csv: { type: 'string' },
    template: { type: 'string', short: 'm', multiple: true },
    'dry-run': { type: 'boolean' },
    backup: { type: 'string' },
    'backup-after': { type: 'boolean' },
    expect: { type: 'string' },
    'from-dir': { type: 'string' },
    prune: { type: 'boolean' },
    yes: { type: 'boolean' },
    'token-env': { type: 'string' },
    business: { type: 'string' },
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
            'backup-after',
            'expect',
            'from-dir',
        ],
    ],
    ['check', ['stage']],
    ['list', ['from', 'from-waba', 'to', 'to-waba']],
    ['discover', ['token-env', 'business']],
    ['compare', ['live', 'waba', 'before-waba', 'after-waba']],
    ['backup', ['stage', 'waba', 'backup']],
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
        if (!allowed || (command !== 'compare' && extra.length > 0)) {
            throw new UsageError(`Unknown command "${positionals.join(' ')}".`);
        }
        const isTwoWabas = Boolean(values['before-waba'] || values['after-waba']);
        if (
            command === 'compare' &&
            isTwoWabas &&
            (extra.length > 0 || values.live || values.waba)
        ) {
            throw new UsageError(
                'compare --before-waba/--after-waba compares two WABAs live; give no backup set, --live or --waba.',
            );
        }
        if (command === 'compare' && values.waba && (!values.live || values.waba.length > 1)) {
            throw new UsageError('compare takes one --waba, together with --live.');
        }
        if (command === 'compare' && values.live && extra.length !== 1) {
            throw new UsageError('compare --live needs one backup set folder.');
        }
        const unsupported = Object.keys(values).filter(
            (key) => !['json', 'help'].includes(key) && !allowed.includes(key),
        );
        if (unsupported.length > 0) {
            throw new UsageError(`"${command}" does not take --${unsupported.join(', --')}.`);
        }
        loadDotenvFile(cwd, environment);
        if (!isTwoWabas && command === 'compare' && !values.live) {
            if (extra.length !== 2) {
                throw new UsageError('compare needs two backup set folders.');
            }
            const report = await compareBackups(
                path.resolve(cwd, extra[0]),
                path.resolve(cwd, extra[1]),
            );
            out(
                values.json
                    ? JSON.stringify(report, undefined, 2)
                    : formatReport(report).join('\n'),
            );
            return EXIT.ok;
        }
        if (command === 'discover') {
            const report = await discover(
                values['token-env'],
                values.business,
                environment,
                fetchImpl,
            );
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
                    backupAfter: values['backup-after'] === true,
                    expectedActions: values.expect
                        ? readExpectedActions(path.resolve(cwd, values.expect))
                        : undefined,
                    sourceDir: values['from-dir'] && path.resolve(cwd, values['from-dir']),
                });
                break;
            }
            case 'compare': {
                if (isTwoWabas) {
                    report = await compareWabas({
                        ...common,
                        beforeWaba: values['before-waba'],
                        afterWaba: values['after-waba'],
                    });
                    break;
                }
                report = await compareWithLive({
                    ...common,
                    set: path.resolve(cwd, extra[0]),
                    wabaId: values.waba?.[0],
                });
                break;
            }
            case 'backup': {
                requireOption(values.backup, 'backup');
                report = await createBackup({
                    ...common,
                    stage: values.stage,
                    wabaIds: values.waba ?? [],
                    backupDir: path.resolve(cwd, values.backup),
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
            out(
                JSON.stringify(
                    {
                        command,
                        ok: false,
                        error: ex.message,
                        ...(ex instanceof UsageError && ex.code && { code: ex.code }),
                    },
                    undefined,
                    2,
                ),
            );
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
 * @param {string|undefined} businessId - `--business` value.
 * @param {NodeJS.ProcessEnv} environment
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise.<object>} Report.
 */
function discover(variableName, businessId, environment, fetchImpl) {
    requireOption(variableName, 'token-env');
    const token = environment[variableName];
    if (!token) {
        throw new UsageError(
            `The environment variable ${variableName} is not set (or not in .env).`,
        );
    }
    return discoverWabas({ token, businessId, fetchImpl });
}

/**
 * Reads `--expect <file>`: the `--json` report of a `deploy --dry-run` (or just its `targets`).
 *
 * @param {string} file
 * @returns {{wabaId: string, actions: {name: string, language: string, action: string}[]}[]}
 */
function readExpectedActions(file) {
    let parsed;
    try {
        parsed = parseJson(readFileSync(file, 'utf8'));
    } catch (ex) {
        throw new UsageError(`--expect: cannot read ${file}: ${ex.message}`);
    }
    const targets = Array.isArray(parsed) ? parsed : parsed?.targets;
    const isValid =
        Array.isArray(targets) &&
        targets.every(
            (target) =>
                typeof target?.wabaId === 'string' &&
                Array.isArray(target.actions) &&
                target.actions.every(
                    (action) =>
                        typeof action?.name === 'string' &&
                        typeof action.language === 'string' &&
                        typeof action.action === 'string',
                ),
        );
    if (!isValid) {
        throw new UsageError(
            `--expect: ${file} is not the --json output of "deploy --dry-run" (targets[].wabaId, targets[].actions[].name/language/action).`,
        );
    }
    if (parsed?.dryRun === false) {
        throw new UsageError(`--expect: ${file} is from a real deploy, not from --dry-run.`);
    }
    return targets;
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

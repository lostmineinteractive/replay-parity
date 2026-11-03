import {
  ConfigError,
  EXIT_CODES,
  loadDiffRules,
  loadThresholds,
  type DiffRules,
  type Thresholds,
} from '@replay-parity/core';
import { Command } from 'commander';
import {
  checkEffective,
  deferredConfigError,
  displayText,
  loadConfig,
  type CliContext,
} from '../config/index.js';
import { out, type CliStreams } from '../io.js';
import { collect } from '../options.js';
import {
  checkBarrierTags,
  checkRecording,
  checkRules,
  checkThresholds,
  formatCheck,
  hasError,
  probeHealth,
  probeReset,
  scanRecording,
  type RecordingScan,
  type Check,
} from '../preflight.js';

export interface ValidateCommandOptions {
  recording: string;
  rules?: string;
  thresholds?: string;
  target?: string;
  reference?: string;
  reset?: string;
  barrierTag: string[];
  config?: string;
  profile?: string;
}

export interface ValidateContext extends CliContext {
  /** The commands the config file may hold sections for. */
  commands: readonly Command[];
  /** The validate command itself, for the unresolved text of its flags and a deferred config error. */
  command?: Command | undefined;
}

function failure(name: string, e: unknown): Check {
  return { level: 'error', name, detail: e instanceof Error ? e.message : String(e) };
}

/**
 * Parses every file given and runs every check. Prints one line per check
 * and exits 0 with only ok and warn lines, 1 with any error.
 */
export async function runValidate(
  options: ValidateCommandOptions,
  streams: CliStreams,
  context: ValidateContext,
): Promise<number> {
  const checks: Check[] = [];
  const print = (check: Check): void => {
    checks.push(check);
    out(streams, formatCheck(check));
  };

  const held = context.command === undefined ? undefined : deferredConfigError(context.command);
  if (held !== undefined) {
    print(failure('config', held));
  } else {
    try {
      const loaded = await loadConfig(
        context.commands,
        { configFlag: options.config, profileFlag: options.profile },
        context.env,
        context.cwd,
      );
      if (loaded.path === null) {
        print({ level: 'ok', name: 'config', detail: 'no file selected and no ./rp.yaml' });
      } else {
        // Every section goes through its command's option parsers, not only the one running.
        for (const command of context.commands) {
          checkEffective(command, loaded.effective.get(command.name()) ?? new Map());
        }
        const values = [...loaded.effective.values()].reduce((n, m) => n + m.size, 0);
        print({
          level: 'ok',
          name: 'config',
          detail: `${loaded.path}${loaded.profile === null ? '' : ` with profile ${loaded.profile}`}, ${values} value${values === 1 ? '' : 's'} in effect`,
        });
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      print(failure('config', e));
    }
  }

  let scan: RecordingScan;
  try {
    scan = await scanRecording(options.recording);
  } catch (e) {
    print(failure('recording', e));
    return EXIT_CODES.error;
  }
  print(checkRecording(options.recording, scan));
  const tags = scan.tags;

  if (options.thresholds !== undefined) {
    let thresholds: Thresholds | undefined;
    try {
      thresholds = await loadThresholds(options.thresholds);
      print({ level: 'ok', name: 'thresholds', detail: `${options.thresholds} parses` });
    } catch (e) {
      print(failure('thresholds', e));
    }
    if (thresholds !== undefined) for (const c of checkThresholds(thresholds, tags)) print(c);
  }

  if (options.rules !== undefined) {
    let rules: DiffRules | undefined;
    try {
      rules = await loadDiffRules(options.rules);
      print({ level: 'ok', name: 'rules', detail: `${options.rules} parses` });
    } catch (e) {
      print(failure('rules', e));
    }
    if (rules !== undefined) {
      // A second pass over the stream gathers the facts these rules ask about.
      const ruleScan = await scanRecording(options.recording, rules);
      for (const c of checkRules(rules, ruleScan)) print(c);
    }
  }

  for (const c of checkBarrierTags(options.barrierTag, tags)) print(c);

  const label = (attribute: string, value: string): string =>
    context.command === undefined ? value : displayText(context.command, attribute, value);
  if (options.target !== undefined) {
    print(
      await probeHealth('target', { url: options.target, label: label('target', options.target) }),
    );
  }
  if (options.reference !== undefined) {
    print(
      await probeHealth('reference', {
        url: options.reference,
        label: label('reference', options.reference),
      }),
    );
  }
  if (options.reset !== undefined) {
    print(await probeReset({ url: options.reset, label: label('reset', options.reset) }));
  }

  return hasError(checks) ? EXIT_CODES.error : EXIT_CODES.pass;
}

export function validateCommand(
  streams: CliStreams,
  exit: (code: number) => void,
  context: CliContext,
): Command {
  return new Command('validate')
    .description(
      'Parse the recording, the rules, the thresholds, and the config file, check that they agree with each other, and probe the URLs given. Prints one line per check and exits 1 on any error.',
    )
    .requiredOption('--recording <path>', 'recording the other files are checked against')
    .option('--rules <path>', 'diff rules file to check')
    .option('--thresholds <path>', 'thresholds file to check')
    .option('--target <url>', 'candidate URL to probe with a GET')
    .option('--reference <url>', 'reference URL to probe with a GET')
    .option('--reset <url>', 'reset URL to probe with a POST, which must answer 2xx')
    .option(
      '--barrier-tag <tag>',
      'barrier tag that must exist in the recording, repeatable',
      collect,
      [],
    )
    .action(async (opts: ValidateCommandOptions, command: Command) => {
      exit(
        await runValidate(opts, streams, {
          ...context,
          commands: command.parent?.commands ?? [],
          command,
        }),
      );
    });
}

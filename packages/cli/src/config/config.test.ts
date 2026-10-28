import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, parseYaml } from '@replay-parity/core';
import { Command, InvalidArgumentError, Option } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  applyEffective,
  interpolateCommandLine,
  unresolvedText,
  wrapListParsers,
} from './apply.js';
import { hasInterpolation, interpolate, interpolationNames } from './interpolate.js';
import {
  envValue,
  envVariableName,
  loadConfig,
  locateConfigFile,
  scanConfigFlags,
} from './load.js';
import { configFileSchema, configurableOptions, optionKind, toConfigFile } from './schema.js';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** A command with one option of every kind, in the shape the real commands use. */
function sample(name = 'run'): Command {
  return new Command(name)
    .requiredOption('--target <url>', 'target')
    .option('--out <path>', 'out', 'run.json')
    .addOption(new Option('--pace <mode>', 'pace').choices(['slow', 'max']).default('slow'))
    .addOption(new Option('--concurrency <n>', 'n').default(8).argParser(positiveInt))
    .option('--header <name: value>', 'header', collect, [])
    .option('--invariants', 'invariants', false)
    .option('--no-include-dependencies', 'deps')
    .option('--explain [id]', 'explain')
    .option('--config <path>', 'config')
    .option('--profile <name>', 'profile')
    .exitOverride()
    .action(() => undefined);
}

async function tempFile(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-config-'));
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

describe('interpolate', () => {
  it('replaces ${NAME}, keeps $$ as a dollar sign, and names a missing variable and the key', () => {
    const env = { TOKEN: 'abc', HOST: 'h' };
    expect(interpolate('Bearer ${TOKEN}', env, 'replay.header')).toBe('Bearer abc');
    expect(interpolate('http://${HOST}:1/${TOKEN}', env, 'k')).toBe('http://h:1/abc');
    expect(interpolate('cost $$5 and $${TOKEN}', env, 'k')).toBe('cost $5 and ${TOKEN}');
    expect(interpolate('no reference $TOKEN ${not-a-name}', env, 'k')).toBe(
      'no reference $TOKEN ${not-a-name}',
    );
    expect(() => interpolate('${MISSING}', env, 'rp.yaml: replay.target')).toThrow(
      new ConfigError('environment variable MISSING is not set (used in rp.yaml: replay.target)'),
    );
    expect(hasInterpolation('${A}')).toBe(true);
    expect(hasInterpolation('$$')).toBe(true);
    expect(hasInterpolation('plain')).toBe(false);
    expect(interpolationNames('${A} ${B} ${A} $$')).toEqual(['A', 'B']);
  });
});

describe('the schema derived from a command', () => {
  it('classifies every option and skips the configuration flags', () => {
    const specs = configurableOptions(sample());
    expect(specs.map((s) => [s.key, s.attribute, s.kind])).toEqual([
      ['target', 'target', 'value'],
      ['out', 'out', 'value'],
      ['pace', 'pace', 'value'],
      ['concurrency', 'concurrency', 'value'],
      ['header', 'header', 'list'],
      ['invariants', 'invariants', 'boolean'],
      ['no-include-dependencies', 'includeDependencies', 'boolean'],
      ['explain', 'explain', 'optional-value'],
    ]);
    expect(optionKind(new Option('--flag'))).toBe('boolean');
  });

  it('accepts a valid file and rejects unknown commands, unknown keys, and wrong types by key', () => {
    const schema = configFileSchema([sample('run'), sample('other')]);
    const text = [
      'run:',
      '  target: http://x',
      '  concurrency: 4',
      '  header: [a, 1]',
      '  invariants: true',
      '  no-include-dependencies: true',
      '  explain: true',
      'profiles:',
      '  p:',
      '    other: { out: o.json }',
      '',
    ].join('\n');
    const file = toConfigFile(parseYaml(text, schema, 'rp.yaml'));
    expect(file.commands).toEqual({
      run: {
        target: 'http://x',
        concurrency: 4,
        header: ['a', 1],
        invariants: true,
        'no-include-dependencies': true,
        explain: true,
      },
    });
    expect(file.profiles).toEqual({ p: { other: { out: 'o.json' } } });
    const bad = (doc: string): string => {
      try {
        parseYaml(doc, schema, 'rp.yaml');
      } catch (e) {
        return (e as Error).message;
      }
      return 'parsed';
    };
    expect(bad('bogus: {}')).toBe('rp.yaml: unknown key "bogus" at (root)');
    expect(bad('run: { targt: x }')).toBe('rp.yaml: unknown key "targt" at run');
    expect(bad('run: { invariants: yes please }')).toBe(
      'rp.yaml: expected true or false at run.invariants',
    );
    expect(bad('run: { header: a }')).toBe('rp.yaml: expected a list at run.header');
    expect(bad('run: { concurrency: [1] }')).toBe(
      'rp.yaml: expected a string or a number at run.concurrency',
    );
    expect(bad('profiles: { p: { run: { nope: 1 } } }')).toBe(
      'rp.yaml: unknown key "nope" at profiles.p.run',
    );
    expect(bad('profiles: { p: { bogus: {} } }')).toBe(
      'rp.yaml: unknown key "bogus" at profiles.p',
    );
  });
});

describe('locating the file and reading the environment', () => {
  it('scans --config and --profile in both spellings, last one wins', () => {
    expect(scanConfigFlags(['run', '--config', 'a.yaml', '--profile', 'p'])).toEqual({
      configFlag: 'a.yaml',
      profileFlag: 'p',
    });
    expect(
      scanConfigFlags(['run', '--config=b.yaml', '--profile=q', '--config', 'c.yaml']),
    ).toEqual({ configFlag: 'c.yaml', profileFlag: 'q' });
    expect(scanConfigFlags(['run', '--config', '--profile', 'p'])).toEqual({ profileFlag: 'p' });
    expect(scanConfigFlags(['run'])).toEqual({});
  });

  it('prefers --config, then RP_CONFIG, then ./rp.yaml when it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-locate-'));
    expect(locateConfigFile('x.yaml', { RP_CONFIG: 'y.yaml' }, dir)).toEqual({
      path: resolve(dir, 'x.yaml'),
      from: 'flag',
    });
    expect(locateConfigFile(undefined, { RP_CONFIG: 'y.yaml' }, dir)).toEqual({
      path: resolve(dir, 'y.yaml'),
      from: 'env',
    });
    expect(locateConfigFile(undefined, {}, dir)).toBeNull();
    await writeFile(join(dir, 'rp.yaml'), '');
    expect(locateConfigFile(undefined, {}, dir)).toEqual({
      path: join(dir, 'rp.yaml'),
      from: 'cwd',
    });
  });

  it('names variables after the command and the flag and converts their text by kind', () => {
    expect(envVariableName('replay', 'max-gap-ms')).toBe('RP_REPLAY_MAX_GAP_MS');
    expect(envVariableName('capture', 'no-append')).toBe('RP_CAPTURE_NO_APPEND');
    expect(envValue('true', 'boolean', 'V')).toBe(true);
    expect(envValue('false', 'boolean', 'V')).toBe(false);
    expect(() => envValue('1', 'boolean', 'RP_X')).toThrow(
      new ConfigError('RP_X: expected true or false, got "1"'),
    );
    expect(envValue('a: 1, b: 2,, ', 'list', 'V')).toEqual(['a: 1', 'b: 2']);
    expect(envValue('7', 'value', 'V')).toBe('7');
    expect(envValue('true', 'optional-value', 'V')).toBe(true);
    expect(envValue('id-1', 'optional-value', 'V')).toBe('id-1');
  });
});

describe('merging the layers', () => {
  const text = [
    'run:',
    '  target: from-file',
    '  out: file.json',
    "  header: ['a: 1', 'b: 2']",
    'other:',
    '  target: other-file',
    'profiles:',
    '  p:',
    '    run:',
    '      target: from-profile',
    "      header: ['c: 3']",
    '',
  ].join('\n');

  it('applies the file, then the profile, then the environment, and reports what applied', async () => {
    const path = await tempFile('rp.yaml', text);
    const commands = [sample('run'), sample('other')];
    const plain = await loadConfig(commands, { configFlag: path }, {}, '/');
    expect(plain.path).toBe(path);
    expect(plain.pathFrom).toBe('flag');
    expect(plain.profile).toBeNull();
    expect(plain.effective.get('run')?.get('target')).toEqual({
      value: 'from-file',
      source: 'file',
      origin: `${path}: run.target`,
    });
    expect(plain.effective.get('run')?.get('header')?.value).toEqual(['a: 1', 'b: 2']);
    expect(plain.effective.get('other')?.get('target')?.value).toBe('other-file');
    expect(plain.envApplied).toEqual([]);

    const env = {
      RP_CONFIG: path,
      RP_PROFILE: 'p',
      RP_RUN_OUT: 'env.json',
      RP_OTHER_HEADER: 'x: 1,y: 2',
      RP_BOGUS: '1',
      RP_RUN_TARGT: 'typo',
      HOME: '/home',
    };
    const layered = await loadConfig(commands, {}, env, '/');
    expect(layered.pathFrom).toBe('env');
    expect(layered.profile).toBe('p');
    expect(layered.profileFrom).toBe('env');
    const run = layered.effective.get('run') as Map<
      string,
      { value: unknown; source: string; origin: string }
    >;
    expect(run.get('target')).toMatchObject({ value: 'from-profile', source: 'profile' });
    expect(run.get('target')?.origin).toBe(`${path}: profiles.p.run.target`);
    expect(run.get('header')).toMatchObject({ value: ['c: 3'], source: 'profile' });
    expect(run.get('out')).toEqual({ value: 'env.json', source: 'env', origin: 'RP_RUN_OUT' });
    expect(layered.effective.get('other')?.get('header')?.value).toEqual(['x: 1', 'y: 2']);
    expect(layered.envApplied).toEqual(['RP_RUN_OUT', 'RP_OTHER_HEADER']);
    expect(layered.envUnrecognized).toEqual(['RP_BOGUS', 'RP_RUN_TARGT']);

    const flagged = await loadConfig(commands, { profileFlag: 'p' }, { RP_CONFIG: path }, '/');
    expect(flagged.profileFrom).toBe('flag');
  });

  it('rejects a missing selected profile, a profile without a file, and a missing file', async () => {
    const path = await tempFile('rp.yaml', text);
    const commands = [sample('run'), sample('other')];
    await expect(
      loadConfig(commands, { configFlag: path, profileFlag: 'q' }, {}, '/'),
    ).rejects.toThrow(new ConfigError(`${path}: profile "q" is not defined (defined: p)`));
    const bare = await tempFile('bare.yaml', 'run: { target: x }\n');
    await expect(
      loadConfig(commands, { configFlag: bare, profileFlag: 'q' }, {}, '/'),
    ).rejects.toThrow(/profile "q" is not defined \(the file has no profiles\)/);
    const dir = await mkdtemp(join(tmpdir(), 'rp-nofile-'));
    await expect(loadConfig(commands, { profileFlag: 'p' }, {}, dir)).rejects.toThrow(
      /profile "p" was selected but no config file was found/,
    );
    await expect(loadConfig(commands, { configFlag: 'missing.yaml' }, {}, dir)).rejects.toThrow(
      new ConfigError(`${join(dir, 'missing.yaml')}: config file not found (from --config)`),
    );
    await expect(loadConfig(commands, {}, { RP_CONFIG: 'gone.yaml' }, dir)).rejects.toThrow(
      /gone\.yaml: config file not found \(from RP_CONFIG\)/,
    );
    await expect(loadConfig(commands, {}, {}, dir)).resolves.toMatchObject({
      path: null,
      file: null,
    });
  });
});

describe('applying values to a command', () => {
  function effective(
    values: Record<string, unknown>,
  ): Map<string, { value: unknown; source: 'file'; origin: string }> {
    const map = new Map<string, { value: unknown; source: 'file'; origin: string }>();
    for (const [key, value] of Object.entries(values)) {
      map.set(key, { value, source: 'file', origin: `rp.yaml: run.${key}` });
    }
    return map;
  }

  it('sets parsed defaults the command line overrides, with a repeated flag replacing a list', async () => {
    const command = sample();
    wrapListParsers(command);
    applyEffective(
      command,
      effective({
        target: 'http://${HOST}',
        concurrency: 4,
        pace: 'max',
        header: ['a: ${A}', 'b: 2'],
        invariants: true,
        'no-include-dependencies': true,
        explain: 'id-1',
      }),
      { HOST: 'h', A: '1' },
    );
    await command.parseAsync(['--concurrency', '9', '--header', 'c: 3', '--header', 'd: 4'], {
      from: 'user',
    });
    expect(command.opts()).toEqual({
      target: 'http://h',
      out: 'run.json',
      pace: 'max',
      concurrency: 9,
      header: ['c: 3', 'd: 4'],
      invariants: true,
      includeDependencies: false,
      explain: 'id-1',
    });
    expect(command.getOptionValueSource('target')).toBe('config');
    expect(command.getOptionValueSource('concurrency')).toBe('cli');
    expect(unresolvedText(command, 'target')).toBe('http://${HOST}');
    expect(unresolvedText(command, 'header')).toEqual(['a: ${A}', 'b: 2']);
    expect(unresolvedText(command, 'out')).toBeUndefined();

    // Without the command line the configured list and the parsed values stand.
    const alone = sample();
    wrapListParsers(alone);
    applyEffective(alone, effective({ target: 't', header: ['a: 1'], explain: true }), {});
    await alone.parseAsync([], { from: 'user' });
    expect(alone.opts()).toMatchObject({ target: 't', header: ['a: 1'], explain: true });

    // False for a switch means the flag is not given, so the default stays.
    const off = sample();
    applyEffective(
      off,
      effective({
        target: 't',
        invariants: false,
        'no-include-dependencies': false,
        explain: false,
      }),
      {},
    );
    await off.parseAsync([], { from: 'user' });
    expect(off.opts()).toMatchObject({ invariants: false, includeDependencies: true });
    expect(off.opts()).not.toHaveProperty('explain');
  });

  it('runs the option parsers and choice lists on configured values and names the key', () => {
    expect(() => applyEffective(sample(), effective({ concurrency: 'many' }), {})).toThrow(
      new ConfigError('rp.yaml: run.concurrency: expected a positive integer'),
    );
    expect(() => applyEffective(sample(), effective({ pace: 'slower' }), {})).toThrow(
      /rp\.yaml: run\.pace: Allowed choices are slow, max\./,
    );
    expect(() => applyEffective(sample(), effective({ header: ['x: ${GONE}'] }), {})).toThrow(
      new ConfigError('environment variable GONE is not set (used in rp.yaml: run.header)'),
    );
  });

  it('resolves ${NAME} in the secret bearing flags given on the command line only', async () => {
    const command = sample();
    await command.parseAsync(
      [
        '--target',
        'http://${HOST}',
        '--header',
        'authorization: Bearer ${TOKEN}',
        '--out',
        '${OUT}',
      ],
      { from: 'user' },
    );
    interpolateCommandLine(command, { HOST: 'h', TOKEN: 't' });
    expect(command.opts()).toMatchObject({
      target: 'http://h',
      header: ['authorization: Bearer t'],
      out: '${OUT}',
    });
    expect(command.getOptionValueSource('target')).toBe('cli');
    expect(unresolvedText(command, 'target')).toBe('http://${HOST}');
    const missing = sample();
    await missing.parseAsync(['--target', 'http://${HOST}'], { from: 'user' });
    expect(() => interpolateCommandLine(missing, {})).toThrow(
      new ConfigError('environment variable HOST is not set (used in --target)'),
    );
  });
});

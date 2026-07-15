import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ensureReusableNodeModules,
} from '../utils/repo-deps.js';

export {
  hasUsableNodeModules,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
} from '../utils/repo-deps.js';

export const PACKED_INSTALL_SMOKE_CORE_COMMANDS = [
  ['--help'],
  ['version'],
  ['api', '--help'],
  ['sparkshell', '--help'],
] as const;

export const PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

export const PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS = [
  { name: 'directive-use-ralplan', prompt: 'use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-please-use-ralplan', prompt: 'please use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-run-ralplan', prompt: 'run $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-list-use-ralplan', prompt: '- use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-documentation-then-command', prompt: 'use $ralplan is the consensus-planning command\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-then-implicit-command', prompt: 'use $ralplan is the consensus-planning command\nUse autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-trailing-prose-then-command', prompt: 'use $ralplan is the workflow command for planning\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-implicit-prose', prompt: 'use $ralplan is the workflow command for autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'directive-documentation-alias-prose', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.', expectedSkill: null, expectedStopBlock: false },
  { name: 'directive-coordinated-documentation-then-command', prompt: '- use $ralplan and $autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'directive-documentation-semicolon-directive', prompt: 'use $ralplan is the consensus-planning command; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-two-documentation-blocks', prompt: 'use $ralplan is the consensus-planning command\nuse $autopilot is the autonomous workflow command\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'directive-documentation-embedded-token-then-command', prompt: 'use $ralplan is the workflow command for $team\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-task-noun', prompt: 'use $ralplan is the workflow command; use $autopilot update the documentation', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-implicit-followup', prompt: 'use $ralplan is the consensus-planning command; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-transition-followup', prompt: 'use $ralplan is the consensus-planning command; then use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-explicit-alias', prompt: 'use $ralplan is the consensus-planning command; $team is its alias', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-implicit-chain', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'doc-fullwidth-separator', prompt: 'use $ralplan，$autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-compact-slash', prompt: 'use $ralplan/$autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'reference-prompts-followup', prompt: '[docs]: /target "title\nUse /prompts:architect"\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'doc-period-implicit', prompt: 'use $ralplan is the consensus-planning command. Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-bare-implicit', prompt: 'use $ralplan is the consensus-planning command; autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-semicolon', prompt: 'use $ralplan is the consensus-planning command； use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-but-followup', prompt: 'use $ralplan is the workflow command; but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-oxford', prompt: 'use $ralplan， $autopilot， and $team are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-zero-title', prompt: '[docs]: ./target\n(autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-also-alias-explicit', prompt: 'use $ralplan is the consensus-planning command; $team is also its alias', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-also-alias-implicit', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is also its alias.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-embedded-mention', prompt: 'use $ralplan is the workflow command; $team appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
  { name: 'chained-negation', prompt: '$ralplan; $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'long-negation', prompt: `$ralplan; $autopilot${' '.repeat(193)}is prohibited`, expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'doc-arabic-comma', prompt: 'use $ralplan، $autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'arabic-negation', prompt: '$ralplan، $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-arabic-negation', prompt: 'Autopilot mode، deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'fullwidth-frame-reset', prompt: 'For instance: manual mode is slower。 Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-abbreviation', prompt: 'use $ralplan is the workflow command, e.g. use $autopilot in examples.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-doc-mention', prompt: 'use $ralplan is the workflow command; autopilot mode appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-doc-chain', prompt: 'use $ralplan is the workflow command; autopilot mode is its alias; $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'long-command-gap', prompt: `use $ralplan is the workflow command; use${' '.repeat(161)}$autopilot build it`, expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'ideographic-negation', prompt: '$ralplan、 $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-ideo-negation', prompt: 'Autopilot mode、 deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-exclamation', prompt: 'use $ralplan is the consensus-planning command! run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-question', prompt: 'use $ralplan is the consensus-planning command？ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'implicit-doc-predecessor', prompt: 'Autopilot mode is workflow documentation.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'confusable-use-verb', prompt: 'uſe $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-please', prompt: 'pleaſe use $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-prompts-token-then-command', prompt: '/promptſ:architect; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'reserved-em-dash-boundary', prompt: '/prompts:architect— use autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'reserved-fullwidth-comma-boundary', prompt: '/prompts:architect， use autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-implicit-verb', prompt: 'Do not use deep interview but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-fullwidth-colon', prompt: 'For instance： use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-fullwidth-comma', prompt: 'For instance， use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-arabic-comma', prompt: 'For instance، use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-ideo-comma', prompt: 'For instance、 use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-explicit-documented', prompt: 'use $ralplan is the workflow command; $autopilot is documented in the guide.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-explicit-described', prompt: '$autopilot is described in the manual.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-comma-followup', prompt: 'use $ralplan is the workflow command, but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fw-comma-followup', prompt: 'use $ralplan is the workflow command， but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-arabic-followup', prompt: 'use $ralplan is the workflow command، but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-ideo-followup', prompt: 'use $ralplan is the workflow command、 but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-arabic-followup', prompt: 'Do not run $ralplan، use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-ideo-followup', prompt: 'Do not run $ralplan、 use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'implicit-doc-prefix-next', prompt: 'The docs mention autopilot mode.\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'implicit-doc-prefix-line', prompt: 'The docs mention autopilot mode; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'implicit-doc-subject-line', prompt: 'Autopilot mode is workflow documentation; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'compact-explicit-negation', prompt: '$ralplan,$autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'compact-implicit-negation', prompt: 'Autopilot mode،deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-clause-local-prefix', prompt: '$ralplan; $autopilot is documented in the guide.', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-chain-described', prompt: 'use $ralplan is the workflow command; autopilot mode is documented in the guide; $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'doc-chain-workflow', prompt: 'use $ralplan is the workflow command; autopilot mode is workflow documentation; use $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'ref-inline-explicit', prompt: '[docs]: $ralplan\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'ref-inline-prompts', prompt: '[docs]: /prompts:architect\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'list-fullwidth-explicit-doc', prompt: '- $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fullwidth-implicit-doc', prompt: '- autopilot mode： autonomous workflow command', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-straight', prompt: "$ralplan's workflow is documented", expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-curly', prompt: '$ralplan’s workflow is documented', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-fullwidth', prompt: '$ralplan＇s workflow is documented', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-prompts', prompt: "/prompts:architect's syntax is documented", expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-kata', prompt: '$・autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-half', prompt: '$･autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-arabic', prompt: '$٪autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-division', prompt: '$∕autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-but-directive', prompt: 'use $autopilot is documented but use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'list-directive-fw-colon', prompt: '- use $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-arabic-question', prompt: 'use $ralplan is the workflow command؟ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'arabic-semicolon-negation', prompt: '$ralplan؛ $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'confusable-postposed-transition', prompt: '$ralplan is prohibited but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-negation', prompt: 'Autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'both-mixed-negation', prompt: 'Both autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-documentation', prompt: 'use $ralplan and autopilot mode are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'prose-doc-no-reopen', prompt: '$ralplan is prohibited because docs use $autopilot.', expectedSkill: null, expectedStopBlock: false },
  { name: 'neg-fw-dot-reopen', prompt: 'Do not run $ralplan． use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-greek-q-reopen', prompt: 'Do not run $ralplan; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'unicode-attached-contrast', prompt: 'Do not use deep interview яbut use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'prefix-list-followup', prompt: 'Do not run $ralplan, $autopilot; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'mixed-postposed-chain', prompt: '$ralplan, autopilot mode, $team are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-first-doc-chain', prompt: 'Autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'both-mixed-doc-followup', prompt: 'Both autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'doc-semicolon-preserves-earlier', prompt: 'Use autopilot mode; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-independent-comma', prompt: 'Use autopilot mode, and $ralplan is documented in the guide.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'reference-unclosed-quote-destination', prompt: '[docs]: "target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-unclosed-inline-destination', prompt: '[docs]: `target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-prefix-negation-implicit', prompt: 'Do not run $ralplan and use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'repeated-postposed-followup', prompt: '$team is prohibited and is forbidden; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-preserves-earlier', prompt: 'Use autopilot mode; "note"; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-colon-followup', prompt: 'use $ralplan is the workflow command: use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'table-followup', prompt: 'Mode | Meaning\n--- | ---\nmanual | documentation\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'neg-advance-reopen', prompt: 'Do not run $ralplan but advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'neg-jump-reopen', prompt: 'Do not run $ralplan but jump straight to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'reference-plain-title', prompt: '[docs]: /target "title\nplain text"\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'reference-plain-destination', prompt: '[docs]: ./target\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-use-the', prompt: 'Do not run $ralplan; use the $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-continue-after-quote', prompt: '"quoted"\ncontinue with $ralplan', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-advance-followup', prompt: 'use $ralplan is the workflow command; advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'directive-run-code-review', prompt: 'run $code-review', expectedSkill: 'code-review', expectedStopBlock: false },
  { name: 'directive-documentation', prompt: 'use $ralplan is the consensus-planning command', expectedSkill: null, expectedStopBlock: false },
  { name: 'nested-bounded-child-unbounded-parent', prompt: '"`x`\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'first-contiguous-block-terminal', prompt: '$ralplan plan it\n"x"\n$autopilot build it', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'leading-reserved-dominance', prompt: '/prompts:architect\n"x"\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fence-root-opener', prompt: '- ```\n  sample\n```\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fence-relative-closer', prompt: '- ```\n  sample\n    ```\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'reference-multiline-title-explicit', prompt: '[docs]: /target "title\nuse /prompts:architect\n$ralplan plan it"', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-multiline-title-implicit', prompt: '[docs]: /target "title\nuse autopilot mode"', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-next-line-title', prompt: '[docs]: ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-next-line-destination-title', prompt: '[docs]:\n  ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'kelvin-case-fold-suffix', prompt: '$ultraworK execute', expectedSkill: null, expectedStopBlock: false },
  { name: 'katakana-middle-dot-suffix', prompt: '$ralplan・suffix plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'halfwidth-middle-dot-suffix', prompt: '$ralplan･suffix plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'arabic-percent-suffix', prompt: '$ralplan٪docs', expectedSkill: null, expectedStopBlock: false },
  { name: 'division-slash-suffix', prompt: '$ralplan∕config', expectedSkill: null, expectedStopBlock: false },
  { name: 'unclosed-prompts-quote', prompt: '"Use /prompts:architect\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prompts-suffix', prompt: '/prompts:architect한글\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
] as const;

export function buildPackedRegressionEnvironment(
  testCase: { readonly name: string; readonly insideTmux?: boolean },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const insideTmux = testCase.insideTmux === true;
  return {
    ...baseEnv,
    OMX_ROOT: '',
    OMX_STATE_ROOT: '',
    OMX_TEAM_STATE_ROOT: '',
    OMX_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    SESSION_ID: '',
    OMX_TEAM_WORKER: '',
    OMX_TEAM_INTERNAL_WORKER: '',
    OMX_TEAM_LEADER_CWD: '',
    OMX_TEAM_MODE: insideTmux ? 'enabled' : '',
    OMX_QUESTION_RETURN_PANE: '',
    OMX_LEADER_PANE_ID: '',
    OMX_TMUX_HUD_OWNER: '',
    TMUX: insideTmux ? '/tmp/tmux-pr3140-regression' : '',
    TMUX_PANE: insideTmux ? '%3140' : '',
  };
}

function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'Release smoke stays intentionally minimal: install + boot + 1-2 core commands only.',
  ].join('\n');
}

interface EnsureRepoDepsOptions {
  gitRunner?: typeof spawnSync;
  install?: (cwd: string) => void;
  log?: (message: string) => void;
}

interface EnsureRepoDepsResult {
  strategy: string;
  nodeModulesPath: string;
  sourceNodeModulesPath?: string;
}

function formatCommandFailure(cmd: string, args: string[], result: { stdout?: string; stderr?: string }): string {
  return [
    `Command failed: ${cmd} ${args.join(' ')}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function ensureRepoDependencies(repoRoot: string, options: EnsureRepoDepsOptions = {}): EnsureRepoDepsResult {
  const {
    gitRunner = spawnSync,
    install = (cwd: string) => {
      const result = spawnSync('npm', ['ci'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure('npm', ['ci'], result));
      }
    },
    log = () => {},
  } = options;

  const reusable = ensureReusableNodeModules(repoRoot, { gitRunner });
  if (reusable.strategy === 'existing') {
    return reusable;
  }
  if (reusable.strategy === 'symlink') {
    log(`[smoke:packed-install] Reusing node_modules from ${reusable.sourceNodeModulesPath}`);
    return reusable;
  }

  log('[smoke:packed-install] Installing repo dependencies with npm ci');
  install(repoRoot);
  return {
    strategy: 'installed',
    nodeModulesPath: join(repoRoot, 'node_modules'),
  };
}

function parseArgs(argv: string[]): void {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
}

function run(cmd: string, args: readonly string[], options: Record<string, unknown> = {}): ReturnType<typeof spawnSync> {
  const result = spawnSync(cmd, [...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(cmd, [...args], result));
  }
  return result;
}

function npmBinName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function resolveGlobalNodeModules(prefixDir: string): string {
  const result = run('npm', ['root', '-g', '--prefix', prefixDir], { cwd: prefixDir });
  const root = String(result.stdout || '').trim();
  if (!root) throw new Error('npm root -g did not return a node_modules directory');
  return root;
}

export function validateHookStdout(eventName: string, stdout: string): void {
  const trimmed = stdout.trim();
  if (!trimmed) return;
  try {
    JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `native hook ${eventName} emitted invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildNativeHookSmokePayload(
  eventName: typeof PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS[number],
  smokeCwd: string,
): Record<string, unknown> {
  const base = {
    hook_event_name: eventName,
    session_id: `packed-install-smoke-${eventName}`,
    cwd: smokeCwd,
  };
  switch (eventName) {
    case 'SessionStart':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
      };
    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
      };
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
        tool_response: {
          exit_code: 0,
          stdout: 'packed install smoke\n',
          stderr: '',
        },
      };
    case 'UserPromptSubmit':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
        prompt: 'packed install native hook smoke test',
      };
    case 'PreCompact':
    case 'PostCompact':
    case 'Stop':
      return base;
  }
}

function smokeInstalledNativeHookDist(prefixDir: string): void {
  const globalNodeModules = resolveGlobalNodeModules(prefixDir);
  const packageRoot = join(globalNodeModules, 'oh-my-codex');
  const hookScript = join(packageRoot, 'dist', 'scripts', 'codex-native-hook.js');
  const smokeCwd = mkdtempSync(join(tmpdir(), 'omx-packed-hook-smoke-'));
  try {
    for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
      const payload = buildNativeHookSmokePayload(eventName, smokeCwd);
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: {
          ...process.env,
          OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
          OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root'),
          OMX_SESSION_ID: `packed-install-smoke-${eventName}`,
          OMX_SOURCE_CWD: smokeCwd,
          OMX_STARTUP_CWD: smokeCwd,
        },
        input: JSON.stringify(payload),
      });
      validateHookStdout(eventName, result.stdout as string);
    }

    for (const testCase of PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS) {
      const caseCwd = join(smokeCwd, testCase.name);
      const sessionId = `packed-install-regression-${testCase.name}`;
      mkdirSync(caseCwd, { recursive: true });
      const environment = buildPackedRegressionEnvironment(testCase);
      const promptPayload = {
        hook_event_name: 'UserPromptSubmit',
        cwd: caseCwd,
        source: 'codex-app',
        session_id: sessionId,
        thread_id: `thread-${testCase.name}`,
        turn_id: `turn-${testCase.name}`,
        prompt: testCase.prompt,
      };
      const promptResult = run(process.execPath, [realpathSync(hookScript)], {
        cwd: caseCwd,
        env: environment,
        input: JSON.stringify(promptPayload),
      });
      validateHookStdout('UserPromptSubmit', promptResult.stdout as string);
      const skillStatePath = join(caseCwd, '.omx', 'state', 'sessions', sessionId, 'skill-active-state.json');
      if (testCase.expectedSkill === null) {
        if (existsSync(skillStatePath)) throw new Error(`packed regression ${testCase.name} created workflow state`);
      } else {
        if (!existsSync(skillStatePath)) throw new Error(`packed regression ${testCase.name} did not create workflow state`);
        const skillState = JSON.parse(readFileSync(skillStatePath, 'utf-8')) as { active?: boolean; skill?: string; deferred_skills?: string[] };
        if (!skillState.active || skillState.skill !== testCase.expectedSkill) {
          throw new Error(`packed regression ${testCase.name} persisted unexpected workflow state`);
        }
        if ('expectedDeferredSkills' in testCase && JSON.stringify(skillState.deferred_skills ?? []) !== JSON.stringify(testCase.expectedDeferredSkills)) {
          throw new Error(`packed regression ${testCase.name} persisted unexpected deferred workflows`);
        }
      }

      const stopResult = run(process.execPath, [realpathSync(hookScript)], {
        cwd: caseCwd,
        env: environment,
        input: JSON.stringify({ ...promptPayload, hook_event_name: 'Stop', turn_id: `stop-${testCase.name}` }),
      });
      const stopOutput = JSON.parse(String(stopResult.stdout || '{}')) as { decision?: string };
      if (testCase.expectedStopBlock && stopOutput.decision !== 'block') {
        throw new Error(`packed regression ${testCase.name} did not block Stop`);
      }
      if (!testCase.expectedStopBlock && stopOutput.decision === 'block') {
        throw new Error(`packed regression ${testCase.name} blocked Stop: ${JSON.stringify(stopOutput)}`);
      }
    }
  } finally {
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

export function parseNpmPackJsonOutput(stdout: string): Array<{ filename: string }> {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) {
    throw new Error(`npm pack did not return JSON output: ${stdout.trim()}`);
  }
  return JSON.parse(jsonText) as Array<{ filename: string }>;
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  mkdirSync(prefixDir, { recursive: true });

  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = parseNpmPackJsonOutput(pack.stdout as string);
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    for (const argv of PACKED_INSTALL_SMOKE_CORE_COMMANDS) {
      run(omxPath, argv, { cwd: repoRoot });
    }
    smokeInstalledNativeHookDist(prefixDir);

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

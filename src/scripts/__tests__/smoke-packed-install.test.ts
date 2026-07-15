// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ensureRepoDependencies,
  hasUsableNodeModules,
  buildPackedRegressionEnvironment,
  buildNativeHookSmokePayload,
  PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS,
  PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS,
  PACKED_INSTALL_SMOKE_CORE_COMMANDS,
  parseNpmPackJsonOutput,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
  validateHookStdout,
} from '../smoke-packed-install.js';

test('packed install smoke stays limited to boot + core commands', () => {
  assert.deepEqual(PACKED_INSTALL_SMOKE_CORE_COMMANDS, [
    ['--help'],
    ['version'],
    ['api', '--help'],
    ['sparkshell', '--help'],
  ]);
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('api')),
    true,
  );
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('sparkshell')),
    true,
  );
});

test('packed install smoke covers every installed native hook event with minimal payloads', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS, [
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'PreCompact',
    'PostCompact',
    'Stop',
  ]);

  for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
    const payload = buildNativeHookSmokePayload(eventName, '/tmp/omx-packed-hook-smoke');
    assert.equal(payload.hook_event_name, eventName);
    assert.equal(typeof payload.session_id, 'string');
    assert.equal(payload.cwd, '/tmp/omx-packed-hook-smoke');
  }
});

test('packed install smoke covers directive activation and terminal false-activation regressions', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS, [
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
  ]);
});

test('packed regression environment clears inherited Team routing state', () => {
  const environment = buildPackedRegressionEnvironment(
    { name: 'poisoned-team-case', insideTmux: true },
    {
      OMX_ROOT: '/tmp/poison-root',
      OMX_STATE_ROOT: '/tmp/poison-state',
      OMX_TEAM_STATE_ROOT: '/tmp/poison-team-state',
      OMX_SESSION_ID: 'poison-session',
      CODEX_SESSION_ID: 'poison-codex-session',
      SESSION_ID: 'poison-generic-session',
      OMX_TEAM_WORKER: 'poison/worker-1',
      OMX_TEAM_INTERNAL_WORKER: 'poison/worker-2',
      OMX_TEAM_LEADER_CWD: '/tmp/poison-leader',
      OMX_TEAM_MODE: 'disabled',
      OMX_QUESTION_RETURN_PANE: '%1',
      OMX_LEADER_PANE_ID: '%2',
      OMX_TMUX_HUD_OWNER: '1',
      TMUX: '/tmp/poison-tmux',
      TMUX_PANE: '%9',
    },
  );

  assert.equal(environment.OMX_ROOT, '');
  assert.equal(environment.OMX_STATE_ROOT, '');
  assert.equal(environment.OMX_TEAM_STATE_ROOT, '');
  assert.equal(environment.OMX_TEAM_WORKER, '');
  assert.equal(environment.OMX_TEAM_INTERNAL_WORKER, '');
  assert.equal(environment.OMX_TEAM_LEADER_CWD, '');
  assert.equal(environment.OMX_TEAM_MODE, 'enabled');
  assert.equal(environment.TMUX, '/tmp/tmux-pr3140-regression');
  assert.equal(environment.TMUX_PANE, '%3140');
});

test('packed install native hook stdout validation allows empty or JSON output only', () => {
  assert.doesNotThrow(() => validateHookStdout('PostCompact', ''));
  assert.doesNotThrow(() => validateHookStdout('Stop', '{}\n'));
  assert.throws(
    () => validateHookStdout('UserPromptSubmit', '{not json'),
    /native hook UserPromptSubmit emitted invalid JSON stdout/,
  );
});

test('parseNpmPackJsonOutput ignores prepack logs before npm pack JSON', () => {
  const parsed = parseNpmPackJsonOutput([
    '[sync-plugin-mirror] synced 29 canonical skill directories and plugin metadata',
    '[',
    '  {',
    '    "filename": "oh-my-codex-0.15.0.tgz"',
    '  }',
    ']',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [{ filename: 'oh-my-codex-0.15.0.tgz' }]);
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }) as ReturnType<typeof import('node:child_process').spawnSync>);
  assert.equal(commonDir, '/tmp/primary/.git');
});

test('hasUsableNodeModules requires the packaged build dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-node-modules-'));
  try {
    const nodeModules = join(root, 'node_modules');
    await mkdir(join(nodeModules, 'typescript'), { recursive: true });
    await mkdir(join(nodeModules, '@iarna', 'toml'), { recursive: true });
    await mkdir(join(nodeModules, '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(nodeModules, 'zod'), { recursive: true });
    await writeFile(join(nodeModules, 'typescript', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(nodeModules, 'zod', 'package.json'), '{}');

    assert.equal(hasUsableNodeModules(root), true);

    await rm(join(nodeModules, 'zod', 'package.json'));
    assert.equal(hasUsableNodeModules(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveReusableNodeModulesSource reuses primary worktree node_modules when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-reuse-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const reusable = resolveReusableNodeModulesSource(worktreeRepo, () => ({
      status: 0,
      stdout: `${join(primaryRepo, '.git')}\n`,
      stderr: '',
    }) as ReturnType<typeof import('node:child_process').spawnSync>);

    assert.equal(reusable, join(primaryRepo, 'node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies symlinks a reusable primary worktree node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-symlink-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const events: string[] = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message: string) => events.push(message),
    });

    assert.equal(result.strategy, 'symlink');
    assert.equal(result.sourceNodeModulesPath, join(primaryRepo, 'node_modules'));
    assert.equal(events[0], `[smoke:packed-install] Reusing node_modules from ${join(primaryRepo, 'node_modules')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies falls back to npm ci when no reusable node_modules source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-install-node-modules-'));
  try {
    const installs: string[] = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: (cwd: string) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

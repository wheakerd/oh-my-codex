import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHudLayoutHookSlot,
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudWatchCommand,
  createHudWatchPane,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE,
  parseTmuxPaneSnapshot,
  readActiveTmuxPaneId,
  readHudPaneOwner,
  reapDeadHudPanes,
  parseHudResizeHookContext,
  registerHudResizeHook,
  unregisterHudResizeHook,
  killExactHudPane,

} from '../tmux.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS } from '../constants.js';


describe('HUD pane creation', () => {
  it('preserves a newly split pane when instance-tag readback fails without exact teardown proof', () => {

    const calls: string[][] = [];
    const result = createHudWatchPane('/repo', 'node omx.js hud --watch', { instanceId: 'session-a' }, (args) => {
      calls.push(args);
      if (args[0] === 'split-window') return '%new\n';
      if (args[0] === 'show-option') return 'wrong-session\n';
      return '';
    });

    assert.equal(result, null);
    assert.equal(calls.filter((args) => args[0] === 'kill-pane').length, 0);
    assert.ok(calls.some((args) => args[0] === 'show-option' && args.at(-1) === '@omx_pane_instance_id'));
  });
});

describe('exact HUD pane destruction', () => {
  it('uses one tmux server-side conditional mutation for the complete HUD identity', () => {
    const calls: string[][] = [];
    const startCommand = `exec env OMX_SESSION_ID='session-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node /repo/omx.js hud --watch`;
    assert.equal(killExactHudPane({
      paneId: '%2',
      currentCommand: 'node',
      startCommand,
      owner: { sessionId: 'session-a', leaderPaneId: '%1' },
      paneInstanceId: 'pane-birth',
      sessionInstanceId: 'session-birth',
      sessionName: 'managed',
    }, (args) => { calls.push(args); return '__omx_hud_pane_kill_applied__\n'; }), true);
    assert.deepEqual(calls, [[
      'if-shell', '-t', '%2', '-F',
      `#{&&:#{==:#{pane_id},%2},#{==:#{pane_current_command},node},#{==:#{pane_start_command},${startCommand}},#{==:#{@omx_pane_instance_id},pane-birth},#{==:#{@omx_instance_id},session-birth},#{==:#{session_name},managed}}`,
      'kill-pane -t %2 \\; display-message -p __omx_hud_pane_kill_applied__', 'display-message -p __omx_hud_pane_kill_rejected__',
    ]]);
  });

  it('escapes every tmux format delimiter in dynamic identity operands', () => {
    const calls: string[][] = [];
    const startCommand = `exec env OMX_SESSION_ID='session-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node /repo/omx.js hud --watch`;
    assert.equal(killExactHudPane({
      paneId: '%2',
      currentCommand: 'node#{},:',
      startCommand,
      owner: { sessionId: 'session-a', leaderPaneId: '%1' },
      paneInstanceId: 'pane#{},:birth',
      sessionInstanceId: 'session#{},:birth',
      sessionName: 'managed#{},:',
    }, (args) => { calls.push(args); return '__omx_hud_pane_kill_applied__\n'; }), true);
    const condition = calls[0]?.[4] ?? '';
    assert.match(condition, /node###\{#\}#,#:/);
    assert.match(condition, /pane###\{#\}#,#:birth/);
    assert.match(condition, /session###\{#\}#,#:birth/);
    assert.match(condition, /managed###\{#\}#,#:/);
  });

  it('rejects a reused pane before issuing the conditional mutation when its captured owner no longer matches', () => {
    const calls: string[][] = [];
    assert.equal(killExactHudPane({
      paneId: '%2',
      currentCommand: 'bash',
      startCommand: 'bash',
      owner: { sessionId: 'session-a', leaderPaneId: '%1' },
      paneInstanceId: 'replacement-pane',
      sessionInstanceId: 'replacement-session',
      sessionName: 'managed',
    }, (args) => { calls.push(args); return ''; }), false);
    assert.deepEqual(calls, []);
  });

  it('reports a server-side false branch as no destruction', () => {
    const startCommand = `exec env OMX_SESSION_ID='session-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node /repo/omx.js hud --watch`;
    assert.equal(killExactHudPane({
      paneId: '%2',
      currentCommand: 'node',
      startCommand,
      owner: { sessionId: 'session-a', leaderPaneId: '%1' },
      paneInstanceId: 'pane-birth',
      sessionInstanceId: 'session-birth',
      sessionName: 'managed',
    }, () => '__omx_hud_pane_kill_rejected__\n'), false);
  });
});
describe('HUD resize hook helpers', () => {
  it('builds a deterministic hook name from the tmux session, window, and leader identity', () => {
    assert.equal(buildHudResizeHookName('$7', '@3', '%1'), 'omx_hud_resize_7_3_1');
  });

  it('builds a bounded numeric client-resized slot', () => {
    const slot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    assert.match(slot, /^client-resized\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^client-resized\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('builds a bounded numeric window-layout-changed slot', () => {
    const slot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    assert.match(slot, /^window-layout-changed\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^window-layout-changed\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('parses hook context from tmux display-message output', () => {
    const context = parseHudResizeHookContext('$7\t@3\n', '%1');

    assert.deepEqual(context, {
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      hookName: 'omx_hud_resize_7_3_1',
      hookSlot: buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
      layoutHookSlot: buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    });
  });

  it('rejects malformed tmux ids in hook context output', () => {
    assert.equal(parseHudResizeHookContext('$7; touch /tmp/owned\t@3\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3$(touch /tmp/owned)\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3\n', '%1; touch /tmp/owned'), null);
  });

  function appendOnlyHooks() {
    const hooks = new Map<string, string[]>();
    const options = new Map<string, string>();

    const calls: string[][] = [];
    const exec = (args: string[]): string => {
      calls.push(args);
      if (args[0] === 'display-message' && args.at(-1) === '#{session_id}\t#{window_id}') return '$7\t@3\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{@omx_pane_instance_id}\t#{@omx_instance_id}\t#{session_name}') return 'pane-birth\tsession-birth\tmanaged\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{@omx_pane_instance_id}\t#{@omx_instance_id}\t#{session_name}\t#{window_id}\t#{pane_current_command}\t#{pane_start_command}') return 'pane-birth\tsession-birth\tmanaged\t@3\tnode\texec env OMX_SESSION_ID=sess OMX_TMUX_HUD_LEADER_PANE=%1 node omx hud --watch\n';

      if (args[0] === 'display-message' && args.at(-1) === '#{@omx_pane_instance_id}') return 'leader-birth\n';

      if (args[0] === 'set-option') {
        options.set(args.at(-2) ?? '', args.at(-1) ?? '');
        return '';
      }
      if (args[0] === 'show-option') return options.get(args.at(-1) ?? '') ?? '';
      if (args[0] === 'set-hook' && args[1] === '-a') {
        const event = args[4]!;
        hooks.set(event, [...(hooks.get(event) ?? []), args[5]!]);
        return '';
      }
      if (args[0] === 'if-shell' && args[1] === '-t' && args[3] === '-F') {
        const expected = (args[4] ?? '').match(/#\{(@[^}]+)\},([^}]+)\}/);
        if (expected && (options.get(expected[1]!) ?? '') !== expected[2]) return '';
        for (const command of (args[5] ?? '').split(' \\; ')) {
          const parts = command.split(' ');
          if (parts[0] === 'set-option' && parts[1] === '-t' && parts[3] && parts[4]) options.set(parts[3], parts[4]);
        }
        return '';
      }
      if (args[0] === 'show-hooks') return (hooks.get(args[3]!) ?? []).map((command, index) => `${args[3]}[${index}] ${command}`).join('\n');
      return '';
    };
    return { hooks, options, calls, exec };
  }

  it('appends a self-validating paired hook generation without touching existing hooks', () => {
    const fixture = appendOnlyHooks();
    fixture.hooks.set('client-resized', ['run-shell -b foreign']);
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    assert.equal(fixture.hooks.get('client-resized')?.[0], 'run-shell -b foreign');
    assert.equal(fixture.hooks.get('client-resized')?.length, 2);
    assert.equal(fixture.hooks.get('window-layout-changed')?.length, 1);
    const command = fixture.hooks.get('client-resized')?.[1] ?? '';
    assert.match(command, /if-shell -t %9 -F/);
    assert.match(command, /pane-birth/);
    assert.match(command, /session-birth/);
    assert.match(command, /pane_start_command/);
    assert.match(command, /window_id/);
    assert.ok((command.match(/if-shell/g) ?? []).length >= 2);
    assert.match(command, /omx-hud-owned:[0-9a-f-]{36}/);
    assert.ok(fixture.calls.some((args) => args[0] === 'set-hook' && args[1] === '-a'));
    assert.equal(fixture.calls.some((args) => args[0] === 'set-hook' && args.includes('-u')), false);
  });

  it('reuses a verified published generation across unchanged reconciliation', () => {
    const fixture = appendOnlyHooks();
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    assert.equal(fixture.hooks.get('client-resized')?.length, 1);
    assert.equal(fixture.hooks.get('window-layout-changed')?.length, 1);
    assert.equal([...fixture.options.entries()].filter(([name, value]) => name.startsWith('@omx_hud_hook_active_') && value === '1').length, 1);
  });

  it('keeps a partial standalone pair inert when the second append fails', () => {
    const fixture = appendOnlyHooks();
    const exec = (args: string[]) => {
      if (args[0] === 'set-hook' && args[4] === 'window-layout-changed') throw new Error('append failed');
      return fixture.exec(args);
    };
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, exec), false);
    assert.equal(fixture.hooks.get('client-resized')?.length, 1);
    assert.equal(fixture.hooks.get('window-layout-changed')?.length ?? 0, 0);
    assert.equal([...fixture.options.entries()].some(([name, value]) => name.startsWith('@omx_hud_hook_active_') && value === '1'), false);
  });

  it('retains the complete append-only pair and CAS-deactivates its persisted generation on teardown', () => {
    const fixture = appendOnlyHooks();
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    assert.equal(unregisterHudResizeHook('%1', fixture.exec), true);
    const inactive = fixture.calls.filter((args) => args[0] === 'set-option' && args.at(-1) === '0');
    assert.equal(inactive.length, 1);
    assert.equal(fixture.calls.some((args) => args[0] === 'show-hooks'), true);
    assert.equal(fixture.calls.some((args) => args[0] === 'set-hook' && args.includes('-u')), false);
    assert.equal(fixture.hooks.get('client-resized')?.length, 1);
    assert.equal(fixture.hooks.get('window-layout-changed')?.length, 1);
  });

  it('does not deactivate a successor published after teardown read its predecessor', () => {
    const fixture = appendOnlyHooks();
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    const exec = (args: string[]) => {
      if (args[0] === 'if-shell') {
        fixture.options.set('@omx_hud_hook_generation_1_leader_birth', '44444444-4444-4444-8444-444444444444');
        return '';
      }
      return fixture.exec(args);
    };
    assert.equal(unregisterHudResizeHook('%1', exec), false);
    assert.equal(fixture.options.get('@omx_hud_hook_active_44444444_4444_4444_8444_444444444444'), undefined);
  });

  it('does not require or mutate a derived hook slot during foreign replacement races', () => {
    const fixture = appendOnlyHooks();
    fixture.hooks.set('window-layout-changed', ['run-shell -b foreign replacement']);
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux' } }, fixture.exec), true);
    assert.equal(fixture.hooks.get('window-layout-changed')?.[0], 'run-shell -b foreign replacement');
    assert.equal(fixture.calls.some((args) => args[0] === 'if-shell'), true);
  });
});

describe('HUD pane ownership helpers', () => {
  it('parses pane geometry from tmux pane snapshots without corrupting the start command or cwd', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%2\tnode\t0\t47\t160\t3\t49\t160\t50\tpane-a\tsession-a\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch\t/tmp/repo`,
    );

    assert.deepEqual(pane, {
      paneId: '%2',
      currentCommand: 'node',
      paneLeft: 0,
      paneTop: 47,
      paneWidth: 160,
      paneHeight: 3,
      paneBottom: 49,
      windowWidth: 160,
      windowHeight: 50,
      paneInstanceId: 'pane-a',
      sessionInstanceId: 'session-a',
      startCommand: `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
      currentPath: '/tmp/repo',
    });
  });

  it('reads session and leader ownership from env-prefixed HUD commands', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-a', leaderPaneId: '%1' }), true);
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-b', leaderPaneId: '%2' }), false);
  });

  it('reads ownership from quoted tmux shell env arguments used by inside-tmux launch', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\t/bin/zsh -c 'exec '\\''env'\\'' '\\''OMX_SESSION_ID=sess-a'\\'' '\\''${OMX_TMUX_HUD_LEADER_PANE_ENV}=%1'\\'' '\\''node'\\'' '\\''/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'''`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
  });

  it('splits tmux octal-escaped control separators from live list-panes output', () => {
    const escapedSeparator = TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE;
    const panes = parseTmuxPaneSnapshot(
      [
        ['%140', 'node', '', '/home/tools/oh-my-codex'].join(escapedSeparator),
        [
          '%202',
          'node',
          `"exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%140' OMX_ROOT='/tmp/run' '/usr/bin/node' '/repo/dist/cli/omx.js' hud --watch --preset=focused"`,
          '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
        ].join(escapedSeparator),
      ].join('\n'),
    );

    assert.equal(panes.length, 2);
    assert.equal(panes[0]?.paneId, '%140');
    assert.equal(panes[0]?.currentCommand, 'node');
    assert.equal(panes[0]?.startCommand, '');
    assert.equal(panes[0]?.currentPath, '/home/tools/oh-my-codex');
    assert.equal(panes[1]?.paneId, '%202');
    assert.equal(panes[1]?.currentCommand, 'node');
    assert.equal(
      panes[1]?.currentPath,
      '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
    );
    assert.deepEqual(readHudPaneOwner(panes[1]!), {
      sessionId: 'sess-a',
      leaderPaneId: '%140',
    });
    assert.deepEqual(
      findHudWatchPaneIds(panes, '%140', { sessionId: 'sess-a', leaderPaneId: '%140' }),
      ['%202'],
    );
  });

  it('preserves tab-containing start commands when reading the optional cwd column', () => {
    const [pane] = parseTmuxPaneSnapshot('%9\tnode\tnode\t/omx.js hud --watch\t/tmp/repo');

    assert.equal(pane?.startCommand, 'node\t/omx.js hud --watch');
    assert.equal(pane?.currentPath, '/tmp/repo');
  });

  it('keeps independent leaders in one tmux window from matching each other HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-b', leaderPaneId: '%3' }), ['%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
  });

  it('requires both session and leader identity when both owner fields are requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
        "%4\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        `%5\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%3' }), ['%3']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%5']);
  });

  it('does not match session-owned HUD panes when only leader ownership is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%3']);
  });

  it('does not match leader-only legacy HUD panes when a session owner is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-canonical', leaderPaneId: '%1' }), []);
  });

  it('does not owner-match a different live leader just because the session id matches', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('does not owner-match untagged HUD panes when an owner scope is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1'), ['%2']);
  });

  it('separately detects legacy focused watch panes for automatic reconciliation only', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch --preset=focused',
        '%3\tnode\tnode /tmp/bin/omx.js hud --watch --preset=minimal',
        `%4\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch --preset=focused`,
        '%5\tnode\tnode /tmp/bin/omx.js hud --tmux --preset=focused',
        `%6\tnode\t/bin/zsh -c 'exec '\\''node'\\'' '\\''/tmp/bin/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'' '\\''--preset=focused'\\'''`,
        '%7\tnode\tnode /tmp/bin/custom-hud.js hud --watch --preset=focused',
        '%8\tnode\tnode /tmp/omx-pr2664/custom-hud.js hud --watch --preset=focused',
        '%9\tnode\tnode /tmp/bin/omx.js hud --tmux --watch --preset=focused',
      ].join('\n'),
    );

    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), ['%2', '%6']);
  });

  it('preserves session-owned legacy HUD panes without leader tags when both owner fields are requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        "%2\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        "%3\tnode\texec env OMX_SESSION_ID='sess-b' /node /omx.js hud --watch",
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('matches equivalent owner and canonical session ids for the same leader', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='omx-owner-abc' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%4\tnode\texec env OMX_SESSION_ID='other-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%5\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%5' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(
      findHudWatchPaneIds(panes, '%1', {
        sessionId: 'omx-owner-abc',
        sessionIds: ['omx-owner-abc', 'codex-native-uuid'],
        leaderPaneId: '%1',
      }),
      ['%2', '%3'],
    );
  });

  it('finds one same-session HUD pane when TMUX_PANE is unavailable', () => {
    const calls: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      return [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n');
    };

    assert.deepEqual(listCurrentWindowHudPaneIds(undefined, execTmuxSync, { sessionId: 'sess-a' }), ['%2']);
    assert.deepEqual(calls, [
      [
        'list-panes',
        '-F',
        [
          '#{pane_id}',
          '#{pane_current_command}',
          '#{pane_left}',
          '#{pane_top}',
          '#{pane_width}',
          '#{pane_height}',
          '#{pane_bottom}',
          '#{window_width}',
          '#{window_height}',
          '#{@omx_pane_instance_id}',
          '#{@omx_instance_id}',
          '#{session_name}',
          '#{pane_start_command}',
          '#{pane_current_path}',
        ].join('\x1f'),
      ],
    ]);
  });

  it('keeps active-pane fallback isolated from a different same-session leader HUD', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('resolves the active tmux pane as a TMUX_PANE fallback', () => {
    const calls: string[][] = [];
    const paneId = readActiveTmuxPaneId((args) => {
      calls.push(args);
      return '%7\n';
    });

    assert.equal(paneId, '%7');
    assert.deepEqual(calls, [['display-message', '-p', '#{pane_id}']]);
  });

  it('tags reconciled HUD watch commands with the leader pane owner', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, 'sess-a', undefined, '%1');

    assert.match(cmd, /OMX_SESSION_ID='sess-a'/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });

  it('tags reconciled HUD watch commands as OMX-owned even without a session id', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, '', undefined, '%1');

    assert.doesNotMatch(cmd, /OMX_SESSION_ID=/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });
});

describe('dead HUD pane reaper', () => {
  it('ignores team ACK commands that mention HUD preserve repro text', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        [
          '%2',
          'node',
          "node /repo/dist/cli/omx.js team api send-message --input '{\"body\":\"ACK: hud preserve repro just ack\"}' --json",
        ].join('\t'),
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('team ACK command should not be classified as a HUD watch pane');
      },
    });

    assert.deepEqual(findHudWatchPaneIds(panes), []);
    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

  it('preserves a stale HUD when the snapshot lacks immutable pane identity', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killExactPane: (candidate) => {
        killed.push(candidate.paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('passes only a complete immutable candidate to the reaper callback', () => {
    const startCommand = `exec env OMX_SESSION_ID='doctor-smoke' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' node /repo/omx.js hud --watch`;
    const candidates: unknown[] = [];
    const result = reapDeadHudPanes([{
      paneId: '%2',
      currentCommand: 'node',
      startCommand,
      paneInstanceId: 'pane-birth',
      sessionInstanceId: 'session-birth',
      sessionName: 'managed',
      currentPath: '/missing (deleted)',
    }], {
      killExactPane: (candidate) => {
        candidates.push(candidate);
        return false;
      },
    });
    assert.equal(candidates.length, 1);
    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves HUD panes whose leader pane is alive', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('live leader HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves legacy HUD panes with no leader tag by default', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('legacy untagged HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves deleted-cwd HUD panes without immutable identity', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-native-hook-dist-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' /tmp/bin/omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killExactPane: (candidate) => {
        killed.push(candidate.paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves doctor-smoke HUD panes without immutable identity', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-plugin-hook-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='doctor-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killExactPane: (candidate) => {
        killed.push(candidate.paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves doctor-smoke panes with a materialized marker unless identity is complete', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-doctor-plugin-hook-live-marker-'));
    const materializedDeletedPath = join(parent, 'smoke (deleted)');
    mkdirSync(materializedDeletedPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='omx-doctor-plugin-hook-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${materializedDeletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    try {
      const result = reapDeadHudPanes(panes, {
        killExactPane: (candidate) => {
          killed.push(candidate.paneId);
          return true;
        },
      });

      assert.deepEqual(killed, []);
      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves non-doctor deleted-cwd HUD panes while their leader is still live', () => {
    const deletedPath = join(tmpdir(), `omx-live-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('live leader HUD with stale launch cwd should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves stale-owner HUD panes unless immutable identity is complete', () => {
    const deletedPath = join(tmpdir(), `omx-dead-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-stale' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killExactPane: (candidate) => {
        killed.push(candidate.paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves HUD panes in an existing cwd whose name ends with the deleted marker text', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'live (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${liveDeletedSuffixPath}`,
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killExactPane: () => {
          throw new Error('live cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves live deleted-marker cwd paths containing tabs from the tmux list separator', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-tab-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'left\tlive (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const separator = '\x1f';
    const panes = parseTmuxPaneSnapshot(
      [
        ['%1', 'codex', 'codex', '/repo'].join(separator),
        [
          '%2',
          'node',
          `exec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          liveDeletedSuffixPath,
        ].join(separator),
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killExactPane: () => {
          throw new Error('live tab cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves deleted-cwd panes with misleading HUD text but no OMX owner metadata', () => {
    const deletedPath = join(tmpdir(), `omx-misleading-hud-text-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\tSUCCESS but not an OMX pane: hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('misleading non-OMX HUD text should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('does not touch non-HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js sidecar --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killExactPane: () => {
        throw new Error('non-HUD panes should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

  it('uses an explicit live-pane predicate for reaper decisions', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      isLivePane: (paneId) => paneId === '%9',
      killExactPane: (candidate) => {
        killed.push(candidate.paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2', '%3'] });
  });
});

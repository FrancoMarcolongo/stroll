const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DATA_DIR = process.env.STROLL_HOME || path.join(HOME, '.stroll');
const CONFIG_VERSION = 1;

const paths = {
  dataDir: DATA_DIR,
  state: path.join(DATA_DIR, 'state.json'),
  config: path.join(DATA_DIR, 'config.json'),
  runsDir: path.join(DATA_DIR, 'runs'),
  hookSettings: path.join(DATA_DIR, 'hook-settings.json'),
  mcpConfig: path.join(DATA_DIR, 'mcp-config.json'),
  mcpConfigRuns: path.join(DATA_DIR, 'mcp-config-runs.json'),
  mcpServer: path.join(__dirname, '..', 'mcp', 'stroll-mcp.js'),
  appDir: path.join(__dirname, '..', '..'),
};

// Only the user's overrides live in config.json; everything else comes from here, so later
// releases can change a default and it reaches existing installs.
const DEFAULT_CONFIG = {
  claudePath: null,
  defaultCwd: HOME,
  terminal: {
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    // Off by default: on Spanish and other layouts Option types characters such as @ # [ ].
    optionIsMeta: false,
  },
  notifications: {
    enabled: true,
    sound: true,
    finishedTurns: true,
    needsYou: true,
    backgroundRuns: true,
  },
  background: {
    model: null,
    includeConnectors: false,
    extraAllowedTools: [],
    extraDisallowedTools: [],
  },
  updates: { check: true },
  // Sidebar sections, top to bottom, and which ones are collapsed.
  sidebar: { order: ['todos', 'sessions', 'runs', 'workflows', 'recent'], collapsed: ['recent'] },
};

// Background runs are unattended. They load no settings at all (`--setting-sources ""`), so
// neither the user's ~/.claude settings (auto mode, broad allow rules) nor a repo's
// .claude/settings.local.json ("don't ask again" approvals) apply. Three tiers:
//  - allowed: runs without asking. Read-only, and no Bash prefix here can write or execute
//    through a flag.
//  - disallowed: never runs, not even with approval (edits, git/gh writes, sending).
//  - everything else: Stroll asks the user (the permission prompt tool in stroll-mcp.js).
const BACKGROUND_ALLOWED = [
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite',
  'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git blame:*)',
  // Exact: as prefixes, `git branch -r -d …` would match too.
  'Bash(git branch -r)', 'Bash(git branch -a)', 'Bash(git branch --list)', 'Bash(git ls-files:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(jq:*)', 'Bash(cd:*)',
  // Not sed -n, sort, uniq or file: each can write a file (`w`, -o, a second argument, -C).
  'Bash(cut:*)', 'Bash(tr:*)', 'Bash(diff:*)', 'Bash(stat:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh run list:*)', 'Bash(gh run view:*)',
];
const BACKGROUND_DISALLOWED = [
  'Edit', 'Write', 'NotebookEdit',
  'Bash(git * --output*)', 'Bash(sed -i*)', 'Bash(* -delete*)',
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git reset:*)',
  'Bash(git rebase:*)', 'Bash(git merge:*)', 'Bash(git stash:*)', 'Bash(git tag:*)', 'Bash(git branch -D:*)', 'Bash(git branch -d:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr ready:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)', 'Bash(gh pr review:*)', 'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)',
  'Bash(gh issue close:*)', 'Bash(gh release:*)', 'Bash(rm:*)', 'Bash(mv:*)', 'Bash(curl:*)', 'Bash(wget:*)',
  'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_send_message_draft',
  'mcp__claude_ai_Slack__slack_schedule_message', 'mcp__claude_ai_Slack__slack_add_reaction',
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
];
// Read-only tools of claude.ai connectors, opt-in from Settings: connector content (emails,
// Slack threads) is the likeliest place for prompt injection, so runs don't read it by default.
// These have to be listed: Claude Code won't let a permission prompt tool approve connector tools.
const CONNECTOR_READ_TOOLS = [
  ...['read_channel', 'read_thread', 'search_public', 'search_public_and_private', 'read_canvas', 'read_user_profile',
    'search_channels', 'search_users', 'list_user_channels', 'read_file', 'read_list', 'get_reactions', 'list_channel_members']
    .map(t => `mcp__claude_ai_Slack__slack_${t}`),
  ...['search_threads', 'get_thread', 'get_message', 'list_labels'].map(t => `mcp__claude_ai_Gmail__${t}`),
  ...['search_files', 'read_file_content', 'get_file_metadata', 'list_recent_files', 'download_file_content']
    .map(t => `mcp__claude_ai_Google_Drive__${t}`),
  ...['read', 'query', 'guide', 'export'].map(t => `mcp__claude_ai_Claude_Docs__${t}`),
  ...['search_calls_by_title', 'search_calls_per_client', 'get_complete_call_by_call_id', 'get_recent_calls',
    'search_transcripts_semantic', 'search_calls_by_participant', 'count_calls', 'get_calls_by_source',
    'get_all_customers', 'aggregate_calls', 'get_distinct_values'].map(t => `mcp__claude_ai_Proper_Calls__${t}`),
];

function backgroundTools(config) {
  const bg = config.background || {};
  return {
    allowed: [...BACKGROUND_ALLOWED, ...(bg.includeConnectors ? CONNECTOR_READ_TOOLS : []), ...(bg.extraAllowedTools || [])],
    disallowed: [...BACKGROUND_DISALLOWED, ...(bg.extraDisallowedTools || [])],
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeDeep(base, override) {
  if (!isObj(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = isObj(base?.[k]) ? mergeDeep(base[k], v) : v;
  return out;
}

// state.json and mcp-config.json (which holds the local API token) are private to the user.
function writePrivate(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// The PATH Stroll was launched with (e.g. from a terminal with nvm/asdf set up) plus the
// shell's interactive login PATH, so `claude`, node, go, gh… resolve the same as in a terminal
// even when Stroll is started from Finder.
function shellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  for (const flags of [['-ilc'], ['-lc']]) {
    try {
      const out = execFileSync(shell, [...flags, 'printf "__STROLL_PATH__%s__END__" "$PATH"'], {
        encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/__STROLL_PATH__(.*?)__END__/s);
      if (m && m[1]) return m[1].trim();
    } catch (_) { /* try the next form */ }
  }
  return '';
}

function mergedPath() {
  const parts = [process.env.PATH, shellPath(), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean).join(':').split(':').filter(Boolean);
  return [...new Set(parts)].join(':');
}

function findClaude(envPath) {
  for (const dir of envPath.split(':')) {
    const candidate = path.join(dir, 'claude');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) { /* keep looking */ }
  }
  return null;
}

// Variables a running Claude Code session sets for its own children (they'd e.g. turn off
// transcript saving), and terminal-identity variables of whatever terminal launched Stroll
// (they'd change Claude Code's terminal detection depending on where `stroll` was typed).
const STRIPPED_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_EFFORT', 'CLAUDE_PID',
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'LC_TERMINAL', 'LC_TERMINAL_VERSION',
  'ITERM_SESSION_ID', 'ITERM_PROFILE', 'KITTY_WINDOW_ID', 'ALACRITTY_WINDOW_ID', 'WEZTERM_PANE',
];

function childEnv(config, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIPPED_VARS) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('VSCODE_') || k.startsWith('STROLL_')) delete env[k];
  return { ...env, PATH: config.envPath, ...extra };
}

function readOverrides() {
  if (!fs.existsSync(paths.config)) return null;
  try { return JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch (e) {
    console.error('[stroll] config.json is not valid JSON, using defaults:', e.message);
    return {};
  }
}

// Before versioning, the first run dumped every default into config.json. Keep only what the
// user could have meant to set; drop the frozen background lists.
function migrateLegacy(legacy) {
  const kept = { version: CONFIG_VERSION };
  if (legacy.defaultCwd && legacy.defaultCwd !== DEFAULT_CONFIG.defaultCwd) kept.defaultCwd = legacy.defaultCwd;
  if (legacy.claudePath) kept.claudePath = legacy.claudePath;
  const term = {};
  for (const k of ['fontFamily', 'fontSize']) if (legacy.terminal?.[k] !== undefined && legacy.terminal[k] !== DEFAULT_CONFIG.terminal[k]) term[k] = legacy.terminal[k];
  if (Object.keys(term).length) kept.terminal = term;
  return kept;
}

function loadConfig() {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dataDir, 0o700);
  fs.mkdirSync(paths.runsDir, { recursive: true, mode: 0o700 });
  let overrides = readOverrides();
  if (!overrides || !overrides.version) {
    overrides = overrides ? migrateLegacy(overrides) : { version: CONFIG_VERSION };
    writePrivate(paths.config, JSON.stringify(overrides, null, 2));
  }
  const config = mergeDeep(DEFAULT_CONFIG, overrides);
  config.envPath = mergedPath();
  config.claudePath = overrides.claudePath || findClaude(config.envPath);
  if (!config.defaultCwd || !fs.existsSync(config.defaultCwd)) config.defaultCwd = HOME;
  return config;
}

// Settings screen: merge a patch into the overrides file and return the effective config.
function saveOverrides(patch) {
  const current = readOverrides() || { version: CONFIG_VERSION };
  const next = mergeDeep(current, patch);
  next.version = CONFIG_VERSION;
  writePrivate(paths.config, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { paths, loadConfig, saveOverrides, childEnv, backgroundTools, writePrivate, mergeDeep, DEFAULT_CONFIG, HOME };

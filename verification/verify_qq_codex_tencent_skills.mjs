import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Run on the server, not in the live QQ process. No QQ credentials are read.
process.umask(0o077);
const stageIndex = process.argv.indexOf('--stage');
if (stageIndex < 0 || !path.isAbsolute(process.argv[stageIndex + 1] || '')) {
  throw new Error('Usage: node verify_qq_codex_tencent_skills.mjs --stage /absolute/staging/directory');
}
const stage = fs.realpathSync(process.argv[stageIndex + 1]);
const config = JSON.parse(fs.readFileSync('/etc/qq-codex/config.json', 'utf8'));
fs.mkdirSync(path.join(config.dataDir, 'diagnostics'), { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(config.dataDir, 'diagnostics', 'tencent-skills-'));
const workspace = path.join(directory, 'workspace'), codexHome = path.join(directory, 'codex-home');
for (const dir of [workspace, codexHome]) fs.mkdirSync(dir, { mode: 0o700 });
const names = ['qq-chat', 'qq-speech', 'tonso-blog-image2', 'qqbot-media', 'qqbot-remind'];
for (const name of names) {
  const destination = path.join(workspace, '.agents', 'skills', name);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(stage, 'skills', name, 'SKILL.md'), path.join(destination, 'SKILL.md'));
}
// Preserve the provider/profile in an isolated home; never copy auth.json.
fs.copyFileSync(path.join(config.codexHome, 'config.toml'), path.join(codexHome, 'config.toml'));
const auth = JSON.parse(fs.readFileSync(config.codexAuthFile, 'utf8'));
if (typeof auth.apiKey !== 'string' || !auth.apiKey) throw new Error('Service model authentication is unavailable');
const { QQCodexBroker } = await import(pathToFileURL('/opt/qq-codex/app/qq_codex_broker.mjs'));
const { buildQQInstructions } = await import(pathToFileURL('/opt/qq-codex/app/qq_codex_transport.mjs'));
const fixtureMarker = `QQ_SKILL_${crypto.randomBytes(10).toString('hex')}`;
const fixture = path.join(workspace, 'qq-skill-test.txt');
fs.writeFileSync(fixture, fixtureMarker + '\n', { mode: 0o600 });
const isolated = { ...config, dataDir: directory, workspace, codexHome };
let forbiddenSends = 0, active, child, fatal, stderrBytes = 0, sequence = 0;
const pending = new Map(), calls = [], traces = [], interactive = [], createdIds = new Set();
const bot = Object.fromEntries(['send', 'sendText', 'sendMarkdown', 'sendImage', 'sendFile', 'sendVoice', 'sendVideo', 'sendTyping', 'recallMessage']
  .map(name => [name, async () => { forbiddenSends++; throw new Error('QQ_DELIVERY_FORBIDDEN_IN_ISOLATED_CHECK'); }]));
const broker = new QQCodexBroker({ bot, dataDir: directory, workspace, config: {}, getStatus: () => ({ connected: false }) });
const originalCall = broker.call.bind(broker);
broker.call = async (name, args, key) => {
  const record = { scenario: active?.name, tool: name, ...(args.action ? { action: args.action } : {}), success: false };
  calls.push(record);
  if (!active || (name !== 'qq_status' && !(active.name === 'reminder' && name === 'qq_reminder' &&
      (['list', 'remove'].includes(args.action) || (args.action === 'add' && args.paused === true))))) {
    throw new Error('Only the isolated paused reminder and read-only status are authorized');
  }
  const result = await originalCall(name, args, key);
  Object.assign(record, { success: true, args: structuredClone(args), result });
  if (name === 'qq_reminder' && args.action === 'add' && result.job?.id) {
    createdIds.add(result.job.id);
    record.persisted = JSON.parse(fs.readFileSync(broker.storePath, 'utf8')).jobs.some(job => job.id === result.job.id && job.paused === true);
  }
  return result;
};
const summary = { checkedAtUTC: new Date().toISOString(), runId: path.basename(directory), modelRequested: config.model,
  liveQQContextUsed: false, qqMessagesSent: 0, generationRequested: false, scenarios: [] };
const deadlineAt = Date.now() + 180000;
const remaining = () => Math.max(1, deadlineAt - Date.now());
function failAll(error) {
  fatal ||= error;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear(); active?.reject(error);
}
function stop(signal = 'SIGTERM') { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } }
const deadline = setTimeout(() => { failAll(new Error('Isolated skill verification exceeded its 180-second deadline')); stop(); }, remaining());
const interrupted = () => { failAll(new Error('Isolated skill verification interrupted')); stop(); };
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
function request(method, params) {
  if (fatal) return Promise.reject(fatal);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, Math.min(30000, remaining()));
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
function skillRead(items, name) {
  const body = fs.readFileSync(path.join(workspace, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
  const heading = body.split('\n').find(line => /^# /.test(line));
  return Boolean(heading) && items.some(item => item.type === 'commandExecution' && item.exitCode === 0 &&
    String(item.aggregatedOutput || '').includes(heading));
}
function nativeCalls(items) {
  return items.filter(item => item.type === 'mcpToolCall').map(item => ({ server: item.server, tool: item.tool,
    ...(item.arguments?.action ? { action: item.arguments.action } : {}),
    success: item.status === 'completed' && !item.error && item.result?.isError !== true }));
}
async function turn(name, text, outputSchema) {
  const key = `tencent-skill-${name}-${crypto.randomUUID()}`;
  broker.setContext(key, { scope: 'group', targetId: 'isolated-no-qq-target', msgId: crypto.randomUUID() },
    { diagnostic: true, allowReminders: name === 'reminder', allowImages: false, allowSpeech: false });
  const thread = await request('thread/start', { model: config.model, cwd: workspace, ephemeral: true,
    approvalPolicy: 'never', sandbox: 'workspace-write',
    developerInstructions: buildQQInstructions(isolated, 'diagnostic') + '\n本轮是独立技能验收。先读取适用技能。禁止读取认证或环境秘密、发送QQ、执行网络请求、语音转换或生图；仅可读取技能与fixture，提醒场景可通过QQ MCP管理本轮paused测试提醒。不要运行CLI或另起脚本代替MCP。',
    config: { 'mcp_servers.qqbot': { command: config.node, args: ['/opt/qq-codex/app/qq_codex_mcp.mjs'],
      env: broker.mcpEnv(key), enabled: true, required: true, startup_timeout_sec: 15,
      tool_timeout_sec: 30, default_tools_approval_mode: 'approve' },
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': { PATH: `${path.dirname(config.node)}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' } } });
  if (thread.model && thread.model !== config.model) throw new Error('Native model differs from the service model');
  let resolve, reject;
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; }); completed.catch(() => {});
  active = { name, threadId: thread.thread.id, items: [], resolve, reject };
  const current = active;
  try {
    await request('turn/start', { threadId: current.threadId, cwd: workspace, approvalPolicy: 'never', effort: 'low',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false },
      input: [{ type: 'text', text }], ...(outputSchema ? { outputSchema } : {}) });
    await completed;
    const result = { name, model: thread.model || config.model, items: current.items };
    traces.push(result); return result;
  } finally { active = null; broker.clearContext(); }
}
try {
  await broker.start();
  const environment = { ...process.env, CODEX_HOME: codexHome, NEWAPI_API_KEY: auth.apiKey };
  delete environment.QQ_CODEX_CONFIG;
  child = spawn(config.node, [config.codexEntry, 'app-server', '--listen', 'stdio://'],
    { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.stdin.on('error', () => failAll(new Error('Native input channel closed')));
  child.once('error', () => failAll(new Error('Native process could not start')));
  child.once('exit', () => failAll(new Error('Native process exited')));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`RPC rejected: ${message.error.code}`)); else entry.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      interactive.push(message.method);
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable' } }) + '\n');
    } else if (active && (!message.params?.threadId || message.params.threadId === active.threadId)) {
      if (message.method === 'item/completed') active.items.push(message.params.item);
      if (message.method === 'turn/completed') {
        if (message.params.turn?.status === 'completed') active.resolve(); else active.reject(new Error('Native turn did not complete'));
      }
    }
  });
  await request('initialize', { clientInfo: { name: 'qq_tencent_skills_isolated_check', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const catalog = await request('skills/list', { cwds: [workspace], forceReload: true });
  const entry = catalog.data?.find(item => item.cwd === workspace);
  summary.discovered = names.map(name => ({ name, enabled: entry?.skills?.some(skill => skill.name === name && skill.enabled &&
    skill.path === path.join(workspace, '.agents', 'skills', name, 'SKILL.md')) === true }));
  if (!summary.discovered.every(item => item.enabled) || entry?.errors?.length) throw new Error('Staged skill discovery failed');
  const reminder = await turn('reminder', '五分钟后提醒我喝水。这里是隔离验证：请实际登记一条 paused:true 的一次性提醒，再查询它、删除它、再次查询确认清理。全程不发QQ消息；先读适用技能，按当前入口真实规则办理，最后简短说明登记和清理结果。');
  const events = calls.filter(item => item.scenario === 'reminder'), add = events.find(item => item.action === 'add');
  const id = add?.result?.job?.id, index = events.indexOf(add);
  const before = events.slice(0, index).findLast(item => item.tool === 'qq_status');
  const lists = events.slice(index + 1).filter(item => item.action === 'list');
  const removed = events.slice(index + 1).find(item => item.action === 'remove');
  const stored = JSON.parse(fs.readFileSync(broker.storePath, 'utf8'));
  const reminderPassed = skillRead(reminder.items, 'qqbot-remind') && events.every(item => item.success) &&
    events.filter(item => item.action === 'add').length === 1 && typeof id === 'string' && add.persisted === true &&
    add.result.registered === true && add.result.deliveryVerified === false && add.result.job.status === 'scheduled' &&
    add.result.job.paused === true && add.result.job.deliveryDisabled === true && add.result.job.deliveries === 0 &&
    add.result.job.deliveryAttempts === 0 && add.result.job.lastReceipt === null && add.args.schedule?.type === 'once' &&
    Math.abs(Date.parse(add.args.schedule.at) - Date.parse(before?.result?.now) - 300000) <= 1000 &&
    lists.length >= 2 && lists[0].result.jobs.some(job => job.id === id && job.paused && Date.parse(job.schedule.at) === Date.parse(add.args.schedule.at)) &&
    removed?.args.id === id && removed.result.removed === true && removed.result.id === id &&
    !lists.at(-1).result.jobs.some(job => job.id === id) && !stored.jobs.some(job => job.id === id) && stored.messages.length === 0 &&
    nativeCalls(reminder.items).length === events.length && nativeCalls(reminder.items).every((item, i) => item.success && item.tool === events[i].tool);
  summary.scenarios.push({ name: 'reminder', passed: reminderPassed, skillRead: skillRead(reminder.items, 'qqbot-remind'),
    calls: nativeCalls(reminder.items), persistedIdCreatedAndRemoved: Boolean(add?.persisted && id && !stored.jobs.some(job => job.id === id)), actualDeliveryTested: false });
  if (!reminderPassed) throw new Error('Paused reminder native MCP verification failed');
  const schema = { type: 'object', properties: Object.fromEntries(['fileTool', 'imageTool', 'speechTool', 'speechSendTool', 'fixtureMarker']
    .map(name => [name, { type: 'string' }]).concat([['imageAutomaticallyDelivered', { type: 'boolean' }], ['sendThisTurn', { type: 'boolean' }]])),
    required: ['fileTool', 'imageTool', 'speechTool', 'speechSendTool', 'fixtureMarker', 'imageAutomaticallyDelivered', 'sendThisTurn'], additionalProperties: false };
  const media = await turn('media', `如果以后我要把 ${fixture} 发到这里，再生成一张新图、最后用语音回复，你会分别怎么操作？本轮只讨论方法，不发送、不转换、不生图。读取适用的QQ媒体和聊天技能及这个实际文件。返回指定JSON：工具名称、文件真实marker、生图是否自动交付、本轮是否发送。`, schema);
  const answer = JSON.parse(media.items.filter(item => item.type === 'agentMessage').at(-1)?.text || '{}');
  const mediaPassed = skillRead(media.items, 'qqbot-media') && skillRead(media.items, 'qq-chat') &&
    answer.fileTool === 'qq_send_media' && answer.imageTool === 'qq_generate_image' && answer.speechTool === 'qq_speech' &&
    answer.speechSendTool === 'qq_send_media' && answer.fixtureMarker === fixtureMarker && answer.imageAutomaticallyDelivered === true &&
    answer.sendThisTurn === false && calls.filter(item => item.scenario === 'media').every(item => item.tool === 'qq_status' && item.success);
  summary.scenarios.push({ name: 'media', passed: mediaPassed, skillsRead: ['qqbot-media', 'qq-chat'].map(name => ({ name, read: skillRead(media.items, name) })),
    calls: nativeCalls(media.items), routeVerified: mediaPassed });
  if (!mediaPassed) throw new Error('Read-only media routing verification failed');
  const chat = await turn('chat', '哈哈周一只想躺平');
  const chatText = chat.items.filter(item => item.type === 'agentMessage').at(-1)?.text || '';
  const chatPassed = chatText.trim().length > 0 && !/自检|诊断|健康检查|工具可用|一切正常|没有问题/.test(chatText) &&
    nativeCalls(chat.items).length === 0 && !calls.some(item => item.scenario === 'chat');
  summary.scenarios.push({ name: 'chat', passed: chatPassed, noDiagnosticReply: chatPassed, calls: nativeCalls(chat.items) });
  summary.passed = chatPassed && forbiddenSends === 0 && interactive.length === 0 && broker.state.jobs.length === 0 && broker.state.messages.length === 0;
  if (!summary.passed) process.exitCode = 1;
} catch (error) {
  summary.passed = false; summary.error = error.message; process.exitCode = 1;
} finally {
  clearTimeout(deadline); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  // Clean only this run's exact recorded IDs; never touch any live broker state.
  for (const id of createdIds) if (broker.state.jobs.some(job => job.id === id)) {
    const job = broker.state.jobs.find(item => item.id === id);
    broker.setContext(job.contextKey, { ...job.target, msgId: crypto.randomUUID() }, { diagnostic: true, allowReminders: true });
    await originalCall('qq_reminder', { action: 'remove', id }, job.contextKey).catch(() => {});
  }
  stop(); await Promise.race([new Promise(resolve => child?.exitCode !== null ? resolve() : child?.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); stop('SIGKILL');
  await Promise.race([broker.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  for (const item of pending.values()) clearTimeout(item.timer);
  Object.assign(summary, { forbiddenSendAttempts: forbiddenSends, interactiveRequests: interactive, stderrBytes,
    reminderResidue: broker.state.jobs.length, recordedQQReceipts: broker.state.messages.length });
  const redact = value => JSON.stringify(value, null, 2).replaceAll(auth.apiKey, '[REDACTED]').replaceAll(broker.token, '[REDACTED]');
  fs.writeFileSync(path.join(directory, 'private-native.json'), redact({ traces, calls }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
}

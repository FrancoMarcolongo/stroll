const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'state:get', 'todo:add', 'todo:update', 'todo:delete', 'todo:handoff',
  'session:create', 'session:buffer', 'session:kill', 'session:forget', 'session:rename', 'session:link',
  'session:clearRestorable', 'session:markRead', 'session:mute', 'sessions:clearClosed',
  'run:markRead', 'run:events', 'run:cancel', 'run:reviewed', 'run:forget', 'runs:clearFinished',
  'recent:list', 'dialog:pickDir', 'open:external', 'config:set', 'app:checkUpdates', 'app:applyUpdate',
]);
const SEND = new Set(['session:write', 'session:resize', 'session:interrupt', 'ui:focus']);
const ON = new Set([
  'state:changed', 'session:data', 'session:exit', 'run:event', 'ui:navigate', 'ui:command', 'ui:window-focus',
  'ui:error', 'ui:update', 'config:changed',
]);

contextBridge.exposeInMainWorld('stroll', {
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) throw new Error(`blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => { if (SEND.has(channel)) ipcRenderer.send(channel, ...args); },
  on: (channel, fn) => {
    if (!ON.has(channel)) throw new Error(`blocked channel ${channel}`);
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Absolute path of a file dropped on the window (File.path is gone in current Electron).
  pathForFile: file => webUtils.getPathForFile(file),
});

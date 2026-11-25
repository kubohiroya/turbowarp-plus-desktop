// This bootstrap is embedded in a sandboxed, opaque-origin frame. Only the Worker imports add-on code.
function runAddonWorker () {
  const commands = new Map();
  const panels = new Map();
  const send = self.postMessage.bind(self);
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(id);
  const validLabel = label => typeof label === 'string' && label.trim() && label.length <= 80;
  const registerCommand = (id, label, handler) => {
    if (!validId(id) || !validLabel(label) || typeof handler !== 'function' || commands.has(id) || commands.size >= 12) {
      throw new TypeError('Invalid editor command');
    }
    commands.set(id, {label, handler});
  };
  const registerPanel = (id, label, {text = '', actions} = {}) => {
    if (!validId(id) || !validLabel(label) || typeof text !== 'string' || text.length > 800 || panels.has(id) ||
        panels.size >= 4 || !Array.isArray(actions) || !actions.length || actions.length > 6) {
      throw new TypeError('Invalid editor panel');
    }
    const handlers = new Map();
    for (const {id: actionId, label: actionLabel, run} of actions) {
      if (!validId(actionId) || !validLabel(actionLabel) || typeof run !== 'function' || handlers.has(actionId)) {
        throw new TypeError('Invalid editor panel action');
      }
      handlers.set(actionId, {label: actionLabel, handler: run});
    }
    panels.set(id, {label, text, actions: handlers});
  };
  const describe = entries => Array.from(entries, ([id, {label}]) => ({id, label}));
  self.addEventListener('message', async ({data: {format, id, values, sources, startup, paintClipboard}}) => {
    try {
      const currentSettings = new Map(values);
      const settingEvents = new EventTarget();
      const settings = Object.freeze({
        get: key => currentSettings.get(key),
        addEventListener: settingEvents.addEventListener.bind(settingEvents),
        removeEventListener: settingEvents.removeEventListener.bind(settingEvents)
      });
      const api = Object.freeze({registerCommand, registerPanel, settings});
      const reduxEvents = new EventTarget();
      let paintEvents = false;
      let paintReply = null;
      const redux = Object.freeze({
        initialize: () => {
          if (!paintClipboard) throw new Error('This add-on has no editor Redux permission');
          paintEvents = true;
        },
        addEventListener: reduxEvents.addEventListener.bind(reduxEvents),
        removeEventListener: reduxEvents.removeEventListener.bind(reduxEvents),
        dispatch: action => {
          if (paintReply && action?.type === 'scratch-paint/clipboard/CLEAR_PASTE_OFFSET') paintReply.clearOffset = true;
        }
      });
      const addon = Object.freeze({
        tab: Object.freeze({registerEditorCommand: registerCommand, registerEditorPanel: registerPanel, redux}),
        settings,
        self: Object.freeze(Object.assign(new EventTarget(), {id, disabled: false, enabledLate: false}))
      });
      for (const source of sources) {
        const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
        try {
          const module = await import(url);
          if (format === 'turbowarp') await module.default({addon, console});
          else {
            if (startup) await module.beforeProjectLoad?.(api);
            if (typeof module.activate === 'function') await module.activate(api);
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!commands.size && !panels.size && !paintEvents) throw new Error('No editor integration registered');
      self.addEventListener('message', async ({data: {type, id, panel, request, action, values: updates}}) => {
        if (type === 'settings') {
          for (const [key, value] of updates) currentSettings.set(key, value);
          settingEvents.dispatchEvent(new Event('change'));
          return;
        }
        if (type === 'paint' && paintEvents) {
          paintReply = {type: 'paint-result', request, clearOffset: false};
          reduxEvents.dispatchEvent(new CustomEvent('statechanged', {detail: {action: {type: action}}}));
          send(paintReply);
          paintReply = null;
          return;
        }
        try {
          const entry = panel ? panels.get(panel)?.actions.get(id) : commands.get(id);
          const value = await entry?.handler();
          send({type: 'result', request, project: value?.project, label: value?.label, text: value?.text,
            workspace: value?.workspace});
        } catch {
          send({type: 'result', request});
        }
      });
      send({type: 'ready', paintEvents, commands: describe(commands),
        panels: Array.from(panels, ([id, {label, text, actions}]) => ({id, label, text, actions: describe(actions)}))});
    } catch {
      send({type: 'failed'});
    }
  }, {once: true});
}

function connect (event) {
  if (event.source !== parent || event.data?.type !== 'local-editor-addon-connect' || !event.ports[0]) return;
  window.removeEventListener('message', connect);
  const port = event.ports[0];
  const url = URL.createObjectURL(new Blob(['(', runAddonWorker.toString(), ')()'], {type: 'text/javascript'}));
  try {
    const worker = new Worker(url);
    let initializing = true;
    let pending;
    let pendingPaint;
    const fail = () => {
      if (!initializing) return;
      initializing = false;
      port.postMessage({type: 'failed'});
    };
    const bounded = (value, length) => typeof value === 'string' ? value.slice(0, length + 1) : undefined;
    const entry = value => ({id: bounded(value?.id, 50), label: bounded(value?.label, 80)});
    const entries = (value, limit, map) => Array.isArray(value) && value.length <= limit ? Array.from(value, map) : null;
    worker.addEventListener('message', ({data}) => {
      if (initializing && data?.type === 'ready') {
        initializing = false;
        const commands = entries(data.commands, 12, entry);
        const panels = entries(data.panels, 4, panel => ({
          ...entry(panel), text: bounded(panel?.text, 800), actions: entries(panel?.actions, 6, entry)
        }));
        port.postMessage({type: 'ready', commands, panels, paintEvents: data.paintEvents === true});
      } else if (data?.type === 'failed') {
        fail();
      } else if (data?.type === 'result' && pending && data.request === pending) {
        port.postMessage({type: 'result', request: pending,
          project: data.project === 'run' || data.project === 'stop' ? data.project : undefined,
          label: bounded(data.label, 80), text: bounded(data.text, 800), workspace: bounded(data.workspace, 12)});
        pending = undefined;
      } else if (data?.type === 'paint-result' && pendingPaint && data.request === pendingPaint) {
        port.postMessage({type: 'paint-result', request: pendingPaint, clearOffset: data.clearOffset === true});
        pendingPaint = undefined;
      }
    });
    worker.addEventListener('error', fail);
    port.onmessage = ({data}) => {
      if (data.type === 'paint') pendingPaint = data.request;
      else if (data.type !== 'settings') pending = data.request;
      worker.postMessage(data);
    };
    const {format, id, values, sources, startup, paintClipboard} = event.data;
    worker.postMessage({format, id, values, sources, startup, paintClipboard});
    window.addEventListener('pagehide', () => worker.terminate(), {once: true});
  } catch {
    port.postMessage({type: 'failed'});
  } finally {
    URL.revokeObjectURL(url);
  }
}

window.addEventListener('message', connect);

// This bootstrap is embedded in a sandboxed, opaque-origin frame. Only the Worker imports add-on code.
function runAddonWorker () {
  const commands = new Map();
  const send = self.postMessage.bind(self);
  const registerCommand = (id, label, handler) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(id) ||
        typeof label !== 'string' || !label.trim() || label.length > 80 ||
        typeof handler !== 'function' || commands.has(id) || commands.size >= 12) {
      throw new TypeError('Invalid editor command');
    }
    commands.set(id, {label, handler});
  };
  self.addEventListener('message', async ({data: {format, id, defaults, sources}}) => {
    try {
      const api = Object.freeze({registerCommand});
      const settings = new Map(defaults);
      const addon = Object.freeze({
        tab: Object.freeze({registerEditorCommand: registerCommand}),
        settings: Object.freeze({get: key => settings.get(key)}),
        self: Object.freeze({id, disabled: false})
      });
      for (const source of sources) {
        const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
        try {
          const module = await import(url);
          if (format === 'turbowarp') await module.default({addon});
          else await module.activate(api);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!commands.size) throw new Error('No editor commands registered');
      self.addEventListener('message', async ({data: {id, request}}) => {
        try {
          const value = await commands.get(id)?.handler();
          send({type: 'result', request, project: value?.project, label: value?.label});
        } catch {
          send({type: 'result', request});
        }
      });
      send({type: 'ready', commands: Array.from(commands, ([id, {label}]) => ({id, label}))});
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
    const fail = () => {
      if (!initializing) return;
      initializing = false;
      port.postMessage({type: 'failed'});
    };
    worker.addEventListener('message', ({data}) => {
      if (initializing && data?.type === 'ready' && Array.isArray(data.commands) && data.commands.length <= 12) {
        initializing = false;
        const commands = data.commands.map(command => ({
          id: typeof command?.id === 'string' && command.id.slice(0, 51),
          label: typeof command?.label === 'string' && command.label.slice(0, 81)
        }));
        port.postMessage({type: 'ready', commands});
      } else if (data?.type === 'failed') {
        fail();
      } else if (data?.type === 'result' && pending && data.request === pending) {
        port.postMessage({type: 'result', request: pending,
          project: data.project === 'run' || data.project === 'stop' ? data.project : undefined,
          label: typeof data.label === 'string' ? data.label.slice(0, 81) : undefined});
        pending = undefined;
      }
    });
    worker.addEventListener('error', fail);
    port.onmessage = ({data}) => {
      pending = data.request;
      worker.postMessage(data);
    };
    const {format, id, defaults, sources} = event.data;
    worker.postMessage({format, id, defaults, sources});
    window.addEventListener('pagehide', () => worker.terminate(), {once: true});
  } catch {
    port.postMessage({type: 'failed'});
  } finally {
    URL.revokeObjectURL(url);
  }
}

window.addEventListener('message', connect);

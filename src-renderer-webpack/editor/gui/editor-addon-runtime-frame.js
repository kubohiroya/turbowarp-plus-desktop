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
  self.addEventListener('message', async ({data: {format, id, defaults, sources, startup, paintClipboard}}) => {
    try {
      const api = Object.freeze({registerCommand});
      const settings = new Map(defaults);
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
        tab: Object.freeze({registerEditorCommand: registerCommand, redux}),
        settings: Object.freeze({get: key => settings.get(key)}),
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
      if (!commands.size && !paintEvents) throw new Error('No editor integration registered');
      self.addEventListener('message', async ({data: {type, id, request, action}}) => {
        if (type === 'paint' && paintEvents) {
          paintReply = {type: 'paint-result', request, clearOffset: false};
          reduxEvents.dispatchEvent(new CustomEvent('statechanged', {detail: {action: {type: action}}}));
          send(paintReply);
          paintReply = null;
          return;
        }
        try {
          const value = await commands.get(id)?.handler();
          send({type: 'result', request, project: value?.project, label: value?.label});
        } catch {
          send({type: 'result', request});
        }
      });
      send({type: 'ready', paintEvents, commands: Array.from(commands, ([id, {label}]) => ({id, label}))});
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
    worker.addEventListener('message', ({data}) => {
      if (initializing && data?.type === 'ready' && Array.isArray(data.commands) && data.commands.length <= 12) {
        initializing = false;
        const commands = data.commands.map(command => ({
          id: typeof command?.id === 'string' && command.id.slice(0, 51),
          label: typeof command?.label === 'string' && command.label.slice(0, 81)
        }));
        port.postMessage({type: 'ready', commands, paintEvents: data.paintEvents === true});
      } else if (data?.type === 'failed') {
        fail();
      } else if (data?.type === 'result' && pending && data.request === pending) {
        port.postMessage({type: 'result', request: pending,
          project: data.project === 'run' || data.project === 'stop' ? data.project : undefined,
          label: typeof data.label === 'string' ? data.label.slice(0, 81) : undefined});
        pending = undefined;
      } else if (data?.type === 'paint-result' && pendingPaint && data.request === pendingPaint) {
        port.postMessage({type: 'paint-result', request: pendingPaint, clearOffset: data.clearOffset === true});
        pendingPaint = undefined;
      }
    });
    worker.addEventListener('error', fail);
    port.onmessage = ({data}) => {
      if (data.type === 'paint') pendingPaint = data.request;
      else pending = data.request;
      worker.postMessage(data);
    };
    const {format, id, defaults, sources, startup, paintClipboard} = event.data;
    worker.postMessage({format, id, defaults, sources, startup, paintClipboard});
    window.addEventListener('pagehide', () => worker.terminate(), {once: true});
  } catch {
    port.postMessage({type: 'failed'});
  } finally {
    URL.revokeObjectURL(url);
  }
}

window.addEventListener('message', connect);

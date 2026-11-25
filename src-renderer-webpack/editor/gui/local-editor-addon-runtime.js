import getStageControls from '@tw-plus/pinned-stage-controls';
import addonRedux from 'scratch-gui/src/addons/redux.js';

const paintSet = 'scratch-paint/clipboard/SET';
const paintIncrement = 'scratch-paint/clipboard/INCREMENT_PASTE_OFFSET';
const paintClear = 'scratch-paint/clipboard/CLEAR_PASTE_OFFSET';

const validLabel = value => typeof value === 'string' && value.length <= 80 && value.trim();
const validCommands = commands => Array.isArray(commands) && commands.length <= 12 &&
  commands.every(command => typeof command?.id === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(command.id) &&
    validLabel(command.label)) && new Set(commands.map(command => command.id)).size === commands.length;

let connection;

export function startEditorAddonRuntime (vm, host) {
  if (!host) return;
  if (connection?.vm === vm) return connection.ready;
  connection?.dispose();
  const {api} = getStageControls(vm);
  const staged = new Map();
  const active = new Map();
  let paintOffsetOverridden = false;
  const disposeBuild = (build, restorePaint) => {
    if (!build) return;
    build.stopPaint?.();
    if (restorePaint && build.stopPaint && paintOffsetOverridden &&
        !Array.from(active.values()).some(other => other !== build && other.stopPaint)) {
      paintOffsetOverridden = false;
      if (addonRedux.state.scratchPaint?.clipboard?.pasteOffset === 0) addonRedux.dispatch({type: paintIncrement});
    }
    clearTimeout(build.timeout);
    clearTimeout(build.invocation?.timeout);
    for (const button of build.buttons) button.dispose();
    build.port.close();
    build.frame.remove();
  };
  const remove = (builds, key, restorePaint = false) => {
    disposeBuild(builds.get(key), restorePaint);
    builds.delete(key);
  };
  const reset = () => {
    for (const key of staged.keys()) remove(staged, key);
    for (const key of active.keys()) remove(active, key);
  };
  const prepare = ({runtimeId, token, format, id, defaults, sources, startup, paintClipboard}) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Editor add-on runtime';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = new URL('editor-addon-runtime.html', document.baseURI).href;
    const {port1, port2} = new MessageChannel();
    const build = {frame, port: port1, commands: null, buttons: [], invocation: null, paintEvents: false};
    staged.set(runtimeId, build);

    const prepared = commands => {
      if (staged.get(runtimeId) !== build || build.commands) return;
      clearTimeout(build.timeout);
      build.commands = commands;
      if (!commands) remove(staged, runtimeId);
      void host.prepared(runtimeId, Boolean(commands)).catch(() => remove(staged, runtimeId));
    };
    build.timeout = setTimeout(() => prepared(null), 4000);
    port1.onmessage = ({data}) => {
      if (data?.type === 'ready' && staged.get(runtimeId) === build && !build.commands) {
        build.paintEvents = paintClipboard && data.paintEvents === true;
        const accepted = validCommands(data.commands) && (data.commands.length > 0 || build.paintEvents);
        prepared(accepted ? data.commands : null);
      } else if (data?.type === 'failed') {
        prepared(null);
      } else if (data?.type === 'paint-result' && active.get(token) === build &&
          build.paintRequest && data.request === build.paintRequest) {
        build.paintRequest = null;
        if (data.clearOffset === true) {
          paintOffsetOverridden = true;
          addonRedux.dispatch({type: paintClear});
        }
      } else if (data?.type === 'result' && active.get(token) === build &&
          build.invocation && build.invocation.request === data.request) {
        const {button, timeout} = build.invocation;
        clearTimeout(timeout);
        build.invocation = null;
        if (validLabel(data.label)) button.update({label: data.label});
        if (data.project === 'run') vm.greenFlag();
        if (data.project === 'stop') vm.stopAll();
      }
    };
    frame.addEventListener('load', () => {
      frame.contentWindow.postMessage(
        {type: 'local-editor-addon-connect', format, id, defaults, sources, startup, paintClipboard}, '*', [port2]);
    }, {once: true});
    document.body.appendChild(frame);
  };

  const register = (token, build) => {
    for (const button of build.buttons) button.dispose();
    build.buttons = build.commands.map(({id, label}) => {
      const button = api.addButton({id: `local-editor-addon-${token}-${id}`, label, onClick: () => {
        if (build.invocation || active.get(token) !== build) return;
        const request = crypto.randomUUID();
        const timeout = setTimeout(() => { build.invocation = null; }, 3000);
        build.invocation = {request, button, timeout};
        build.port.postMessage({id, request});
      }});
      button.update({visible: true});
      return button;
    });
  };
  const attachPaintEvents = build => {
    const stateChanged = ({detail}) => {
      const action = detail.action.type;
      if (action !== paintSet && action !== paintIncrement) return;
      build.paintRequest = crypto.randomUUID();
      build.port.postMessage({type: 'paint', action, request: build.paintRequest});
    };
    addonRedux.addEventListener('statechanged', stateChanged);
    build.stopPaint = () => addonRedux.removeEventListener('statechanged', stateChanged);
  };
  const projectLoaded = () => {
    for (const [token, build] of active) {
      clearTimeout(build.invocation?.timeout);
      build.invocation = null;
      register(token, build);
    }
  };
  // The Workbench clears project-scoped controls on PROJECT_LOADED. These add-ons belong to the editor window.
  vm.on('PROJECT_LOADED', projectLoaded);
  const unsubscribe = host.onRuntime(message => {
    switch (message.type) {
    case 'prepare': prepare(message); break;
    case 'accept': {
      const build = staged.get(message.runtimeId);
      if (!build?.commands) break;
      staged.delete(message.runtimeId);
      remove(active, message.token, !build.paintEvents);
      active.set(message.token, build);
      if (build.paintEvents) attachPaintEvents(build);
      register(message.token, build);
      break;
    }
    case 'discard': remove(staged, message.runtimeId); break;
    case 'remove': remove(active, message.token, true); break;
    case 'reset': reset(); break;
    }
  });
  const ready = host.ready().catch(() => {});
  connection = {vm, ready, dispose: () => {
    unsubscribe();
    vm.removeListener('PROJECT_LOADED', projectLoaded);
    reset();
  }};
  return ready;
}

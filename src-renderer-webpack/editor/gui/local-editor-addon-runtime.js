import getStageControls from '@tw-plus/pinned-stage-controls';

const validLabel = value => typeof value === 'string' && value.length <= 80 && value.trim();
const validCommands = commands => Array.isArray(commands) && commands.length > 0 && commands.length <= 12 &&
  commands.every(command => typeof command?.id === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(command.id) &&
    validLabel(command.label)) && new Set(commands.map(command => command.id)).size === commands.length;

let connection;

export function ensureEditorAddonRuntime (vm, host) {
  if (!host || connection?.vm === vm) return;
  connection?.dispose();
  const {api} = getStageControls(vm);
  const staged = new Map();
  const active = new Map();
  const disposeBuild = build => {
    if (!build) return;
    clearTimeout(build.timeout);
    clearTimeout(build.invocation?.timeout);
    for (const button of build.buttons) button.dispose();
    build.port.close();
    build.frame.remove();
  };
  const remove = (builds, key) => {
    disposeBuild(builds.get(key));
    builds.delete(key);
  };
  const reset = () => {
    for (const key of staged.keys()) remove(staged, key);
    for (const key of active.keys()) remove(active, key);
  };
  const prepare = ({runtimeId, token, format, sources}) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Editor add-on runtime';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = new URL('editor-addon-runtime.html', document.baseURI).href;
    const {port1, port2} = new MessageChannel();
    const build = {frame, port: port1, commands: null, buttons: [], invocation: null};
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
        prepared(validCommands(data.commands) ? data.commands : null);
      } else if (data?.type === 'failed') {
        prepared(null);
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
      frame.contentWindow.postMessage({type: 'local-editor-addon-connect', format, sources}, '*', [port2]);
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
      remove(active, message.token);
      active.set(message.token, build);
      register(message.token, build);
      break;
    }
    case 'discard': remove(staged, message.runtimeId); break;
    case 'remove': remove(active, message.token); break;
    case 'reset': reset(); break;
    }
  });
  connection = {vm, dispose: () => {
    unsubscribe();
    vm.removeListener('PROJECT_LOADED', projectLoaded);
    reset();
  }};
}

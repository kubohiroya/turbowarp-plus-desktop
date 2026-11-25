import {getExtensionAuthoringHost} from './local-extension-authoring.js';

export const connectLocalExtensionDevelopment = (vm, host, notify) => {
  let active = null;
  let disposed = false;

  const stop = () => {
    const session = active;
    active = null;
    if (!session) return Promise.resolve();
    session.unsubscribe();
    session.controller.abort();
    return Promise.resolve(host.stop()).catch(() => {});
  };

  const apply = async (session, build) => {
    const {authoring, controller} = session;
    if (session.sha256 === undefined) {
      const manifest = await authoring.inspect();
      const installed = manifest?.extensions.find(spec => spec.id === build.id);
      if (installed && (installed.sha256 !== session.initialSHA256 || installed.execution !== 'sandboxed' ||
          installed.source.type !== 'embedded-file' || installed.source.url ||
          installed.capabilities.length || installed.dependencies.length)) throw new Error('LOCAL_EXTENSION_CONFLICT');
      session.sha256 = installed?.sha256 ?? null;
    }
    if (active !== session || build.sha256 === session.sha256) return;
    await authoring.applyDevelopmentBuild({id: build.id, sha256: build.sha256,
      previousSHA256: session.sha256 ?? undefined, bytes: new Uint8Array(build.bytes)},
    ({id, sha256}) => host.authorize(build.session, id, sha256), {signal: controller.signal});
    session.sha256 = build.sha256;
  };

  const enqueue = build => {
    const session = active;
    if (!session || session.token !== build.session) return;
    session.next = build;
    if (session.running) return;
    session.running = true;
    void (async () => {
      try {
        while (active === session && session.next) {
          const next = session.next;
          session.next = null;
          try {
            await apply(session, next);
          } catch (error) {
            if (active !== session) return;
            if (error.code === 'PROJECT_CHANGED' && !session.next && !session.retried) {
              session.retried = true;
              session.next = next;
              continue;
            }
            if (error.code === 'PROJECT_RECOVERY_REQUIRED' || error.message === 'LOCAL_EXTENSION_CONFLICT') {
              await stop();
              if (!disposed) notify(error.message === 'LOCAL_EXTENSION_CONFLICT' ? error.message : error.code);
              return;
            }
            if (!session.next) notify('LOCAL_EXTENSION_APPLY_FAILED');
          }
          session.retried = false;
        }
      } finally {
        session.running = false;
      }
    })();
  };
  const unsubscribeBuild = host.onBuild(enqueue);
  const unsubscribeStopped = host.onStopped(({session, code}) => {
    if (active?.token !== session) return;
    void stop();
    notify(code);
  });
  return {
    async start () {
      if (disposed || active) return;
      const authoring = getExtensionAuthoringHost(vm);
      if (typeof authoring?.applyDevelopmentBuild !== 'function') {
        notify('LOCAL_EXTENSION_UNAVAILABLE');
        return;
      }
      const session = {authoring, controller: new AbortController(), unsubscribe: () => {}};
      active = session;
      const unbindReplacement = authoring.onProjectReplacement(() => { void stop(); });
      const unbindDisposal = authoring.onDispose(() => { void stop(); });
      session.unsubscribe = () => { unbindReplacement(); unbindDisposal(); };
      try {
        const build = await host.start();
        if (active !== session) return;
        if (!build) {
          await stop();
          return;
        }
        session.token = build.session;
        session.initialSHA256 = build.sha256;
        enqueue(build);
      } catch (error) {
        if (active !== session) return;
        await stop();
        if (!disposed) notify(error.message.includes('LOCAL_EXTENSION_BUILD_REQUIRED') ?
          'LOCAL_EXTENSION_BUILD_REQUIRED' : 'LOCAL_EXTENSION_UNAVAILABLE');
      }
    },
    stop,
    dispose () {
      disposed = true;
      unsubscribeBuild();
      unsubscribeStopped();
      void stop();
    }
  };
};

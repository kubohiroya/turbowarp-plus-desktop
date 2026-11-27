import {getExtensionAuthoringHost} from './local-extension-authoring.js';
import {sourceBuildDiagnostics, sourceBuildMeasurements} from './source-build-feedback.mjs';

export const connectLocalExtensionDevelopment = (vm, host, notify, onSessionsChanged) => {
  const sessions = new Map();
  const decoder = new TextDecoder();
  const sourceDecoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  const pending = new Map();
  let opening = null;
  let running = false;
  let disposed = false;

  const publishSessions = () => {
    if (disposed) return;
    onSessionsChanged(Array.from(sessions, ([token, {directory, id, sourceHeader, enabled, busy, error, sha256, waiting, diagnostic, mode, buildError, buildDiagnostics, measurements}]) =>
      ({token, directory, id, sourceHeader, enabled, busy, error, appliedDigest: sha256, waiting, diagnostic, mode, buildError, buildDiagnostics, measurements})));
  };

  const unsubscribeDiagnostic = host.resolveDiagnostic &&
    vm.extensionManager.getExtensionServicePort?.()?.observeSandboxErrors?.(({id, code, line, column}) => {
      const entry = Array.from(sessions).find(([, session]) => session.id === id && session.diagnosticBuild?.code === code);
      if (!entry) return;
      const [token, session] = entry;
      const build = session.diagnosticBuild;
      if (build.resolving || (build.lastLine === line && build.lastColumn === column)) return;
      Object.assign(build, {lastLine: line, lastColumn: column, resolving: true});
      void host.resolveDiagnostic(token, build.sha256, build.sourceMapSHA256, line, column).then(diagnostic => {
        if (diagnostic && sessions.get(token) === session && session.diagnosticBuild === build) {
          session.diagnostic = diagnostic;
          publishSessions();
        }
      }).catch(() => {}).finally(() => { build.resolving = false; });
    });

  const pause = (session, token) => {
    session.enabled = false;
    session.waiting = false;
    session.buildError = null;
    session.buildDiagnostics = [];
    pending.delete(token);
    session.controller.abort();
  };

  const unbind = token => {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    pause(session, token);
    session.unsubscribe();
  };

  const stop = async token => {
    if (!sessions.has(token)) return;
    unbind(token);
    publishSessions();
    await host.stop(token);
  };

  const stopAll = () => {
    if (!opening && !sessions.size) return;
    opening?.unsubscribe();
    opening = null;
    for (const token of sessions.keys()) unbind(token);
    publishSessions();
    void host.stop().catch(() => {});
  };

  const readHeader = build => decoder.decode(new Uint8Array(build.bytes).subarray(0, 16 * 1024));
  const failureCode = error => [
    'LOCAL_EXTENSION_BUILD_REQUIRED', 'LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_INCOMPATIBLE',
    'LOCAL_EXTENSION_ALREADY_WATCHING', 'LOCAL_EXTENSION_SOURCE_FAILED', 'LOCAL_EXTENSION_SOURCE_TIMEOUT',
    'LOCAL_EXTENSION_SOURCE_LIMIT', 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE', 'LOCAL_EXTENSION_SOURCE_BUSY',
    'LOCAL_EXTENSION_SOURCE_CHANGED'
  ].find(code => error.message.includes(code)) ?? 'LOCAL_EXTENSION_UNAVAILABLE';

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
    if (sessions.get(build.session) !== session) return;
    const mappingChanged = build.sha256 !== session.sha256 ||
      build.sourceMapSHA256 !== session.diagnosticBuild?.sourceMapSHA256;
    const retainMapping = mappingChanged && unsubscribeDiagnostic && host.retainDiagnostics &&
      await host.retainDiagnostics(build.session, build.sha256, build.sourceMapSHA256, false).catch(() => false);
    if (sessions.get(build.session) !== session || controller.signal.aborted) return;
    if (build.sha256 !== session.sha256) {
      await authoring.applyDevelopmentBuild({id: build.id, sha256: build.sha256,
        previousSHA256: session.sha256 ?? undefined, bytes: new Uint8Array(build.bytes)},
      ({id, sha256}) => host.authorize(build.session, id, sha256), {signal: controller.signal});
      if (sessions.get(build.session) !== session || controller.signal.aborted) return;
      session.sha256 = build.sha256;
    }
    if (mappingChanged) {
      session.diagnostic = null;
      session.diagnosticBuild = null;
      const retained = retainMapping &&
        await host.retainDiagnostics(build.session, build.sha256, build.sourceMapSHA256, true).catch(() => false);
      if (retained && build.sourceMapSHA256 && sessions.get(build.session) === session) {
        session.diagnosticBuild = {sha256: build.sha256, sourceMapSHA256: build.sourceMapSHA256,
          code: sourceDecoder.decode(new Uint8Array(build.bytes))};
      }
    }
    if (sessions.get(build.session) !== session || controller.signal.aborted) return;
    session.sourceHeader = readHeader(build);
    session.measurements = sourceBuildMeasurements(build.measurements);
    session.error = null;
    publishSessions();
  };

  const enqueue = build => {
    const session = sessions.get(build.session);
    if (!session) {
      opening?.events.set(build.session, {build});
      return;
    }
    if (!session.enabled) {
      if (session.busy) session.resumeBuild = build;
      return;
    }
    pending.set(build.session, build);
    if (running) return;
    running = true;
    void (async () => {
      try {
        // All folders update the same VM. Finish each project transaction before applying the next.
        while (pending.size) {
          const [token, next] = pending.entries().next().value;
          pending.delete(token);
          const session = sessions.get(token);
          try {
            await apply(session, next);
          } catch (error) {
            if (!sessions.has(token) || !session.enabled) continue;
            if (error.code === 'PROJECT_CHANGED' && !pending.has(token) && !session.retried) {
              session.retried = true;
              pending.set(token, next);
              continue;
            }
            if (error.code === 'PROJECT_RECOVERY_REQUIRED') {
              stopAll();
              notify(error.code);
              continue;
            }
            if (error.message === 'LOCAL_EXTENSION_CONFLICT') {
              pause(session, token);
              session.error = error.message;
              publishSessions();
              await host.setEnabled(token, false).catch(() => {});
              continue;
            }
            if (!pending.has(token)) {
              session.error = 'LOCAL_EXTENSION_APPLY_FAILED';
              publishSessions();
            }
          }
          session.retried = false;
        }
      } finally {
        running = false;
      }
    })();
  };

  const unsubscribeBuild = host.onBuild(enqueue);
  const unsubscribeArtifacts = host.onArtifacts(({session, waiting, code, diagnostics}) => {
    const feedback = {waiting, buildError: code, buildDiagnostics: code ? sourceBuildDiagnostics(diagnostics) : []};
    const current = sessions.get(session);
    if (!current) {
      opening?.artifacts.set(session, feedback);
    } else if (current.enabled || current.busy) {
      Object.assign(current, feedback);
      publishSessions();
    }
  });
  const unsubscribeStopped = host.onStopped(({session, code}) => {
    const current = sessions.get(session);
    if (!current) {
      opening?.events.set(session, {code});
      return;
    }
    pause(current, session);
    current.error = code;
    publishSessions();
  });
  return {
    async start (mode) {
      if (disposed || opening) return;
      const authoring = getExtensionAuthoringHost(vm);
      if (typeof authoring?.applyDevelopmentBuild !== 'function') {
        notify('LOCAL_EXTENSION_UNAVAILABLE');
        return;
      }
      const closeOnProjectChange = () => stopAll();
      const unbindReplacement = authoring.onProjectReplacement(closeOnProjectChange);
      const unbindDisposal = authoring.onDispose(closeOnProjectChange);
      const unsubscribe = () => { unbindReplacement(); unbindDisposal(); };
      const request = {unsubscribe, events: new Map(), artifacts: new Map()};
      opening = request;
      try {
        const build = await host.start(mode);
        if (!build) return;
        if (opening !== request) {
          await host.stop(build.session);
          return;
        }
        const newest = request.events.get(build.session);
        if (newest?.code) {
          notify(newest.code);
          return;
        }
        sessions.set(build.session, {authoring, controller: new AbortController(), unsubscribe,
          initialSHA256: build.sha256, directory: build.directory, id: build.id, enabled: true,
          sourceHeader: readHeader(build), mode: build.mode, ...request.artifacts.get(build.session)});
        opening = null;
        publishSessions();
        enqueue(newest?.build ?? build);
      } catch (error) {
        if (opening !== request) return;
        notify(failureCode(error));
      } finally {
        if (opening === request) {
          opening = null;
          unsubscribe();
        }
      }
    },
    cancelStart () {
      if (!opening) return;
      opening.unsubscribe();
      opening = null;
      void host.cancelStart?.().catch(() => {});
    },
    async setEnabled (token, enabled) {
      const session = sessions.get(token);
      if (!session || session.busy || session.enabled === enabled) return;
      session.busy = true;
      session.error = null;
      if (!enabled) pause(session, token);
      publishSessions();
      try {
        const build = await host.setEnabled(token, enabled);
        if (sessions.get(token) !== session || !enabled || !build || session.error) return;
        session.controller = new AbortController();
        session.enabled = true;
        enqueue(session.resumeBuild ?? build);
      } catch (error) {
        if (sessions.get(token) === session) session.error = failureCode(error);
      } finally {
        if (sessions.get(token) === session) {
          session.resumeBuild = null;
          session.busy = false;
          publishSessions();
        }
      }
    },
    stop (token) {
      return stop(token).catch(() => { if (!disposed) notify('LOCAL_EXTENSION_UNAVAILABLE'); });
    },
    dispose () {
      disposed = true;
      unsubscribeDiagnostic?.();
      unsubscribeBuild();
      unsubscribeArtifacts();
      unsubscribeStopped();
      stopAll();
    }
  };
};

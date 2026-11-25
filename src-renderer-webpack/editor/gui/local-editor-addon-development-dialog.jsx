import React from 'react';
import {LocalEditorAddonSettings} from './local-editor-addon-settings.jsx';
import {LocalExtensionDevelopmentDialog} from './local-extension-development-dialog.jsx';

const errors = locale => locale.startsWith('ja') ? {
  LOCAL_ADDON_RUNTIME_UNSUPPORTED: 'このアドオンの設定は、開発フォルダからの読み込みに対応していません。',
  LOCAL_ADDON_STYLE_UNSUPPORTED: 'この CSS には、外部リソースの参照など、この開発モードで使えない記述があります。',
  LOCAL_ADDON_RUNTIME_FAILED: 'JavaScript の起動に失敗しました。実行エントリとアドオン API の使い方を確認してください。',
  LOCAL_ADDON_DUPLICATE: '同じフォルダ、または同じ ID のアドオンが登録されています。',
  LOCAL_ADDON_REVIEW_FAILED: 'アドオンを読み込めませんでした。マニフェストとビルド出力を確認してください。',
  LOCAL_ADDON_SETTINGS_CHANGED: '設定の定義が更新されました。新しい項目を確認してください。',
  LOCAL_ADDON_INVALID_SETTINGS: '設定値を確認してください。',
  LOCAL_ADDON_CHANGED: 'アドオンの ID、形式、または実行の許可範囲が変わりました。新しい構成で使うには、フォルダを登録し直してください。',
  LOCAL_ADDON_BOUNDARY: 'フォルダの参照先が変わったため、最後に適用した版を維持しています。',
  LOCAL_ADDON_INCOMPLETE: 'ビルド出力を確認できないため、最後に適用した版を維持しています。'
} : {
  LOCAL_ADDON_RUNTIME_UNSUPPORTED: 'This add-on configuration is unsupported for development folders.',
  LOCAL_ADDON_STYLE_UNSUPPORTED: 'This CSS contains external resources or syntax outside this development profile.',
  LOCAL_ADDON_RUNTIME_FAILED: 'JavaScript failed to start. Check the entry point and use of the add-on API.',
  LOCAL_ADDON_DUPLICATE: 'This folder or add-on ID is already registered.',
  LOCAL_ADDON_REVIEW_FAILED: 'Could not load the add-on. Check its manifest and build output.',
  LOCAL_ADDON_SETTINGS_CHANGED: 'The add-on settings changed. Review the updated fields.',
  LOCAL_ADDON_INVALID_SETTINGS: 'Check the settings values.',
  LOCAL_ADDON_CHANGED: 'The add-on ID, format, or approved capabilities changed. Add the folder again to use the new configuration.',
  LOCAL_ADDON_BOUNDARY: 'The folder changed location. The last applied version is still active.',
  LOCAL_ADDON_INCOMPLETE: 'The build output could not be verified. The last applied version is still active.'
};

export function LocalEditorAddonDevelopmentDialog ({locale, host, onClose}) {
  const [sessions, setSessions] = React.useState([]);
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState(null);
  const messages = errors(locale);
  const errorText = code => messages[code] ?? messages.LOCAL_ADDON_REVIEW_FAILED;
  React.useEffect(() => {
    let live = true;
    let received = false;
    const unsubscribe = host.onChange(rows => { received = true; setSessions(rows); });
    void host.list().then(rows => {
      if (live && !received) setSessions(rows);
    }).catch(() => { if (live) setProblem('LOCAL_ADDON_REVIEW_FAILED'); });
    return () => { live = false; unsubscribe(); };
  }, [host]);
  const run = async (token, action) => {
    if (busy !== null) return;
    setBusy(token);
    setProblem(null);
    try { await action(); return true; }
    catch (error) {
      setProblem(String(error.message).match(/LOCAL_ADDON_[A-Z_]+/u)?.[0] ?? 'LOCAL_ADDON_REVIEW_FAILED');
      return false;
    }
    finally { setBusy(null); }
  };
  return <LocalExtensionDevelopmentDialog
    kind="addon"
    locale={locale}
    sessions={sessions.map(session => ({...session, busy: busy !== null}))}
    error={problem && errorText(problem)}
    errorText={errorText}
    adding={busy !== null}
    onClose={() => { if (busy === null) onClose(); }}
    onAdd={() => run('add', () => host.start())}
    onToggle={(token, enabled) => run(token, () => host.setEnabled(token, enabled))}
    onRemove={token => run(token, () => host.remove(token))}
    renderSettings={session => session.settings?.length > 0 && <LocalEditorAddonSettings
      key={session.settingsRevision}
      locale={locale}
      fields={session.settings}
      disabled={session.busy || session.removing}
      apply={changes => run(session.token, () => host.setSettings(session.token, session.settingsRevision, changes))}
    />}
  />;
}

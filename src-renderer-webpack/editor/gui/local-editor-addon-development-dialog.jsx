import React from 'react';
import {LocalExtensionDevelopmentDialog} from './local-extension-development-dialog.jsx';

const errors = locale => locale.startsWith('ja') ? {
  LOCAL_ADDON_RUNTIME_UNSUPPORTED: 'この形式のスクリプトや起動時の追加機能には、対応する組み込み口が必要です。',
  LOCAL_ADDON_STYLE_UNSUPPORTED: 'この CSS には、外部リソースの参照など、この開発モードで使えない記述があります。',
  LOCAL_ADDON_DUPLICATE: '同じフォルダ、または同じ ID のアドオンが登録されています。',
  LOCAL_ADDON_REVIEW_FAILED: 'アドオンを読み込めませんでした。フォルダの設定と CSS の出力を確認してください。',
  LOCAL_ADDON_CHANGED: '登録時と異なる種類または ID のため、最後に適用した版を維持しています。',
  LOCAL_ADDON_BOUNDARY: 'フォルダの参照先が変わったため、最後に適用した版を維持しています。',
  LOCAL_ADDON_INCOMPLETE: 'CSS の出力を確認できないため、最後に適用した版を維持しています。'
} : {
  LOCAL_ADDON_RUNTIME_UNSUPPORTED: 'These scripts or startup hooks need a compatible editor integration.',
  LOCAL_ADDON_STYLE_UNSUPPORTED: 'This CSS contains external resources or syntax outside this development profile.',
  LOCAL_ADDON_DUPLICATE: 'This folder or add-on ID is already registered.',
  LOCAL_ADDON_REVIEW_FAILED: 'Could not load the add-on. Check the folder configuration and CSS output.',
  LOCAL_ADDON_CHANGED: 'The add-on ID or kind changed. The last applied version is still active.',
  LOCAL_ADDON_BOUNDARY: 'The folder changed location. The last applied version is still active.',
  LOCAL_ADDON_INCOMPLETE: 'The CSS output could not be verified. The last applied version is still active.'
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
    try { await action(); }
    catch (error) { setProblem(String(error.message).match(/LOCAL_ADDON_[A-Z_]+/u)?.[0] ?? 'LOCAL_ADDON_REVIEW_FAILED'); }
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
  />;
}

import React from 'react';
import Modal from 'scratch-gui/src/components/modal/modal.jsx';
import {parseExtensionMetadata} from '@kubohiroya/turbowarp-extension-security-dialog';
import {ExtensionRow} from '@kubohiroya/turbowarp-extension-security-dialog/react';
import reviewStyles from '@kubohiroya/turbowarp-extension-security-dialog/project-review.css';
import styles from './desktop-settings-menu.css';

const messages = locale => locale.startsWith('ja') ? {
  title: '拡張ブロックの開発フォルダ',
  intro: 'チェックしたフォルダの完成ビルドを、この作品に自動で反映します。チェックを外すと、最後に読み込んだ版で動作を続けます。',
  folder: '開発フォルダ', add: '開発フォルダを追加…', remove: '一覧から外す', close: '閉じる',
  addSource: 'TypeScript ソースを自動ビルドするフォルダを追加…',
  sourceMode: 'Desktop でソースを自動ビルド', cancelAdd: '追加をキャンセル',
  empty: '開発フォルダが登録されていません。',
  applied: '適用中のビルド', runtimeError: '拡張ブロックの実行エラー', waiting: '整合性を確認できる完成ビルドを待っています。'
} : {
  title: 'Extension Development Folders',
  intro: 'Checked folders update this project automatically after a completed build. Uncheck a folder to keep running its last loaded build.',
  folder: 'Development folder', add: 'Add Development Folder…', remove: 'Remove from list', close: 'Close',
  addSource: 'Add Folder and Build TypeScript Automatically…',
  sourceMode: 'Desktop builds source automatically', cancelAdd: 'Cancel Adding Folder',
  empty: 'No development folders are registered.',
  applied: 'Active build', runtimeError: 'Extension block runtime error', waiting: 'Waiting for a complete and verified build.'
};

const addonMessages = locale => locale.startsWith('ja') ? {
  title: 'エディタアドオンの開発フォルダ',
  intro: 'チェックを入れたフォルダの新しいビルドを読み込みます。再読み込みが必要な変更は一覧に表示します。',
  startup: 'エディターの起動時に反映', pending: '作品を保存してからエディターを再読み込みすると反映されます。',
  applied: '適用中のビルド',
  formats: {turbowarp: 'TurboWarp 形式', plus: 'Plus Editor 追加機能パッケージ'}
} : {
  title: 'Editor Add-on Development Folders',
  intro: 'New builds are loaded from checked folders. The list shows changes that require reloading the editor.',
  startup: 'Applied on editor startup', pending: 'Save your project and reload the editor to apply this change.',
  applied: 'Active build',
  formats: {turbowarp: 'TurboWarp format', plus: 'Plus Editor add-on package'}
};

function DevelopmentRow ({session, locale, text, errorText, onToggle, onRemove, renderSettings}) {
  const {name, description, descriptions, author, license, version} = session.metadata ?? parseExtensionMetadata(session.sourceHeader);
  const {diagnostic} = session;
  return <ExtensionRow
    metadata={{name, description, descriptions, author, license, version}}
    ids={[session.id]}
    locale={locale}
    previewCache={null}
    pick={{checked: session.enabled, disabled: session.busy || Boolean(session.unavailable) || session.removing, onToggle: () => onToggle(session.token, !session.enabled)}}
    details={<div className={styles.developmentPath}>
      {session.mode === 'source' && <span>{text.sourceMode}</span>}
      {session.format && <span>{text.formats[session.format]}</span>}
      <strong>{text.folder}</strong>
      <code>{session.directory}</code>
      {session.activation === 'startup' && <span>{text.startup}</span>}
      {session.appliedDigest && <span>{text.applied} <code title={session.appliedDigest}>{session.appliedDigest.slice(0, 12)}</code></span>}
      {session.reloadRequired && <span role="status">{text.pending}</span>}
      {session.enabled && session.waiting && <span role="status">{text.waiting}</span>}
    </div>}
  >
    {session.buildError && <p className="twextsec-failed" role="status">{errorText(session.buildError)}</p>}
    {session.error && <p className="twextsec-failed" role="alert">{errorText(session.error)}</p>}
    {diagnostic && <p className="twextsec-failed" role="status">
      {text.runtimeError} <code>{`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`}</code>
    </p>}
    {renderSettings?.(session)}
    <div className="twextsec-actions">
      <button type="button" onClick={() => onRemove(session.token)} disabled={session.busy || session.removing}>{text.remove}</button>
    </div>
  </ExtensionRow>;
}

export function LocalExtensionDevelopmentDialog ({locale, sessions, error, errorText, adding, onClose, onAdd, onCancelAdd, sourceBuild, onToggle, onRemove, kind, renderSettings}) {
  const text = {...messages(locale), ...(kind === 'addon' && addonMessages(locale))};
  return <Modal contentLabel={text.title} className={reviewStyles.frame} onRequestClose={onClose}>
    <div className={`${reviewStyles.body} ${styles.developmentBody}`}>
      <div className={`twextsec-review ${styles.developmentReview}`}>
        <div className={styles.developmentRows}>
          <p className="twextsec-intro">{text.intro}</p>
          {error && <p className="twextsec-failed" role="alert">{error}</p>}
          {sessions.length === 0 ? <p>{text.empty}</p> : <ul className="twextsec-rows">
            {sessions.map(session => <DevelopmentRow key={session.token} {...{session, locale, text, errorText, onToggle, onRemove, renderSettings}} />)}
          </ul>}
        </div>
        <div className={`twextsec-actions ${styles.developmentActions}`}>
          <button type="button" onClick={() => onAdd('artifact')} disabled={adding}>{text.add}</button>
          {sourceBuild && <button type="button" onClick={() => onAdd('source')} disabled={adding}>{text.addSource}</button>}
          {adding && onCancelAdd && <button type="button" onClick={onCancelAdd}>{text.cancelAdd}</button>}
          <button type="button" onClick={onClose} disabled={adding}>{text.close}</button>
        </div>
      </div>
    </div>
  </Modal>;
}

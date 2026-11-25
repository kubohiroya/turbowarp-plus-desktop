import React from 'react';
import {connect} from 'react-redux';
import PropTypes from 'prop-types';
import {
  openLoadingProject,
  closeLoadingProject,
  openInvalidProjectModal
} from 'scratch-gui/src/reducers/modals';
import {
  requestProjectUpload,
  setProjectId,
  defaultProjectId,
  onFetchedProjectData,
  onLoadedProject,
  requestNewProject
} from 'scratch-gui/src/reducers/project-state';
import {
  setFileHandle,
  setUsername,
  setProjectError
} from 'scratch-gui/src/reducers/tw';
import {WrappedFileHandle} from './filesystem-api.js';
import {setStrings} from '../prompt/prompt.js';
import {startEditorAddonRuntime} from './editor-addon-startup.js';
import {DesktopSettingsMenuContext} from './desktop-settings-menu-context.js';
import {connectLocalExtensionDevelopment} from './local-extension-development.js';

// The locale provider remounts DesktopHOC within the same editor window.
let mountedOnce = false;
let projectTitle = '';

/**
 * @param {string} filename
 * @returns {string}
 */
const getDefaultProjectTitle = (filename) => {
  const match = filename.match(/([^/\\]+)\.sb[2|3]?$/);
  if (!match) return filename;
  return match[1];
};

const handleClickAddonSettings = (search) => {
  EditorPreload.openAddonSettings(typeof search === 'string' ? search : null);
};

const handleClickNewWindow = () => {
  EditorPreload.openNewWindow();
};

const handleClickPackager = () => {
  EditorPreload.openPackager();
};

const handleClickDesktopSettings = () => {
  EditorPreload.openDesktopSettings();
};

const handleClickPrivacy = () => {
  EditorPreload.openPrivacy();
};

const handleClickAbout = () => {
  EditorPreload.openAbout();
};

const handleClickSourceCode = () => {
  window.open('https://github.com/TurboWarp');
};

const securityManager = {
  // Everything not specified here falls back to the scratch-gui security manager

  // Managed by Electron main process:
  canReadClipboard: () => true,
  canNotify: () => true,

  // Does not work in Electron:
  canGeolocate: () => false
};

const USERNAME_KEY = 'tw:username';
const DEFAULT_USERNAME = 'player';

const developmentText = (locale) => locale.startsWith('ja') ? {
  menu: 'デスクトップメニュー',
  folders: '拡張ブロックの開発フォルダ…',
  LOCAL_EXTENSION_SOURCE_FAILED: '標準 TypeScript ビルドに失敗しました。テンプレートの設定とソースを確認してください。',
  LOCAL_EXTENSION_SOURCE_TIMEOUT: 'ソースビルドが制限時間を超えました。',
  LOCAL_EXTENSION_SOURCE_LIMIT: 'ソースまたはビルド成果物が容量の上限を超えました。',
  LOCAL_EXTENSION_SOURCE_BUSY: 'ほかのフォルダをビルド中です。完了後にもう一度追加してください。',
  LOCAL_EXTENSION_SOURCE_UNAVAILABLE: 'この環境では隔離ソースビルドを開始できません。',
  LOCAL_EXTENSION_ALREADY_WATCHING: 'このフォルダ、または同じ拡張ブロック ID のフォルダは監視中です。',
  LOCAL_EXTENSION_BUILD_REQUIRED: '開発フォルダに拡張ブロックの完成ビルドがありません。テンプレートでビルドしてから開いてください。',
  LOCAL_EXTENSION_CONFLICT: '作品の同じ ID の拡張ブロックは別のビルドです。開発フォルダの監視を停止しました。',
  LOCAL_EXTENSION_INCOMPATIBLE: '拡張ブロックの ID またはブロック定義が変わったため、前のビルドを維持しています。',
  LOCAL_EXTENSION_BOUNDARY: '開発フォルダまたは成果物の参照先が変わったため、監視を停止しました。',
  LOCAL_EXTENSION_APPLY_FAILED: '新しいビルドを反映できませんでした。前のビルドを維持しています。',
  PROJECT_RECOVERY_REQUIRED: '拡張ブロックの更新後に作品を復旧できませんでした。監視を停止しました。',
  LOCAL_EXTENSION_UNAVAILABLE: 'このEditorでは拡張ブロックの開発フォルダを開けません。'
} : {
  menu: 'Desktop menu', folders: 'Extension Development Folders…',
  LOCAL_EXTENSION_SOURCE_FAILED: 'The standard TypeScript build failed. Check the template settings and source.',
  LOCAL_EXTENSION_SOURCE_TIMEOUT: 'The source build exceeded its time limit.',
  LOCAL_EXTENSION_SOURCE_LIMIT: 'The source or build outputs exceeded the size limit.',
  LOCAL_EXTENSION_SOURCE_BUSY: 'Other folders are building. Try adding this folder again when they finish.',
  LOCAL_EXTENSION_SOURCE_UNAVAILABLE: 'An isolated source build could not start in this environment.',
  LOCAL_EXTENSION_ALREADY_WATCHING: 'This folder, or a folder with the same extension ID, is already being watched.',
  LOCAL_EXTENSION_BUILD_REQUIRED: 'Build the extension with the template before opening the development folder.',
  LOCAL_EXTENSION_CONFLICT: 'The project already uses a different build of this extension. Watching stopped.',
  LOCAL_EXTENSION_INCOMPATIBLE: 'The extension ID or block interface changed. The previous build is still active.',
  LOCAL_EXTENSION_BOUNDARY: 'The development folder or an artifact changed location. Watching stopped.',
  LOCAL_EXTENSION_APPLY_FAILED: 'The new build could not be applied. The previous build is still active.',
  PROJECT_RECOVERY_REQUIRED: 'The project could not be restored after the update. Watching stopped.',
  LOCAL_EXTENSION_UNAVAILABLE: 'Extension development folders are unavailable in this editor.'
};

const DesktopHOC = function (WrappedComponent) {
  class DesktopComponent extends React.Component {
    constructor (props) {
      super(props);
      this.state = {
        title: projectTitle,
        developmentSessions: [],
        developmentError: null
      };
      this.handleUpdateProjectTitle = this.handleUpdateProjectTitle.bind(this);
      this.handleRuntimeDisposed = this.handleRuntimeDisposed.bind(this);

      // Changing locale always re-mounts this component
      const stateFromMain = EditorPreload.setLocale(this.props.locale);
      this.messages = stateFromMain.strings;
      setStrings({
        ok: this.messages['prompt.ok'],
        cancel: this.messages['prompt.cancel']
      });

      const storedUsername = localStorage.getItem(USERNAME_KEY);
      if (typeof storedUsername === 'string') {
        this.props.onSetReduxUsername(storedUsername);
      } else {
        this.props.onSetReduxUsername(DEFAULT_USERNAME);
      }
    }
    componentDidMount () {
      const addonsReady = startEditorAddonRuntime(this.props.vm, EditorPreload.localEditorAddons);
      if (EditorPreload.localExtensions) {
        const text = developmentText(this.props.locale);
        this.localExtensions = connectLocalExtensionDevelopment(this.props.vm, EditorPreload.localExtensions,
          code => this.setState({developmentError: text[code] ?? text.LOCAL_EXTENSION_UNAVAILABLE}),
          developmentSessions => this.setState({developmentSessions}));
      }
      EditorPreload.setExportForPackager(() => this.props.vm.saveProjectSb3('arraybuffer')
        .then((buffer) => ({
          name: this.state.title,
          data: buffer
        })));

      this.props.vm.runtime.on('RUNTIME_DISPOSED', this.handleRuntimeDisposed);

      // This component is re-mounted when the locale changes, but we only want to load
      // the initial project once.
      if (mountedOnce) {
        return;
      }
      mountedOnce = true;

      this.props.onLoadingStarted();
      (async () => {
        await addonsReady;
        // Note that 0 is a valid ID and does mean there is a file open
        const id = await EditorPreload.getInitialFile();
        if (id === null) {
          this.props.onHasInitialProject(false, this.props.loadingState);
          this.props.onLoadingCompleted();
          return;
        }

        this.props.onHasInitialProject(true, this.props.loadingState);
        const {name, type, data} = await EditorPreload.getFile(id);

        await this.props.vm.loadProject(data);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, true);

        const title = getDefaultProjectTitle(name);
        if (title) {
          this.handleUpdateProjectTitle(title);
        }

        if (type === 'file' && name.endsWith('.sb3')) {
          this.props.onSetFileHandle(new WrappedFileHandle(id, name));
        }
      })().catch(error => {
        console.error(error);

        this.props.onShowErrorModal(error);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, false);
        this.props.onHasInitialProject(false, this.props.loadingState);
        this.props.onRequestNewProject();
      });
    }
    componentDidUpdate (prevProps, prevState) {
      if (this.props.projectChanged !== prevProps.projectChanged) {
        EditorPreload.setChanged(this.props.projectChanged);
      }

      if (this.state.title !== prevState.title) {
        document.title = this.state.title;
      }

      if (this.props.fileHandle !== prevProps.fileHandle) {
        if (this.props.fileHandle) {
          EditorPreload.openedFile(this.props.fileHandle.id);
        } else {
          EditorPreload.closedFile();
        }
      }

      if (this.props.reduxUsername !== prevProps.reduxUsername) {
        localStorage.setItem(USERNAME_KEY, this.props.reduxUsername);
      }

      if (this.props.isFullScreen !== prevProps.isFullScreen) {
        EditorPreload.setIsFullScreen(this.props.isFullScreen);
      }
    }
    componentWillUnmount () {
      this.localExtensions?.dispose();
      this.props.vm.runtime.off('RUNTIME_DISPOSED', this.handleRuntimeDisposed);
    }
    handleRuntimeDisposed () {
      EditorPreload.dropPermissions();
    }
    handleUpdateProjectTitle (newTitle) {
      projectTitle = newTitle;
      this.setState({
        title: newTitle
      });
    }
    render() {
      const {
        locale,
        loadingState,
        projectChanged,
        fileHandle,
        reduxUsername,
        onFetchedInitialProjectData,
        onHasInitialProject,
        onLoadedProject,
        onLoadingCompleted,
        onLoadingStarted,
        onRequestNewProject,
        onSetFileHandle,
        onSetReduxUsername,
        onShowErrorModal,
        vm,
        ...props
      } = this.props;
      const development = developmentText(locale);
      const aboutItems = [
        {title: this.messages['in-app-about.desktop-settings'], onClick: handleClickDesktopSettings},
        {title: this.messages['in-app-about.privacy'], onClick: handleClickPrivacy},
        {title: this.messages['in-app-about.about'], onClick: handleClickAbout},
        {title: this.messages['in-app-about.source-code'], onClick: handleClickSourceCode}
      ];
      const menu = EditorPreload.localExtensions ? {
        label: development.menu,
        foldersLabel: development.folders,
        development: {
          locale,
          sessions: this.state.developmentSessions,
          error: this.state.developmentError,
          errorText: code => development[code],
          sourceBuild: EditorPreload.localExtensions.sourceBuild,
          onCancelAdd: () => this.localExtensions?.cancelStart(),
          onAdd: mode => {
            this.setState({developmentError: null});
            return this.localExtensions?.start(mode);
          },
          onToggle: (token, enabled) => this.localExtensions?.setEnabled(token, enabled),
          onRemove: token => this.localExtensions?.stop(token)
        }
      } : null;
      return (
        <DesktopSettingsMenuContext.Provider value={menu}>
          <WrappedComponent
            projectTitle={this.state.title}
            onUpdateProjectTitle={this.handleUpdateProjectTitle}
            onClickAddonSettings={handleClickAddonSettings}
            onClickNewWindow={handleClickNewWindow}
            onClickPackager={handleClickPackager}
            onClickAbout={menu ? undefined : aboutItems}
            onClickDesktopSettings={handleClickDesktopSettings}
            securityManager={securityManager}
            {...props}
          />
        </DesktopSettingsMenuContext.Provider>
      );
    }
  }

  DesktopComponent.propTypes = {
    locale: PropTypes.string.isRequired,
    loadingState: PropTypes.string.isRequired,
    projectChanged: PropTypes.bool.isRequired,
    fileHandle: PropTypes.shape({
      id: PropTypes.string.isRequired
    }),
    isFullScreen: PropTypes.bool.isRequired,
    reduxUsername: PropTypes.string.isRequired,
    onFetchedInitialProjectData: PropTypes.func.isRequired,
    onHasInitialProject: PropTypes.func.isRequired,
    onLoadedProject: PropTypes.func.isRequired,
    onLoadingCompleted: PropTypes.func.isRequired,
    onLoadingStarted: PropTypes.func.isRequired,
    onRequestNewProject: PropTypes.func.isRequired,
    onSetFileHandle: PropTypes.func.isRequired,
    onSetReduxUsername: PropTypes.func.isRequired,
    onShowErrorModal: PropTypes.func.isRequired,
    vm: PropTypes.shape({
      loadProject: PropTypes.func.isRequired,
      runtime: PropTypes.shape({
        on: PropTypes.func.isRequired,
        off: PropTypes.func.isRequired
      }).isRequired
    }).isRequired
  };

  const mapStateToProps = state => ({
    locale: state.locales.locale,
    loadingState: state.scratchGui.projectState.loadingState,
    isFullScreen: state.scratchGui.mode.isFullScreen,
    projectChanged: state.scratchGui.projectChanged,
    fileHandle: state.scratchGui.tw.fileHandle,
    reduxUsername: state.scratchGui.tw.username,
    vm: state.scratchGui.vm
  });

  const mapDispatchToProps = dispatch => ({
    onLoadingStarted: () => dispatch(openLoadingProject()),
    onLoadingCompleted: () => dispatch(closeLoadingProject()),
    onHasInitialProject: (hasInitialProject, loadingState) => {
      if (hasInitialProject) {
        return dispatch(requestProjectUpload(loadingState));
      }
      return dispatch(setProjectId(defaultProjectId));
    },
    onFetchedInitialProjectData: (projectData, loadingState) => dispatch(onFetchedProjectData(projectData, loadingState)),
    onLoadedProject: (loadingState, loadSuccess) => {
      return dispatch(onLoadedProject(loadingState, /* canSave */ false, loadSuccess));
    },
    onRequestNewProject: () => dispatch(requestNewProject(false)),
    onSetFileHandle: fileHandle => dispatch(setFileHandle(fileHandle)),
    onSetReduxUsername: username => dispatch(setUsername(username)),
    onShowErrorModal: error => {
      dispatch(setProjectError(error));
      dispatch(openInvalidProjectModal());
    }
  });

  return connect(
    mapStateToProps,
    mapDispatchToProps
  )(DesktopComponent);
};

export default DesktopHOC;

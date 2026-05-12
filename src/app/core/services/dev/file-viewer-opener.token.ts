import { InjectionToken } from '@angular/core';

/**
 * Abstraction over "open the File Viewer dialog with these files" so the
 * dev bridge service (Core) doesn't have to import the actual
 * FileViewerDialogComponent (Feature). Implementation is provided at the
 * application level — see app.config.ts.
 *
 * Kept narrow on purpose: the bridge only needs "open with these inputs"
 * and "is one already up?" (to refuse stacking — Monaco mis-mounts on
 * the second instance and shows blank).
 */
export interface FileViewerOpenRequest {
    files: Map<string, string>;
    initialFile: string;
    openAgentPanelOnInit?: boolean;
}

export interface FileViewerOpenResult {
    alreadyOpen: boolean;
}

export interface FileViewerOpener {
    isOpen(): boolean;
    open(request: FileViewerOpenRequest): FileViewerOpenResult;
}

export const FILE_VIEWER_OPENER = new InjectionToken<FileViewerOpener>('FILE_VIEWER_OPENER');

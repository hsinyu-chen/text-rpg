import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { I18nService } from '@app/core/i18n';
import { AgentHintRegistry } from './agent-hints.registry';
import { GameStateService } from '@app/core/services/game-state.service';
import { FILE_VIEWER_OPENER } from '@app/core/services/dev/file-viewer-opener.token';
import { AgentMessageJumperService } from './agent-message-jumper.service';
import type { HintAction } from './agent-hints.types';

const SCHEME_PREFIX = 'app://';

/**
 * Parses `app://...` URLs from agent-console markdown and dispatches.
 * Three schemes:
 *   - `app://hint/<path>[?do=focus|activate]`
 *   - `app://message/<id>[/<action>]`
 *   - `app://file/<filename>`
 *
 * The optional `<action>` segment on `message/` names a toolbar button
 * on that specific chat message (e.g. `auto-update`, `fork`); when
 * present the chat view spotlights that button instead of flashing the
 * whole bubble.
 *
 * Caller (agent-console click handler) does:
 *   if (interceptor.dispatch(href)) event.preventDefault();
 *
 * Returns true when the href was claimed by one of our schemes (whether or
 * not the target existed); false when it's an ordinary URL the caller
 * should let the browser handle.
 */
@Injectable({ providedIn: 'root' })
export class AgentLinkInterceptor {
  private readonly registry = inject(AgentHintRegistry);
  private readonly state = inject(GameStateService);
  private readonly fileViewerOpener = inject(FILE_VIEWER_OPENER);
  private readonly jumper = inject(AgentMessageJumperService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18nService);

  dispatch(url: string): boolean {
    if (!url.startsWith(SCHEME_PREFIX)) return false;
    const rest = url.slice(SCHEME_PREFIX.length);
    const queryIdx = rest.indexOf('?');
    const pathPart = queryIdx >= 0 ? rest.slice(0, queryIdx) : rest;
    const query = queryIdx >= 0 ? rest.slice(queryIdx + 1) : '';
    const segments = pathPart.split('/').filter(s => s.length > 0);
    if (segments.length < 2) {
      this.toast('agentHint.toast.invalidUrl', { url });
      return true;
    }
    const scheme = segments[0];
    const tail = segments.slice(1);

    switch (scheme) {
      case 'hint': {
        // Decode each segment individually rather than joining first: a path
        // segment that itself contains an encoded `/` (e.g. `%2F`) would
        // collapse into the path delimiter if we decoded after the join.
        // file/message schemes use the same encoding contract.
        const path = tail.map(s => decodeURIComponent(s)).join('/');
        const action = this.parseAction(query);
        this.registry.openTarget(path, action);
        return true;
      }
      case 'message': {
        if (tail.length < 1 || tail.length > 2) {
          this.toast('agentHint.toast.messageIdRequired', { url });
          return true;
        }
        const id = decodeURIComponent(tail[0]);
        const action = tail.length === 2 ? decodeURIComponent(tail[1]) : null;
        this.jumper.jumpTo(id, action);
        return true;
      }
      case 'file': {
        const filename = decodeURIComponent(tail.join('/'));
        const files = this.state.loadedFiles();
        if (!files.has(filename)) {
          this.toast('agentHint.toast.fileNotFound', { filename });
          return true;
        }
        this.fileViewerOpener.open({
          files: new Map(files),
          initialFile: filename,
        });
        return true;
      }
      default:
        this.toast('agentHint.toast.unknownScheme', { scheme });
        return true;
    }
  }

  private toast(key: string, params: Record<string, string | number>): void {
    this.snackBar.open(
      this.i18n.translate(key, params),
      this.i18n.translate('ui.CLOSE'),
      { duration: 3000 }
    );
  }

  private parseAction(query: string): HintAction {
    if (!query) return 'highlight';
    const params = new URLSearchParams(query);
    const action = params.get('do');
    if (action === 'focus' || action === 'activate') return action;
    return 'highlight';
  }
}

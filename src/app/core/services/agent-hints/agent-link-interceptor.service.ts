import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatSnackBar } from '@angular/material/snack-bar';
import { I18nService } from '@app/core/i18n';
import { AgentHintRegistry } from './agent-hints.registry';
import { GameStateService } from '@app/core/services/game-state.service';
import { FILE_VIEWER_OPENER } from '@app/core/services/dev/file-viewer-opener.token';
import { AgentMessageJumperService } from './agent-message-jumper.service';
import type { HintAction } from './agent-hints.types';

const SCHEME_PREFIX = 'app://';

// Manifest child id (chat-message/<x>) → list of `data-msg-action` names on
// the actual buttons. Multiple names allowed because some toolbar buttons
// flip their action attribute by state (toggle-ref-only renders as either
// `mark-ref-only` or `include-in-story` depending on the current flag).
// Keep aligned with chat-message.component.html.
const CHAT_MESSAGE_HINT_TO_ACTION: Record<string, readonly string[]> = {
  'edit-resend': ['edit-resend'],
  'fork-from-here': ['fork'],
  'delete-all-following': ['delete-following'],
  'delete-message': ['delete'],
  'toggle-ref-only': ['mark-ref-only', 'include-in-story'],
  'auto-update-files': ['auto-update'],
  'copy-json-pair': ['copy-json'],
  'toggle-raw-render': ['toggle-raw'],
  'edit-text': ['edit-text'],
};

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
  private readonly doc = inject(DOCUMENT);

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

    // decodeURIComponent throws URIError on malformed `%`-sequences (e.g.
    // `%` not followed by two hex chars). The agent emits these URLs from
    // markdown, so any garbled link reaches us as input — wrap the whole
    // dispatch path once instead of guarding each call site.
    try {
      switch (scheme) {
        case 'hint': {
          // Decode each segment individually rather than joining first: a
          // path segment that itself contains an encoded `/` (e.g. `%2F`)
          // would collapse into the path delimiter if we decoded after
          // the join. file/message schemes use the same encoding contract.
          const segs = tail.map(s => decodeURIComponent(s));
          // chat-message paths are class-level (no ElementRef) — they describe
          // an action that applies to "some" chat message. The agent sometimes
          // emits these without picking a specific id; redirect to the last
          // message bearing the matching toolbar button so the user gets a
          // working spotlight instead of a dead "find it here" toast.
          if (segs[0] === 'chat-message') {
            this.dispatchChatMessageHint(segs.slice(1));
            return true;
          }
          const path = segs.join('/');
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
    } catch (e) {
      if (e instanceof URIError) {
        this.toast('agentHint.toast.invalidUrl', { url });
        return true;
      }
      throw e;
    }
  }

  private toast(key: string, params: Record<string, string | number>): void {
    this.snackBar.open(
      this.i18n.translate(key, params),
      this.i18n.translate('ui.CLOSE'),
      { duration: 3000 }
    );
  }

  /**
   * Fallback for `app://hint/chat-message[/<sub>]` — the agent named a
   * per-message action without picking a specific message id. Find the most
   * recent message whose toolbar bears the matching button, then route via
   * the message jumper so the existing spotlight flow lights it up. Falls
   * back to flashing the last message when no action matches.
   */
  private dispatchChatMessageHint(rest: string[]): void {
    const lastId = this.lastMessageId();
    if (!lastId) {
      this.toast('agentHint.toast.noMessages', {});
      return;
    }
    if (rest.length === 0) {
      this.jumper.jumpTo(lastId, null);
      return;
    }
    const hintId = rest[0];
    const candidates = CHAT_MESSAGE_HINT_TO_ACTION[hintId];
    if (!candidates) {
      // Unknown sub-id under chat-message — flash the last message so the
      // user still gets feedback rather than a silent no-op.
      this.jumper.jumpTo(lastId, null);
      return;
    }
    const match = this.findLastMessageWithAction(candidates);
    if (match) {
      this.jumper.jumpTo(match.messageId, match.action);
      return;
    }
    // No message currently has the button (e.g. `auto-update-files` but no
    // save-block message exists). Flash the last message; chat.component's
    // missing-button fallback also degrades to message flash, so behavior
    // is consistent.
    this.jumper.jumpTo(lastId, null);
  }

  private lastMessageId(): string | null {
    const msgs = this.state.messages();
    return msgs.length ? msgs[msgs.length - 1].id : null;
  }

  private findLastMessageWithAction(actions: readonly string[]): { messageId: string; action: string } | null {
    const selector = actions.map(a => `[data-msg-action="${CSS.escape(a)}"]`).join(',');
    const buttons = this.doc.querySelectorAll<HTMLElement>(selector);
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      const msgEl = btn.closest<HTMLElement>('[id^="message-"]');
      if (!msgEl) continue;
      return {
        messageId: msgEl.id.slice('message-'.length),
        action: btn.getAttribute('data-msg-action') ?? actions[0],
      };
    }
    return null;
  }

  private parseAction(query: string): HintAction {
    if (!query) return 'highlight';
    const params = new URLSearchParams(query);
    const action = params.get('do');
    if (action === 'focus' || action === 'activate') return action;
    return 'highlight';
  }
}

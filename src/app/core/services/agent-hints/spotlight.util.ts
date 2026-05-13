/**
 * Dim the rest of the page so a small target stands out as a bright "hole".
 *
 * A transparent div is anchored to the target's bbox; its enormous outset
 * box-shadow (from `.agent-hint-spotlight` in styles.scss) paints
 * everything else semi-opaque black, leaving the target unmasked.
 * `popover="manual"` puts the host in the browser top-layer so the
 * shadow ranks alongside cdk-overlay dialogs / the agent panel — without
 * it the spotlight would render behind them.
 *
 * Shared by AgentHintRegistry (UI-feature deep links) and chat.component
 * (message toolbar deep links).
 */

export const SPOTLIGHT_HOLD_MS = 2100;
const SPOTLIGHT_PADDING_PX = 6;

export function spotlightElement(doc: Document, el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const host = doc.createElement('div');
  host.className = 'agent-hint-spotlight';
  host.setAttribute('popover', 'manual');
  host.style.cssText = `
    position: fixed;
    top: ${rect.top - SPOTLIGHT_PADDING_PX}px;
    left: ${rect.left - SPOTLIGHT_PADDING_PX}px;
    width: ${rect.width + SPOTLIGHT_PADDING_PX * 2}px;
    height: ${rect.height + SPOTLIGHT_PADDING_PX * 2}px;
  `;
  doc.body.appendChild(host);
  try { host.showPopover(); } catch { /* unsupported */ }
  setTimeout(() => {
    if (host.matches(':popover-open')) {
      try { host.hidePopover(); } catch { /* race */ }
    }
    host.remove();
  }, SPOTLIGHT_HOLD_MS);
}

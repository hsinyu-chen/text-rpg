/**
 * Pure prompt builder for the "regenerate save" flow in the auto-update dialog.
 *
 * Composes a save-intent prompt that lists matched (skip) and failed (retry)
 * hunks so the model can produce a corrected save block. Decoupled from the
 * dialog so the formatting can be unit-tested without spinning up Angular.
 */

export interface RegenerateSaveLocale {
  intentTags: { SAVE: string };
  engineStrings: {
    REGENERATE_SAVE_PROMPT: string;
    REGEN_SUCCESS_LABEL: string;
    REGEN_FILE_LABEL: string;
    REGEN_ERROR_LABEL: string;
    REGEN_SUCCESS_TITLE: string;
    REGEN_FAILED_TITLE: string;
  };
}

export interface RegenerateSaveHunk {
  filePath: string;
  context?: string;
  targetContent?: string;
  status?: { exists?: boolean; matched?: boolean };
}

export interface RegenerateSaveGroup {
  updates: readonly RegenerateSaveHunk[];
}

export function buildRegenerateSavePrompt(
  groups: readonly RegenerateSaveGroup[],
  locale: RegenerateSaveLocale,
): string {
  const matchedItems: string[] = [];
  const failedItems: string[] = [];

  for (const group of groups) {
    for (const update of group.updates) {
      if (!update.status?.exists) continue;

      if (update.status.matched) {
        matchedItems.push(`- ${locale.engineStrings.REGEN_SUCCESS_LABEL} ${update.filePath} (${update.context || 'root'})`);
      } else {
        const targetPreview = update.targetContent
          ? update.targetContent.substring(0, 500)
          : '(append mode)';
        failedItems.push(
          `- ${locale.engineStrings.REGEN_FILE_LABEL} ${update.filePath} (${update.context || 'root'})\n` +
          `  ${locale.engineStrings.REGEN_ERROR_LABEL}\n  """\n  ${targetPreview}\n  """`,
        );
      }
    }
  }

  let message = `${locale.intentTags.SAVE}${locale.engineStrings.REGENERATE_SAVE_PROMPT}\n\n`;
  if (matchedItems.length > 0) {
    message += `${locale.engineStrings.REGEN_SUCCESS_TITLE}\n${matchedItems.join('\n')}\n\n`;
  }
  if (failedItems.length > 0) {
    message += `${locale.engineStrings.REGEN_FAILED_TITLE}\n${failedItems.join('\n\n')}`;
  }
  return message;
}

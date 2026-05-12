/**
 * PRH UK <body> purity validator (P3/PR1).
 *
 * Per Technical Guide §6.1, the `<body>` element MUST NOT carry any
 * of the following ARIA attributes:
 *   - role
 *   - aria-label
 *   - aria-labelledby
 *
 * PRH's reasoning: reading systems differ in how they treat ARIA on
 * the body element, so PRH suppresses the variation by banning it
 * entirely. Roles + labels belong on inner sections instead.
 *
 * Issue code: PRH-BODY-HAS-ARIA (one per offending file).
 *
 * Detect-only. Auto-fix (strip the attribute) lands in P5.
 *
 * Implementation note: Ninja's existing `addAriaLandmarks` remediator
 * has historically been able to write `role="main"` on `<body>`. When
 * we add the auto-fix in P5, that remediator needs a safety guard so
 * it never targets <body> on a PRH-UK build. Until then, this
 * validator will fire on remediated output — which is correct, because
 * the remediator itself is non-conformant for PRH.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/** Attributes banned on <body> per PRH spec. */
const BANNED_BODY_ATTRS = ['role', 'aria-label', 'aria-labelledby'] as const;

export function validatePrhBodyPurity(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    const bodyOpenMatch = file.content.match(/<body\b([^>]*)>/i);
    if (!bodyOpenMatch) continue;
    const bodyAttrs = bodyOpenMatch[1];

    const offenders: string[] = [];
    for (const attr of BANNED_BODY_ATTRS) {
      // Match the attribute only when preceded by start-of-string or
      // whitespace. `\b` alone would false-match inside `data-role` /
      // `data-aria-label` because the boundary lands between `-` and
      // `r`. Requiring a whitespace anchor is stricter and tighter to
      // how HTML attributes actually serialise.
      const re = new RegExp(`(?:^|\\s)${attr}\\s*=`, 'i');
      if (re.test(bodyAttrs)) {
        offenders.push(attr);
      }
    }
    if (offenders.length === 0) continue;

    issues.push(buildIssue(
      file.path,
      `<body> in ${file.path} carries forbidden attribute(s): ${offenders.join(', ')}. PRH explicitly prohibits ARIA on the body element.`,
      `Remove ${offenders.join(' / ')} from <body>. If you need a landmark role, move it to an inner <section> or <main>.`,
    ));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildIssue(location: string, message: string, suggestion: string): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-BODY-HAS-ARIA'];
  return {
    code: 'PRH-BODY-HAS-ARIA',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${message}`,
    suggestion,
    location,
  };
}

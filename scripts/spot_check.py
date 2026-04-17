#!/usr/bin/env python3
"""
Spot-check script for annotation quality verification (Phase 3, Stage 3A).

Verifies whether an annotator's labels are trustworthy by having a second
annotator independently review a random sample of pages, then comparing
the two sets of labels at YOLO-class level.

Usage:
  python scripts/spot_check.py list
  python scripts/spot_check.py pick    --run-id <id> [--pages 30] [--seed 42] [--output plan.json]
  python scripts/spot_check.py reset   --plan plan.json
  python scripts/spot_check.py compare --plan plan.json
  python scripts/spot_check.py restore --plan plan.json

Environment:
  DATABASE_URL  PostgreSQL connection string (required)
                Uses .env file in project root if present.

Workflow:
  1. `list`    — show calibration runs and their zone counts (find the run ID)
  2. `pick`    — select random pages, snapshot baseline labels to a plan file
  3. `reset`   — clear operator decisions on those pages (makes them "unreviewed")
  4. (annotator reviews the pages in the Bootstrap Console)
  5. `compare` — compare new labels against baseline, output pass/fail verdict
  6. `restore` — (optional) undo the reset if needed, restoring original labels
"""

import argparse
import json
import os
import random
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 is required. Install with: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# YOLO label normalisation — same mapping used in training-export-service
# ---------------------------------------------------------------------------
LABEL_TO_YOLO = {
    'paragraph': 'paragraph', 'p': 'paragraph',
    'section-header': 'section-header',
    'h1': 'section-header', 'h2': 'section-header', 'h3': 'section-header',
    'h4': 'section-header', 'h5': 'section-header', 'h6': 'section-header',
    'table': 'table', 'tbl': 'table',
    'figure': 'figure', 'fig': 'figure',
    'caption': 'caption', 'cap': 'caption',
    'footnote': 'footnote', 'fn': 'footnote',
    'header': 'header', 'hdr': 'header',
    'footer': 'footer', 'ftr': 'footer',
    'list-item': 'list-item', 'li': 'list-item',
    'toci': 'toci',
    'formula': 'formula',
}

PASS_THRESHOLD = 85.0  # agreement % required to pass spot-check


def load_env():
    """Load DATABASE_URL from .env file if not already set."""
    if os.environ.get('DATABASE_URL'):
        return
    env_path = Path(__file__).resolve().parent.parent / '.env'
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith('DATABASE_URL='):
                    os.environ['DATABASE_URL'] = line.split('=', 1)[1]
                    return


def get_connection():
    load_env()
    url = os.environ.get('DATABASE_URL')
    if not url:
        print("ERROR: DATABASE_URL environment variable is required.", file=sys.stderr)
        print("Set it directly or add it to the .env file in the project root.", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def normalize_label(label):
    """Normalise a zone label to its YOLO class name. Returns None if unmapped."""
    if not label:
        return None
    return LABEL_TO_YOLO.get(label.strip().lower())


# ---------------------------------------------------------------------------
# list — show calibration runs
# ---------------------------------------------------------------------------
def cmd_list(args):
    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute('''
        SELECT
            cr."id",
            cd."filename" AS doc_title,
            cr."runDate",
            cr."greenCount",
            cr."amberCount",
            cr."redCount",
            (SELECT COUNT(*) FROM "Zone" z WHERE z."calibrationRunId" = cr."id") AS total_zones,
            (SELECT COUNT(*) FROM "Zone" z WHERE z."calibrationRunId" = cr."id" AND z."operatorLabel" IS NOT NULL) AS labeled_zones
        FROM "CalibrationRun" cr
        JOIN "CorpusDocument" cd ON cd."id" = cr."documentId"
        WHERE cr."isArchived" = false
        ORDER BY cr."runDate" DESC
    ''')

    rows = cur.fetchall()
    if not rows:
        print("No calibration runs found.")
        cur.close()
        conn.close()
        return

    print(f"{'Run ID':<28} {'Title':<40} {'Zones':>7} {'Labeled':>8} {'Green':>6} {'Amber':>6} {'Red':>6}")
    print("-" * 110)
    for r in rows:
        print(f"{r['id']:<28} {(r['doc_title'] or '?')[:39]:<40} {r['total_zones']:>7} {r['labeled_zones']:>8} "
              f"{r['greenCount'] or 0:>6} {r['amberCount'] or 0:>6} {r['redCount'] or 0:>6}")

    cur.close()
    conn.close()


# ---------------------------------------------------------------------------
# pick — select random pages and snapshot baseline
# ---------------------------------------------------------------------------
def cmd_pick(args):
    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Verify the run exists
    cur.execute('SELECT "id" FROM "CalibrationRun" WHERE "id" = %s', (args.run_id,))
    if not cur.fetchone():
        print(f"ERROR: CalibrationRun '{args.run_id}' not found.", file=sys.stderr)
        cur.close()
        conn.close()
        sys.exit(1)

    # Find all page numbers that have at least one human-labeled zone
    cur.execute('''
        SELECT DISTINCT "pageNumber"
        FROM "Zone"
        WHERE "calibrationRunId" = %s
          AND "operatorLabel" IS NOT NULL
        ORDER BY "pageNumber"
    ''', (args.run_id,))

    annotated_pages = [row['pageNumber'] for row in cur.fetchall()]

    if not annotated_pages:
        print("ERROR: No annotated pages found for this run.", file=sys.stderr)
        cur.close()
        conn.close()
        sys.exit(1)

    # Select random sample
    if args.seed is not None:
        random.seed(args.seed)

    n = min(args.pages, len(annotated_pages))
    if n < args.pages:
        print(f"WARNING: Only {len(annotated_pages)} annotated pages available, using all of them.")
    selected_pages = sorted(random.sample(annotated_pages, n))

    print(f"Selected {len(selected_pages)} pages from {len(annotated_pages)} annotated pages")
    print(f"Pages: {selected_pages}")

    # Snapshot all zones on selected pages
    cur.execute('''
        SELECT "id", "pageNumber", "operatorLabel", "decision",
               "verifiedAt", "verifiedBy", "operatorVerified",
               "type", "reconciliationBucket",
               "aiLabel", "aiConfidence"
        FROM "Zone"
        WHERE "calibrationRunId" = %s
          AND "pageNumber" = ANY(%s)
        ORDER BY "pageNumber", "id"
    ''', (args.run_id, selected_pages))

    zones = []
    for row in cur.fetchall():
        zones.append({
            'id': row['id'],
            'pageNumber': row['pageNumber'],
            'operatorLabel': row['operatorLabel'],
            'decision': row['decision'],
            'verifiedAt': row['verifiedAt'].isoformat() if row['verifiedAt'] else None,
            'verifiedBy': row['verifiedBy'],
            'operatorVerified': row['operatorVerified'],
            'type': row['type'],
            'reconciliationBucket': row['reconciliationBucket'],
            'aiLabel': row['aiLabel'],
            'aiConfidence': float(row['aiConfidence']) if row['aiConfidence'] is not None else None,
        })

    labeled_count = sum(1 for z in zones if z['operatorLabel'])

    plan = {
        'version': 1,
        'runId': args.run_id,
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'seed': args.seed,
        'selectedPages': selected_pages,
        'totalAnnotatedPages': len(annotated_pages),
        'totalZonesOnPages': len(zones),
        'labeledZonesOnPages': labeled_count,
        'baseline': zones,
        'status': 'picked',
    }

    output = args.output or f"spot-check-{args.run_id[:8]}.json"
    with open(output, 'w') as f:
        json.dump(plan, f, indent=2)

    print(f"\nPlan saved to: {output}")
    print(f"Total zones on selected pages: {len(zones)}")
    print(f"Zones with operator labels:    {labeled_count}")
    print(f"Zones without operator labels:  {len(zones) - labeled_count}")
    print(f"\nNext step: python scripts/spot_check.py reset --plan {output}")

    cur.close()
    conn.close()


# ---------------------------------------------------------------------------
# reset — clear operator decisions on spot-check pages
# ---------------------------------------------------------------------------
def cmd_reset(args):
    with open(args.plan) as f:
        plan = json.load(f)

    if plan['status'] != 'picked':
        print(f"ERROR: Plan status is '{plan['status']}', expected 'picked'.", file=sys.stderr)
        if plan['status'] == 'reset':
            print("Reset has already been applied. Use 'compare' after the second annotator reviews.", file=sys.stderr)
        sys.exit(1)

    run_id = plan['runId']
    pages = plan['selectedPages']
    labeled_count = plan['labeledZonesOnPages']

    print(f"Run ID:       {run_id}")
    print(f"Pages:        {pages}")
    print(f"Zones to reset: {labeled_count}")
    print()
    print("This will clear operatorLabel, decision, verifiedAt, and verifiedBy")
    print("on all zones for the selected pages. The baseline is preserved in the plan file.")

    confirm = input("\nType 'yes' to proceed: ")
    if confirm.strip().lower() != 'yes':
        print("Aborted.")
        return

    conn = get_connection()
    cur = conn.cursor()

    cur.execute('''
        UPDATE "Zone"
        SET "operatorLabel" = NULL,
            "decision" = NULL,
            "verifiedAt" = NULL,
            "verifiedBy" = NULL,
            "operatorVerified" = false
        WHERE "calibrationRunId" = %s
          AND "pageNumber" = ANY(%s)
          AND "operatorLabel" IS NOT NULL
    ''', (run_id, pages))

    affected = cur.rowcount
    conn.commit()

    plan['status'] = 'reset'
    plan['resetAt'] = datetime.now(timezone.utc).isoformat()
    plan['zonesReset'] = affected

    with open(args.plan, 'w') as f:
        json.dump(plan, f, indent=2)

    print(f"\nReset {affected} zones on {len(pages)} pages.")
    print(f"Plan updated: {args.plan}")
    print()
    print("Next steps:")
    print(f"  1. Assign a DIFFERENT annotator to review pages: {pages}")
    print(f"  2. After they finish, run: python scripts/spot_check.py compare --plan {args.plan}")
    print(f"  3. If something goes wrong:  python scripts/spot_check.py restore --plan {args.plan}")

    cur.close()
    conn.close()


# ---------------------------------------------------------------------------
# compare — compare new annotations against baseline
# ---------------------------------------------------------------------------
def cmd_compare(args):
    with open(args.plan) as f:
        plan = json.load(f)

    if plan['status'] not in ('reset', 'compared'):
        print(f"ERROR: Plan status is '{plan['status']}', expected 'reset'.", file=sys.stderr)
        sys.exit(1)

    run_id = plan['runId']
    pages = plan['selectedPages']
    baseline_by_id = {z['id']: z for z in plan['baseline']}

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Get current state of zones on the spot-check pages
    cur.execute('''
        SELECT "id", "pageNumber", "operatorLabel", "decision"
        FROM "Zone"
        WHERE "calibrationRunId" = %s
          AND "pageNumber" = ANY(%s)
        ORDER BY "pageNumber", "id"
    ''', (run_id, pages))

    current_by_id = {row['id']: dict(row) for row in cur.fetchall()}

    cur.close()
    conn.close()

    # --- Compare zone by zone ---
    agreements = 0
    disagreements = 0
    not_reviewed = 0  # second annotator hasn't touched this zone
    no_original = 0   # zone had no original label (nothing to compare)
    details = []

    for zone_id, old in baseline_by_id.items():
        old_label = old.get('operatorLabel')
        old_decision = old.get('decision')

        # Zone had no original label — skip (nothing to compare)
        if not old_label:
            no_original += 1
            continue

        new = current_by_id.get(zone_id)
        if not new:
            not_reviewed += 1
            continue

        new_label = new.get('operatorLabel')
        new_decision = new.get('decision')

        # Second annotator hasn't reviewed this zone yet
        if not new_label and new_decision is None:
            not_reviewed += 1
            continue

        # --- Both REJECTED ---
        if old_decision == 'REJECTED' and new_decision == 'REJECTED':
            agreements += 1
            continue

        # --- One REJECTED, one not ---
        if (old_decision == 'REJECTED') != (new_decision == 'REJECTED'):
            disagreements += 1
            details.append({
                'zoneId': zone_id,
                'pageNumber': old['pageNumber'],
                'type': old.get('type'),
                'bucket': old.get('reconciliationBucket'),
                'original': 'REJECTED' if old_decision == 'REJECTED' else old_label,
                'spotCheck': 'REJECTED' if new_decision == 'REJECTED' else new_label,
                'originalYolo': 'REJECTED' if old_decision == 'REJECTED' else normalize_label(old_label),
                'spotCheckYolo': 'REJECTED' if new_decision == 'REJECTED' else normalize_label(new_label),
            })
            continue

        # --- Both have labels — compare at YOLO class level ---
        old_yolo = normalize_label(old_label)
        new_yolo = normalize_label(new_label)

        if old_yolo == new_yolo:
            agreements += 1
        else:
            disagreements += 1
            details.append({
                'zoneId': zone_id,
                'pageNumber': old['pageNumber'],
                'type': old.get('type'),
                'bucket': old.get('reconciliationBucket'),
                'original': old_label,
                'spotCheck': new_label,
                'originalYolo': old_yolo or f'UNMAPPED({old_label})',
                'spotCheckYolo': new_yolo or f'UNMAPPED({new_label})',
            })

    total_compared = agreements + disagreements
    agreement_pct = (agreements / total_compared * 100) if total_compared > 0 else 0
    passed = agreement_pct >= PASS_THRESHOLD

    # --- Breakdowns ---
    pattern_counts = Counter()
    page_disagree_counts = Counter()
    bucket_stats = {'GREEN': [0, 0], 'AMBER': [0, 0], 'RED': [0, 0]}  # [agree, disagree]

    for d in details:
        pattern_counts[f"{d['originalYolo']} -> {d['spotCheckYolo']}"] += 1
        page_disagree_counts[d['pageNumber']] += 1

    # Bucket-level agreement (from all compared zones, not just disagreements)
    for zone_id, old in baseline_by_id.items():
        if not old.get('operatorLabel'):
            continue
        new = current_by_id.get(zone_id, {})
        if not new.get('operatorLabel') and new.get('decision') is None:
            continue
        bucket = old.get('reconciliationBucket', 'RED')
        if bucket not in bucket_stats:
            bucket = 'RED'
        old_decision = old.get('decision')
        new_decision = new.get('decision')

        # Determine if this zone was an agreement
        if old_decision == 'REJECTED' and new_decision == 'REJECTED':
            bucket_stats[bucket][0] += 1
        elif (old_decision == 'REJECTED') != (new_decision == 'REJECTED'):
            bucket_stats[bucket][1] += 1
        else:
            old_yolo = normalize_label(old.get('operatorLabel'))
            new_yolo = normalize_label(new.get('operatorLabel'))
            if old_yolo == new_yolo:
                bucket_stats[bucket][0] += 1
            else:
                bucket_stats[bucket][1] += 1

    # --- Print report ---
    print()
    print("=" * 65)
    print("  SPOT-CHECK COMPARISON REPORT")
    print("=" * 65)
    print(f"  Run ID:             {run_id}")
    print(f"  Pages checked:      {len(pages)}")
    print(f"  Zones compared:     {total_compared}")
    print(f"  Not yet reviewed:   {not_reviewed}")
    print(f"  No original label:  {no_original}")
    print()
    print(f"  Agreements:         {agreements}")
    print(f"  Disagreements:      {disagreements}")
    print(f"  Agreement rate:     {agreement_pct:.1f}%")
    print(f"  Threshold:          {PASS_THRESHOLD:.0f}%")
    print()

    if passed:
        print(f"  VERDICT:  PASS")
    else:
        print(f"  VERDICT:  FAIL")
    print()

    if not_reviewed > 0:
        reviewed_pct = total_compared / (total_compared + not_reviewed) * 100
        print(f"  WARNING: {not_reviewed} zones were not reviewed by the second annotator.")
        print(f"           Coverage: {reviewed_pct:.0f}% of labeled zones.")
        if reviewed_pct < 80:
            print(f"           Coverage is below 80% — results may not be representative.")
            print(f"           Ask the second annotator to finish the remaining pages.")
        print()

    # Agreement by reconciliation bucket
    print("-" * 65)
    print("  AGREEMENT BY RECONCILIATION BUCKET")
    print("-" * 65)
    for bucket in ('GREEN', 'AMBER', 'RED'):
        a, d = bucket_stats[bucket]
        total = a + d
        if total > 0:
            pct = a / total * 100
            print(f"  {bucket:>6}: {a:>5} agree / {d:>3} disagree = {pct:.1f}%  (n={total})")
        else:
            print(f"  {bucket:>6}: no zones compared")
    print()

    if disagreements > 0:
        # Disagreement patterns
        print("-" * 65)
        print("  DISAGREEMENT PATTERNS  (original -> spot-check)")
        print("-" * 65)
        for pattern, count in pattern_counts.most_common(15):
            print(f"    {pattern}: {count}")
        print()

        # Pages with most disagreements
        print("-" * 65)
        print("  PAGES WITH MOST DISAGREEMENTS")
        print("-" * 65)
        for pg, count in page_disagree_counts.most_common(10):
            print(f"    Page {pg}: {count} disagreement(s)")
        print()

    # --- Save results to plan ---
    plan['status'] = 'compared'
    plan['comparedAt'] = datetime.now(timezone.utc).isoformat()
    plan['result'] = {
        'zonesCompared': total_compared,
        'notReviewed': not_reviewed,
        'noOriginalLabel': no_original,
        'agreements': agreements,
        'disagreements': disagreements,
        'agreementPct': round(agreement_pct, 1),
        'passed': passed,
        'threshold': PASS_THRESHOLD,
        'bucketAgreement': {
            b: {'agree': s[0], 'disagree': s[1],
                'pct': round(s[0] / (s[0] + s[1]) * 100, 1) if (s[0] + s[1]) > 0 else None}
            for b, s in bucket_stats.items()
        },
        'disagreementPatterns': dict(pattern_counts),
        'disagreementDetails': details,
    }

    with open(args.plan, 'w') as f:
        json.dump(plan, f, indent=2)

    print(f"Results saved to: {args.plan}")
    print()

    if passed:
        print("Title PASSED spot-check. The second annotator's labels are kept.")
        print("Proceed to complete the remaining pages of this title (Stage 3B).")
    else:
        print("Title FAILED spot-check. The original annotation is unreliable.")
        print("Options:")
        print(f"  1. Reset the ENTIRE title for re-annotation (Stage 3C)")
        print(f"  2. Restore original labels first: python scripts/spot_check.py restore --plan {args.plan}")


# ---------------------------------------------------------------------------
# restore — undo the reset by writing back original labels
# ---------------------------------------------------------------------------
def cmd_restore(args):
    with open(args.plan) as f:
        plan = json.load(f)

    if plan['status'] not in ('reset', 'compared'):
        print(f"ERROR: Plan status is '{plan['status']}' — nothing to restore.", file=sys.stderr)
        if plan['status'] == 'picked':
            print("Reset has not been applied yet.", file=sys.stderr)
        elif plan['status'] == 'restored':
            print("Labels have already been restored.", file=sys.stderr)
        sys.exit(1)

    zones_to_restore = [z for z in plan['baseline'] if z['operatorLabel']]

    print(f"Run ID:            {plan['runId']}")
    print(f"Pages:             {plan['selectedPages']}")
    print(f"Zones to restore:  {len(zones_to_restore)}")
    print()
    print("This will overwrite current labels with the original baseline labels.")

    confirm = input("\nType 'yes' to proceed: ")
    if confirm.strip().lower() != 'yes':
        print("Aborted.")
        return

    conn = get_connection()
    cur = conn.cursor()

    restored = 0
    for z in zones_to_restore:
        # Parse the ISO datetime string back for PostgreSQL
        verified_at = z['verifiedAt'] if z['verifiedAt'] else None

        cur.execute('''
            UPDATE "Zone"
            SET "operatorLabel" = %s,
                "decision" = %s,
                "verifiedAt" = %s,
                "verifiedBy" = %s,
                "operatorVerified" = %s
            WHERE "id" = %s
        ''', (
            z['operatorLabel'],
            z['decision'],
            verified_at,
            z['verifiedBy'],
            z.get('operatorVerified', True),
            z['id'],
        ))
        restored += cur.rowcount

    conn.commit()

    plan['status'] = 'restored'
    plan['restoredAt'] = datetime.now(timezone.utc).isoformat()
    plan['zonesRestored'] = restored

    with open(args.plan, 'w') as f:
        json.dump(plan, f, indent=2)

    print(f"\nRestored {restored} zones to their original labels.")
    print(f"Plan updated: {args.plan}")

    cur.close()
    conn.close()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='Spot-check annotation quality for YOLO training data',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # 1. Find the calibration run ID
  python scripts/spot_check.py list

  # 2. Pick 30 random annotated pages and save baseline
  python scripts/spot_check.py pick --run-id cmnjmhlp --pages 30

  # 3. Reset those pages so the second annotator sees them as unreviewed
  python scripts/spot_check.py reset --plan spot-check-cmnjmhlp.json

  # 4. (second annotator reviews in Bootstrap Console)

  # 5. Compare new labels against baseline
  python scripts/spot_check.py compare --plan spot-check-cmnjmhlp.json

  # 6. If needed, restore original labels
  python scripts/spot_check.py restore --plan spot-check-cmnjmhlp.json
""")

    sub = parser.add_subparsers(dest='command')
    sub.required = True

    # list
    sub.add_parser('list', help='Show calibration runs and their zone counts')

    # pick
    pick_p = sub.add_parser('pick', help='Select random pages and snapshot baseline labels')
    pick_p.add_argument('--run-id', required=True, help='CalibrationRun ID (from "list" command)')
    pick_p.add_argument('--pages', type=int, default=30, help='Number of pages to spot-check (default: 30)')
    pick_p.add_argument('--seed', type=int, default=None, help='Random seed for reproducibility')
    pick_p.add_argument('--output', help='Output plan file path (default: spot-check-<runid>.json)')

    # reset
    reset_p = sub.add_parser('reset', help='Reset operator decisions on spot-check pages')
    reset_p.add_argument('--plan', required=True, help='Plan file from pick command')

    # compare
    comp_p = sub.add_parser('compare', help='Compare new annotations against baseline')
    comp_p.add_argument('--plan', required=True, help='Plan file from pick/reset step')

    # restore
    rest_p = sub.add_parser('restore', help='Restore original labels from baseline (undo reset)')
    rest_p.add_argument('--plan', required=True, help='Plan file from pick/reset step')

    args = parser.parse_args()

    commands = {
        'list': cmd_list,
        'pick': cmd_pick,
        'reset': cmd_reset,
        'compare': cmd_compare,
        'restore': cmd_restore,
    }
    commands[args.command](args)


if __name__ == '__main__':
    main()

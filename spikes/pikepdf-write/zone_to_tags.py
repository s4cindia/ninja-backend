"""Core mapping: Ninja zone type -> PDF tag role."""

ROLE_MAP = {
    'paragraph':      '/P',
    'section-header': '/H',
    'table':          '/Table',
    'figure':         '/Figure',
    'caption':        '/Caption',
    'footnote':       '/Note',
    'header':         '/Artifact',
    'footer':         '/Artifact',
}


def get_pdf_role(zone_type: str) -> str:
    """Map Ninja canonical zone type to PDF structure role."""
    return ROLE_MAP.get(zone_type, '/P')


def is_artifact(zone_type: str) -> bool:
    """Returns True if the zone should be marked as artifact
    (not included in tag tree)."""
    return zone_type in ('header', 'footer')


def get_heading_level(zone: dict) -> int:
    """Extract heading level for section-header zones.
    Returns 1-6. Defaults to 1 if not specified."""
    return min(max(int(zone.get('headingLevel', 1)), 1), 6)
